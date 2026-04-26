/**
 * atlas_commit — the primary mechanism for organic Atlas enrichment.
 *
 * This is the cornerstone of the heuristic-only Atlas model. Instead of a
 * cold LLM extraction pass that pre-computes semantic fields for every file,
 * atlas_commit captures knowledge from the agent that actually worked on the
 * code — the one with maximum context because it just wrote or reviewed it.
 *
 * How organic growth works:
 * 1. Atlas starts with heuristic-only data (AST symbols, edges, clusters, cross-refs)
 * 2. Semantic fields (purpose, blurb, patterns, hazards, etc.) begin empty
 * 3. As agents work with files, they call atlas_commit after review PASS
 * 4. Each commit merges the agent's knowledge into the Atlas record
 * 5. The most-touched files accumulate the richest metadata — exactly the right priority
 *
 * The result: a living knowledge base that grows organically from real work,
 * not a pre-computed snapshot that decays the moment it's generated.
 *
 * This tool enforces a single path: every call must include at least one
 * inline atlas_files field (purpose, patterns, hazards, etc.). No background
 * reextract enqueue fallback is used here.
 */

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { atlasCommitInputSchema, normalizeAtlasCommitPayload } from './commitPayload.js';
import {
  getAtlasFile,
  insertAtlasChangelog,
  upsertFileRecord,
} from '../db.js';
import { appendLocalAtlasCommitArtifact } from '../../persistence/localAtlasCommitArtifacts.js';
import {
  refreshAtlasChangelogEmbedding,
  refreshAtlasFileEmbedding,
  refreshAtlasSourceChunkEmbeddings,
} from '../embeddings.js';
import {
  computeCompleteness,
  type CompletenessScore,
} from '../completenessScore.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function computeCurrentFileHash(filePath: string, sourceRoot: string): string | null {
  try {
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(sourceRoot, filePath);
    // Hash raw bytes so binary artifacts such as SQLite snapshots match the
    // push-gate verifier and do not throw on large non-text files.
    return createHash('sha1').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return null;
  }
}

function shouldRefreshSourceChunkEmbeddings(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() !== '.sqlite';
}

/**
 * Auto-capture the latest git commit SHA that touched a specific file.
 * Falls back to HEAD if file-specific lookup fails, returns null if not in a git repo.
 */
function resolveCommitSha(filePath: string, sourceRoot: string): string | null {
  try {
    // Get the latest commit that touched this specific file
    const sha = execSync(`git log -1 --format=%H -- ${JSON.stringify(filePath)}`, {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (sha && /^[0-9a-f]{40}$/.test(sha)) return sha;

    // Fallback: just use HEAD
    const head = execSync('git rev-parse HEAD', {
      cwd: sourceRoot,
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : null;
  } catch {
    return null;
  }
}

// ── Atlas Commit File Claims ─────────────────────────────────────────────────
// In-memory lock map preventing concurrent atlas_commit writes to the same file.
// When 10 agents are enriching the atlas in parallel, two can race on the same
// file — both read the existing record, both merge, second write stomps first.
// This lock serializes writes per file_path with a TTL for crash safety.

interface AtlasFileClaim {
  holder: string;       // author_instance_id or fallback identifier
  workspace: string;
  claimedAt: number;    // Date.now()
}

const ATLAS_CLAIM_TTL_MS = 30_000; // 30 seconds — enough for a commit, short enough to recover from crashes
const atlasFileClaims = new Map<string, AtlasFileClaim>();

function claimKey(workspace: string, filePath: string): string {
  return `${workspace}::${filePath}`;
}

function tryAcquireAtlasClaim(workspace: string, filePath: string, holder: string): { acquired: true } | { acquired: false; holder: string; secondsRemaining: number } {
  const key = claimKey(workspace, filePath);
  const existing = atlasFileClaims.get(key);
  const now = Date.now();

  if (existing) {
    const elapsed = now - existing.claimedAt;
    if (elapsed < ATLAS_CLAIM_TTL_MS && existing.holder !== holder) {
      return {
        acquired: false,
        holder: existing.holder,
        secondsRemaining: Math.ceil((ATLAS_CLAIM_TTL_MS - elapsed) / 1000),
      };
    }
    // Expired or same holder — reclaim
  }

  atlasFileClaims.set(key, { holder, workspace, claimedAt: now });
  return { acquired: true };
}

function releaseAtlasClaim(workspace: string, filePath: string, holder: string): void {
  const key = claimKey(workspace, filePath);
  const existing = atlasFileClaims.get(key);
  if (existing && existing.holder === holder) {
    atlasFileClaims.delete(key);
  }
}

// Periodic cleanup of expired claims (prevents memory leak on long-running servers)
setInterval(() => {
  const now = Date.now();
  for (const [key, claim] of atlasFileClaims) {
    if (now - claim.claimedAt > ATLAS_CLAIM_TTL_MS) {
      atlasFileClaims.delete(key);
    }
  }
}, 60_000);

// ── Idempotency-Key Collapse ─────────────────────────────────────────────────
// Problem: when an agent fumbles the parameter format, the MCP tool rejects
// the call with an error. The agent retries with a corrected payload — but the
// semantic meaning of the commit (same file, same changelog) is unchanged.
// Without idempotency protection, a 4-retry spiral creates 4 changelog rows
// with nearly-identical summaries, polluting the history.
//
// Fix: compute a fingerprint from (workspace, file_path, summary, file_hash)
// and remember the changelog row we created for it for a short window. If the
// same fingerprint arrives again within the window, we skip the DB insert and
// return the original entry. This is the primary defense against duplicate
// pollution and also cheap insurance against future retry loops we haven't
// anticipated.
//
// The window must be short — we want two legitimately distinct commits with
// the same summary (e.g. rapid iterative edits) to both land. 30s matches the
// claim TTL and is roughly the time window where retries happen in practice.

interface IdempotencyHit {
  entryId: number;
  insertedAt: number;
  fileHash: string | null;
}

const IDEMPOTENCY_TTL_MS = 30_000;
const idempotencyCache = new Map<string, IdempotencyHit>();

function computeIdempotencyKey(
  workspace: string,
  filePath: string,
  summary: string,
  fileHash: string | null,
): string {
  const payload = `${workspace}\u0000${filePath}\u0000${summary}\u0000${fileHash ?? 'no-hash'}`;
  return createHash('sha1').update(payload).digest('hex');
}

function checkIdempotency(key: string): IdempotencyHit | null {
  const existing = idempotencyCache.get(key);
  if (!existing) return null;
  const elapsed = Date.now() - existing.insertedAt;
  if (elapsed > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }
  return existing;
}

function recordIdempotency(key: string, entryId: number, fileHash: string | null): void {
  idempotencyCache.set(key, { entryId, insertedAt: Date.now(), fileHash });
}

// Periodic cleanup mirrors the claim cleaner; keeps the cache bounded.
setInterval(() => {
  const now = Date.now();
  for (const [key, hit] of idempotencyCache) {
    if (now - hit.insertedAt > IDEMPOTENCY_TTL_MS) {
      idempotencyCache.delete(key);
    }
  }
}, 60_000);

// ── Tool Registration ────────────────────────────────────────────────────────

export function registerCommitTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_commit',
    [
      'The primary mechanism for enriching Atlas records with semantic understanding.',
      'Atlas indexes start with heuristic-only data (AST symbols, structural edges, cross-references, clusters). Semantic fields begin empty — waiting for YOU to fill them in.',
      'When you see empty fields in an atlas_query lookup, that is your cue: you have the context to fill them. Call atlas_commit after review PASS and before releasing file ownership.',
      '',
      '## REQUIRED FIELDS (every call must include all three)',
      '',
      '**`changelog_entry`** (required, min 10 chars) — What you CHANGED and why. Your edit log. Temporal.',
      '  Example: "Added routing branch for clinical_insights sectionTarget alongside existing discharge and generic targets."',
      '',
      '**`purpose`** (required, 30-600 chars) — Timeless 1-2 sentence description of what this file does and why it exists. Will still be true next year.',
      '  Example: "Routes incoming generation jobs to the correct processor based on document type and section target."',
      '',
      '**`blurb`** (required, 20-280 chars) — Tweet-length file identity. Used in compact neighbor listings and search results.',
      '  Example: "Job generation router dispatching to section-specific processors"',
      '',
      '## CRITICAL: Identity vs. Changelog — Two Separate Things',
      '',
      'changelog_entry is your edit log (TEMPORAL). purpose / blurb / patterns / hazards / conventions / key_types / data_flows / public_api / source_highlights describe the file\'s PERMANENT IDENTITY (TIMELESS). Do NOT mix them up.',
      '',
      '### BAD (changelog text leaking into purpose/blurb):',
      '  - purpose: "Updated to add clinical insights routing" — NO! This is a changelog entry.',
      '  - blurb: "Now exposes submitClinicalInsightsJob()" — NO! "Now" = temporal = changelog.',
      '  - hazards: "Task 3753 investigation confirmed fields already support X" — NO! This is investigation notes.',
      '',
      '### GOOD (timeless identity):',
      '  - purpose: "Routes incoming generation jobs to the correct processor based on document type and section target."',
      '  - blurb: "Job generation router dispatching to section-specific processors"',
      '  - hazards: "Adding a new sectionTarget requires a matching processor import and routing branch"',
      '',
      '## Field Guide — Optional Structural Fields',
      '- **patterns**: Architectural patterns — facade, middleware chain, observer, singleton, builder, registry, etc. Not code style.',
      '- **hazards**: Correctness risks — race conditions, silent failures, mutation traps, ordering dependencies, implicit coupling. Not style nits, TODOs, or investigation notes.',
      '- **conventions**: Project-specific conventions this file follows or establishes — naming schemes, error handling patterns, import ordering, test structure.',
      '- **key_types**: Important type definitions, interfaces, or enums that downstream consumers depend on.',
      '- **data_flows**: How data moves through this file — inputs, transformations, outputs, side effects.',
      '- **public_api**: Exported functions/classes with name, type, optional signature and description.',
      '- **source_highlights**: The 2-5 most important/tricky code sections. Skip boilerplate. Pick the segments a future agent NEEDS to see to understand the file. Can be disjointed — for a 2000-line file, select 3 key segments from different parts. Each has an id (1-indexed), optional label, line range, and content. Changelog entries can reference them ("refer to snippet 5").',
      '',
      'Fill in ANY empty fields you can — not just the ones related to your edit. You have the context right now; a future agent won\'t.',
      'The more agents commit knowledge, the richer the Atlas becomes. The most-touched files accumulate the best metadata — exactly the right priority.',
      '',
      '## Changelog — Built In (No Separate Call Needed)',
      'The `changelog_entry` field IS the changelog. Every call automatically creates a changelog entry from it. Include `patterns_added`, `patterns_removed`, `hazards_added`, `hazards_removed` to record what changed — this is what `atlas_changelog action=query` returns. You do NOT need a separate `atlas_changelog action=log` call.',
    ].join('\n'),
    atlasCommitInputSchema,
    async (rawArgs: Record<string, unknown>) => {
      const {
        file_path,
        changelog_entry,
        summary,
        patterns_added,
        patterns_removed,
        hazards_added,
        hazards_removed,
        cluster,
        breaking_changes,
        commit_sha,
        author_instance_id,
        author_engine,
        author_name,
        review_entry_id,
        purpose,
        public_api,
        conventions,
        key_types,
        data_flows,
        hazards,
        patterns,
        dependencies,
        blurb,
        source_highlights,
        quiet,
      } = normalizeAtlasCommitPayload(rawArgs);

      // changelog_entry is required by Zod; the normalizer mirrors it into
      // summary so legacy DB fields stay populated. Both are guaranteed
      // non-empty by the schema's min(10) constraint.
      const resolvedSummary = summary ?? changelog_entry ?? '';

      // ── Step 0: Acquire atlas file claim ────────────────────────────────
      // Prevents concurrent atlas_commit writes to the same file. When 10
      // agents enrich the atlas in parallel, two can race on the same file —
      // both read the existing record, both merge, second write stomps first.
      const holder = author_instance_id ?? `anon-${Date.now()}`;
      const claimResult = tryAcquireAtlasClaim(runtime.config.workspace, file_path, holder);
      if (!claimResult.acquired) {
        return {
          content: [{
            type: 'text' as const,
            text: [
              `⛔ Atlas file claim conflict: \`${file_path}\` is currently being written by instance \`${claimResult.holder}\`.`,
              `Claim expires in ~${claimResult.secondsRemaining}s. Wait and retry, or pick a different file.`,
              '',
              '💡 To avoid collisions during wide atlas enrichment, partition files by cluster across agents.',
            ].join('\n'),
          }],
        };
      }

      try {
        // ── Step 0.5: Idempotency check ────────────────────────────────────
        // Before writing anything, check if the same (workspace, file_path,
        // summary, file_hash) combo was committed in the last 30s. If so, we
        // treat this as a retry and return the original entry rather than
        // inserting a duplicate row. Primary defense against parameter-fumble
        // retry spirals polluting the changelog history.
        const currentFileHash = computeCurrentFileHash(file_path, runtime.config.sourceRoot);
        const idemKey = computeIdempotencyKey(runtime.config.workspace, file_path, resolvedSummary, currentFileHash);
        const idemHit = checkIdempotency(idemKey);
        if (idemHit) {
          return {
            content: [{
              type: 'text' as const,
              text: `♻️ #${idemHit.entryId} ${file_path} — duplicate suppressed (same summary + file hash within ${Math.round(IDEMPOTENCY_TTL_MS / 1000)}s window). Original commit kept.`,
            }],
          };
        }

        // ── Step 1: Write changelog entry ──────────────────────────────────
        const resolvedSha = commit_sha ?? resolveCommitSha(file_path, runtime.config.sourceRoot);
        const changelogCreatedAt = new Date().toISOString();
        const entry = insertAtlasChangelog(runtime.db, {
          workspace: runtime.config.workspace,
          file_path,
          summary: resolvedSummary,
          patterns_added,
          patterns_removed,
          hazards_added,
          hazards_removed,
          cluster: cluster ?? null,
          breaking_changes,
          commit_sha: resolvedSha,
          author_instance_id: author_instance_id ?? null,
          author_engine: author_engine ?? null,
          author_name: author_name ?? null,
          review_entry_id: review_entry_id ?? null,
          source: 'atlas_commit',
          created_at: changelogCreatedAt,
        });
        recordIdempotency(idemKey, entry.id, currentFileHash);
        appendLocalAtlasCommitArtifact({
          workspace: runtime.config.workspace,
          repo_root: runtime.config.sourceRoot,
          original_changelog_id: entry.id,
          created_at: changelogCreatedAt,
          file_path,
          summary: resolvedSummary,
          patterns_added,
          patterns_removed,
          hazards_added,
          hazards_removed,
          cluster: cluster ?? null,
          breaking_changes: breaking_changes === true,
          commit_sha: resolvedSha,
          author_instance_id: author_instance_id ?? null,
          author_engine: author_engine ?? null,
          author_name: author_name ?? null,
          review_entry_id: review_entry_id ?? null,
          file_hash: currentFileHash,
          payload: {
            file_path,
            changelog_entry,
            summary,
            patterns_added,
            patterns_removed,
            hazards_added,
            hazards_removed,
            cluster,
            breaking_changes,
            commit_sha: resolvedSha ?? undefined,
            author_instance_id,
            author_engine,
            author_name,
            review_entry_id,
            quiet,
            purpose,
            public_api,
            conventions,
            key_types,
            data_flows,
            hazards,
            patterns,
            dependencies,
            blurb,
            source_highlights,
          },
        });

        // ── Step 2: Inline atlas_files update (required) ───────────────────
        // Read existing record to merge with — we only overwrite fields the
        // agent explicitly provided, preserving everything else.
        const existing = getAtlasFile(runtime.db, runtime.config.workspace, file_path);

        const mergedPurpose = purpose ?? existing?.purpose ?? '';
        const mergedBlurb = blurb ?? existing?.blurb ?? '';
        const mergedPatterns = patterns ?? existing?.patterns ?? [];
        const mergedHazards = hazards ?? existing?.hazards ?? [];
        const mergedConventions = conventions ?? existing?.conventions ?? [];
        const mergedPublicApi = public_api ?? existing?.public_api ?? [];
        const mergedExports = public_api
          ? public_api.map((a) => ({ name: a.name, type: a.type }))
          : existing?.exports ?? [];
        const mergedKeyTypes = key_types ?? existing?.key_types ?? [];
        const mergedDataFlows = data_flows ?? existing?.data_flows ?? [];
        const mergedDependencies = dependencies ?? existing?.dependencies ?? {};
        const mergedSourceHighlights = source_highlights ?? existing?.source_highlights ?? [];

        upsertFileRecord(runtime.db, {
          workspace: runtime.config.workspace,
          file_path,
          file_hash: currentFileHash ?? existing?.file_hash ?? null,
          cluster: cluster ?? existing?.cluster ?? null,
          loc: existing?.loc ?? 0,
          blurb: mergedBlurb,
          purpose: mergedPurpose,
          public_api: mergedPublicApi,
          exports: mergedExports,
          patterns: mergedPatterns,
          dependencies: mergedDependencies,
          data_flows: mergedDataFlows,
          key_types: mergedKeyTypes,
          hazards: mergedHazards,
          conventions: mergedConventions,
          cross_refs: existing?.cross_refs ?? null,
          source_highlights: mergedSourceHighlights,
          language: existing?.language ?? 'typescript',
          extraction_model: `${author_engine ?? 'agent'}/atlas_commit`,
          last_extracted: new Date().toISOString(),
        });

        const refreshedFile = getAtlasFile(runtime.db, runtime.config.workspace, file_path);
        if (refreshedFile) {
          try {
            await refreshAtlasFileEmbedding(
              runtime.db,
              runtime.config.workspace,
              refreshedFile,
              runtime.config,
            );
          } catch (err) {
            console.warn(
              `[atlas_commit] file embedding refresh failed for ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          if (shouldRefreshSourceChunkEmbeddings(file_path)) {
            try {
              await refreshAtlasSourceChunkEmbeddings(
                runtime.db,
                runtime.config.workspace,
                refreshedFile,
                runtime.config.sourceRoot,
                runtime.config,
              );
            } catch (err) {
              console.warn(
                `[atlas_commit] source chunk embedding refresh failed for ${file_path}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
        try {
          await refreshAtlasChangelogEmbedding(runtime.db, entry, runtime.config);
        } catch (err) {
          console.warn(
            `[atlas_commit] changelog embedding refresh failed for #${entry.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── Step 3: Tier-aware coverage audit ─────────────────────────────
        // A flat 9-field coverage rate punishes 30-line config files and lets
        // 2K-line subsystems coast on blurb+purpose. computeCompleteness
        // classifies the file by LOC and returns a tier-relative required-set
        // so the response surfaces what's *actually* expected of this file.
        const filledFieldSet = new Set<string>();
        if (mergedPurpose && mergedPurpose.trim()) filledFieldSet.add('purpose');
        if (mergedBlurb && mergedBlurb.trim()) filledFieldSet.add('blurb');
        if (mergedPatterns.length > 0) filledFieldSet.add('patterns');
        if (mergedHazards.length > 0) filledFieldSet.add('hazards');
        if (mergedConventions.length > 0) filledFieldSet.add('conventions');
        if (mergedKeyTypes.length > 0) filledFieldSet.add('key_types');
        if (mergedDataFlows.length > 0) filledFieldSet.add('data_flows');
        if (mergedPublicApi.length > 0) filledFieldSet.add('public_api');
        if (mergedSourceHighlights.length > 0) filledFieldSet.add('source_highlights');

        const completeness: CompletenessScore = computeCompleteness(
          existing?.loc ?? 0,
          filledFieldSet,
        );
        const stillEmpty = [
          'purpose', 'blurb', 'patterns', 'hazards', 'conventions',
          'key_types', 'data_flows', 'public_api', 'source_highlights',
        ].filter((f) => !filledFieldSet.has(f));
        const filledCount = completeness.filled.length;
        const totalFields = 9;
        const coveragePct = Math.round(completeness.overallFillRate * 100);
        const requiredPct = Math.round(completeness.requiredFillRate * 100);
        const requiredFilledCount = completeness.required.length - completeness.missingRequired.length;

        // ── Step 4: Build response ─────────────────────────────────────────
        // Quiet mode (default): single compact line saves ~500-1K tokens per commit.
        // Pass quiet=false for verbose feedback with coverage warnings and changelog hints.
        if (quiet !== false) {
          const fieldList = [
            purpose !== undefined && 'purpose',
            blurb !== undefined && 'blurb',
            patterns !== undefined && 'patterns',
            hazards !== undefined && 'hazards',
            conventions !== undefined && 'conventions',
            key_types !== undefined && 'key_types',
            data_flows !== undefined && 'data_flows',
            public_api !== undefined && 'public_api',
            source_highlights !== undefined && 'source_highlights',
            dependencies !== undefined && 'dependencies',
          ].filter(Boolean).join(', ');
          const tierTag = `tier=${completeness.tier}`;
          const reqTag = `req=${requiredFilledCount}/${completeness.required.length} (${requiredPct}%)`;
          const overallTag = `all=${filledCount}/${totalFields} (${coveragePct}%)`;
          const missingReq = completeness.missingRequired.length > 0
            ? ` | missing-req: ${completeness.missingRequired.join(', ')}`
            : '';
          return {
            content: [{
              type: 'text' as const,
              text: `✅ #${entry.id} ${file_path} — ${tierTag} ${reqTag} ${overallTag} [${fieldList}]${missingReq}`,
            }],
          };
        }

        const parts = [
          `Atlas commit #${entry.id} for ${file_path}`,
          `Changelog: ${entry.summary}`,
        ];

        if (entry.patterns_added.length > 0) {
          parts.push(`Patterns added: ${entry.patterns_added.join(', ')}`);
        }
        if (entry.patterns_removed.length > 0) {
          parts.push(`Patterns removed: ${entry.patterns_removed.join(', ')}`);
        }
        if (entry.hazards_added.length > 0) {
          parts.push(`Hazards added: ${entry.hazards_added.join(', ')}`);
        }
        if (entry.hazards_removed.length > 0) {
          parts.push(`Hazards removed: ${entry.hazards_removed.join(', ')}`);
        }
        if (entry.breaking_changes) {
          parts.push('⚠ Breaking changes flagged');
        }

        const fields = [
          purpose !== undefined && 'purpose',
          public_api !== undefined && 'public_api',
          patterns !== undefined && 'patterns',
          hazards !== undefined && 'hazards',
          conventions !== undefined && 'conventions',
          key_types !== undefined && 'key_types',
          data_flows !== undefined && 'data_flows',
          dependencies !== undefined && 'dependencies',
          blurb !== undefined && 'blurb',
          source_highlights !== undefined && `source_highlights (${source_highlights?.length ?? 0} snippets)`,
        ].filter(Boolean);
        parts.push(`Atlas entry updated: ${fields.join(', ')}`);
        parts.push(
          `Tier: ${completeness.tier}${completeness.loc > 0 ? ` (${completeness.loc} LOC)` : ''} — ${completeness.rationale}`,
        );
        parts.push(
          `Required for tier: ${requiredFilledCount}/${completeness.required.length} (${requiredPct}%) — [${completeness.required.join(', ')}]`,
        );
        parts.push(`Overall: ${filledCount}/${totalFields} fields (${coveragePct}%)`);

        const content: Array<{ type: 'text'; text: string }> = [{
          type: 'text' as const,
          text: parts.join('\n'),
        }];

        // Tier-aware coverage warnings — escalating severity
        if (completeness.missingRequired.length > 0) {
          content.push({
            type: 'text' as const,
            text: [
              `⚠️ MISSING REQUIRED FIELDS for ${completeness.tier} tier: ${completeness.missingRequired.join(', ')}`,
              '',
              completeness.rationale,
              'You have the context RIGHT NOW — fill these on this commit or the next one. Future agents depend on it.',
            ].join('\n'),
          });
        } else if (completeness.missingRecommended.length > 0) {
          content.push({
            type: 'text' as const,
            text: `📋 Recommended for ${completeness.tier} tier still empty: ${completeness.missingRecommended.join(', ')} — consider filling these on a follow-up commit.`,
          });
        }

        // Changelog completeness nudge — atlas_commit IS the changelog.
        // When agents skip the changelog fields, the history becomes hollow
        // (just a summary with no patterns/hazards delta). Nudge them to fill
        // in the structured changelog fields so future agents can see exactly
        // what changed at a glance without reading raw diffs.
        const hasChangelogFields = (patterns_added && patterns_added.length > 0)
          || (patterns_removed && patterns_removed.length > 0)
          || (hazards_added && hazards_added.length > 0)
          || (hazards_removed && hazards_removed.length > 0);
        if (!hasChangelogFields) {
          content.push({
            type: 'text' as const,
            text: '📝 Changelog hint: You didn\'t pass patterns_added/removed or hazards_added/removed. atlas_commit IS the changelog — include these fields so `atlas_changelog action=query` shows what patterns/hazards changed. No separate atlas_changelog call needed.',
          });
        }

        content.push({
          type: 'text' as const,
          text: '💡 If you changed exports or public API, run `atlas_admin action=flush files=[...]` to refresh cross-references for downstream consumers.',
        });

        return { content };
      } finally {
        // Always release the claim, even if an error occurs during the write
        releaseAtlasClaim(runtime.config.workspace, file_path, holder);
      }
    },
  );
}
