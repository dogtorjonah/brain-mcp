/**
 * brain_search — Unified cross-silo search tool for brain-mcp.
 *
 * Replaces rebirth_search with a single tool that searches across
 * identity traces, the atlas, transcript history, or all three.
 * Uses per-silo BM25+vector RRF fusion followed by cross-silo RRF.
 *
 * Tool signature:
 *   brain_search({
 *     query: string,
 *     scope?: 'self'|'session'|'workspace'|'identity'|'atlas'|'transcripts'|'all',
 *     silos?: ('transcripts'|'atlas_files'|'atlas_changelog'|'source_highlights')[],
 *     k?: number,
 *     identity?: string,
 *     workspace?: string,
 *     weights?: { bm25: number, vector: number },
 *     candidate_pool?: number,
 *   })
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { fuseCrossSilo, type SiloHit, type CrossSiloHit, type SiloKind } from './crossSiloFusion.js';
import { resolveScope, applySiloFilter, type BrainSearchScope } from './scopeResolver.js';
import {
  appendStar,
  formatStarTimestamp,
  validateCategory,
  safeTruncate,
  STAR_CATEGORIES,
  MAX_AMBIENT_NOTE_CHARS,
  MAX_CATEGORIZED_NOTE_CHARS,
} from '../stars/tapStars.js';

// ── Input schema ───────────────────────────────────────────────────────

const brainSearchSchema = {
  action: z
    .enum(['search', 'star'])
    .optional()
    .describe("'search' (default): run cross-silo search. 'star': pin a cognitive waypoint for rebirth injection."),
  query: z.string().describe('Natural language search query (required for action=search).'),
  note: z
    .string()
    .optional()
    .describe('Note text for action=star. Max 200 chars with category, 120 without.'),
  category: z
    .enum(['decision', 'discovery', 'pivot', 'handoff', 'gotcha', 'result'])
    .optional()
    .describe('Category for action=star. With category: persisted + rebirth-injected. Without: ephemeral ack only.'),
  scope: z
    .enum(['self', 'session', 'workspace', 'identity', 'atlas', 'transcripts', 'all'])
    .optional()
    .describe(
      "Search scope. 'workspace' (default): atlas + transcripts for cwd repo. " +
      "'all': everything. 'atlas': code knowledge only. 'transcripts': history only. " +
      "'self': current identity's traces. 'session': current session only. " +
      "'identity': named identity across repos.",
    ),
  silos: z
    .array(z.enum(['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights']))
    .optional()
    .describe('Override which silos to search. Default: all silos for the chosen scope.'),
  k: z.number().int().positive().optional().describe('Max results. Default 20.'),
  identity: z.string().optional().describe('Identity name for scope=identity. Defaults to current identity.'),
  workspace: z.string().optional().describe('Workspace/repo to search. Defaults to cwd.'),
  weights: z
    .object({ bm25: z.number(), vector: z.number() })
    .optional()
    .describe('RRF weight overrides. Default { bm25: 1, vector: 1 }.'),
  candidate_pool: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('How deep each retriever digs before fusion. Default 50.'),
};

// ── Response formatting ────────────────────────────────────────────────

function formatHit(hit: CrossSiloHit, index: number): string {
  const p = hit.payload;
  const lines: string[] = [];

  // Header with silo badge
  const siloTag = hit.silo === 'transcripts' ? '📝'
    : hit.silo === 'atlas_files' ? '📁'
    : hit.silo === 'atlas_changelog' ? '📋'
    : '✨';
  const scoreStr = hit.score.toFixed(3);

  switch (hit.silo) {
    case 'transcripts': {
      const ts = p.timestamp_ms ? new Date(p.timestamp_ms as number).toISOString().slice(0, 16) : '';
      const kind = p.kind ?? '';
      const tool = p.tool_name ? `tool:${p.tool_name}` : '';
      const paths = (p.file_paths as string[])?.length
        ? ` ${(p.file_paths as string[]).slice(0, 3).join(', ')}`
        : '';
      lines.push(`${siloTag} [${hit.silo}] (${scoreStr}) ${kind} ${tool}${paths} ${ts}`);
      if (p.text) lines.push(`  ${(p.text as string).slice(0, 200)}`);
      break;
    }
    case 'atlas_files': {
      const fp = p.file_path ?? '';
      const purpose = p.purpose ?? p.blurb ?? '';
      lines.push(`${siloTag} [${hit.silo}] (${scoreStr}) ${fp} — ${purpose}`);
      if (p.matched_chunk) {
        const mc = p.matched_chunk as { content: string; kind: string; label?: string; start_line: number; end_line: number };
        const preview = mc.content.split('\n')[0]?.slice(0, 100) ?? '';
        lines.push(`  match: ${mc.kind}${mc.label ? ` (${mc.label})` : ''} lines ${mc.start_line}-${mc.end_line} — ${preview}`);
      }
      break;
    }
    case 'atlas_changelog': {
      const fp = p.file_path ?? '';
      const summary = p.summary ?? '';
      const author = p.author_name ? ` by ${p.author_name}` : '';
      lines.push(`${siloTag} [${hit.silo}] (${scoreStr}) ${fp}${author} — ${summary}`);
      break;
    }
    case 'source_highlights': {
      const fp = p.file_path ?? '';
      const mc = p.matched_chunk as { content: string; label?: string; start_line: number; end_line: number } | undefined;
      const label = mc?.label ?? 'highlight';
      lines.push(`${siloTag} [${hit.silo}] (${scoreStr}) ${fp} — ${label} lines ${mc?.start_line}-${mc?.end_line}`);
      if (mc) lines.push(`  ${mc.content.split('\n')[0]?.slice(0, 150) ?? ''}`);
      break;
    }
  }

  return lines.join('\n');
}

function formatSiloBreakdown(breakdown: Record<SiloKind, number>): string {
  const parts: string[] = [];
  if (breakdown.transcripts > 0) parts.push(`📝 transcripts: ${breakdown.transcripts}`);
  if (breakdown.atlas_files > 0) parts.push(`📁 atlas_files: ${breakdown.atlas_files}`);
  if (breakdown.atlas_changelog > 0) parts.push(`📋 atlas_changelog: ${breakdown.atlas_changelog}`);
  if (breakdown.source_highlights > 0) parts.push(`✨ source_highlights: ${breakdown.source_highlights}`);
  return parts.join(', ');
}

// ── Tool registration ──────────────────────────────────────────────────

/**
 * Placeholder: in production, these are injected from the daemon's
 * runtime (home DB for transcripts, atlas runtime for code knowledge).
 * For now we define the interface the tool expects.
 */
export interface SearchDependencies {
  /** Search transcript chunks (from home DB). */
  searchTranscripts(opts: {
    query: string;
    k: number;
    scope: BrainSearchScope;
    identity?: string;
    sessionId?: string;
    projectSlug?: string;
    weights?: { bm25: number; vector: number };
  }): Promise<SiloHit[]>;

  /** Search atlas files (from per-repo DB). */
  searchAtlasFiles(opts: {
    query: string;
    k: number;
    workspace?: string;
  }): Promise<SiloHit[]>;

  /** Search atlas changelog entries. */
  searchAtlasChangelog(opts: {
    query: string;
    k: number;
    workspace?: string;
  }): Promise<SiloHit[]>;

  /** Search source highlights. */
  searchSourceHighlights(opts: {
    query: string;
    k: number;
    workspace?: string;
  }): Promise<SiloHit[]>;

  /** Get current session ID from env. */
  getCurrentSessionId(): string | undefined;

  /** Get current identity name from env. */
  getCurrentIdentity(): string | undefined;

  /** Get current project slug from cwd. */
  getCurrentProjectSlug(): string | undefined;

  /** Home DB instance (for star persistence). */
  db: InstanceType<typeof Database>;
}

/**
 * Register the brain_search tool on an MCP server.
 *
 * @param server - The MCP server to register on.
 * @param deps - Search dependencies (transcript search, atlas search, etc.)
 */
export function registerBrainSearchTool(server: McpServer, deps: SearchDependencies): void {
  server.tool('brain_search', brainSearchSchema, async (rawArgs) => {
    const args = rawArgs as {
      action?: 'search' | 'star';
      query: string;
      note?: string;
      category?: string;
      scope?: BrainSearchScope;
      silos?: SiloKind[];
      k?: number;
      identity?: string;
      workspace?: string;
      weights?: { bm25: number; vector: number };
      candidate_pool?: number;
    };

    // ── Star action (cognitive waypoint) ────────────────────────────
    if (args.action === 'star') {
      const rawNote = typeof args.note === 'string' ? args.note : '';
      const note = rawNote.trim();

      if (!note) {
        return {
          content: [{
            type: 'text',
            text: 'No note provided. Usage: brain_search action=star note="what happened" [category=decision]',
          }],
          isError: true,
        };
      }

      // Validate category if provided.
      const rawCategory = typeof args.category === 'string' ? args.category : undefined;
      if (rawCategory !== undefined) {
        const parsed = validateCategory(rawCategory);
        if (!parsed) {
          return {
            content: [{
              type: 'text',
              text: `Invalid category "${rawCategory}". Valid: ${STAR_CATEGORIES.join(', ')}.`,
            }],
            isError: true,
          };
        }
      }

      const category = rawCategory ? validateCategory(rawCategory) : undefined;
      const maxChars = category ? MAX_CATEGORIZED_NOTE_CHARS : MAX_AMBIENT_NOTE_CHARS;
      const clippedNote = safeTruncate(note, maxChars);

      // Without category: ephemeral — acknowledge but don't persist.
      if (!category) {
        return {
          content: [{ type: 'text', text: `⭐ Noted: ${clippedNote}` }],
        };
      }

      // With category: persist to Home DB for rebirth injection.
      const identityName = deps.getCurrentIdentity() ?? 'unknown';
      const sessionId = deps.getCurrentSessionId();

      const star = appendStar(
        deps.db,
        identityName,
        sessionId,
        clippedNote,
        category,
      );

      return {
        content: [{ type: 'text', text: `⭐ Pinned [${category}]: ${star.note} (${formatStarTimestamp(star.ts)})` }],
      };
    }

    // ── Search action (default) ─────────────────────────────────────
    const scope = args.scope ?? 'workspace';
    const k = args.k ?? 20;
    const candidatePool = args.candidate_pool ?? 50;

    const scopeConfig = resolveScope(scope);
    let targetSilos = scopeConfig.silos;

    // Allow caller to override which silos to search
    if (args.silos && args.silos.length > 0) {
      targetSilos = applySiloFilter(scopeConfig.silos, args.silos);
    }

    const identity = scopeConfig.filterByIdentity
      ? args.identity ?? deps.getCurrentIdentity()
      : undefined;
    const sessionId = scopeConfig.filterBySession ? deps.getCurrentSessionId() : undefined;
    const projectSlug = scopeConfig.filterByProject ? deps.getCurrentProjectSlug() : undefined;

    // ── Per-silo retrieval (parallel) ───────────────────────────────
    const siloPromises: Promise<SiloHit[]>[] = [];

    for (const silo of targetSilos) {
      switch (silo) {
        case 'transcripts':
          siloPromises.push(
            deps.searchTranscripts({
              query: args.query,
              k: candidatePool,
              scope,
              identity,
              sessionId,
              projectSlug,
              weights: args.weights,
            }),
          );
          break;

        case 'atlas_files':
          if (scopeConfig.includeAtlas) {
            siloPromises.push(
              deps.searchAtlasFiles({ query: args.query, k: candidatePool, workspace: args.workspace }),
            );
          }
          break;

        case 'atlas_changelog':
          if (scopeConfig.includeAtlas) {
            siloPromises.push(
              deps.searchAtlasChangelog({ query: args.query, k: candidatePool, workspace: args.workspace }),
            );
          }
          break;

        case 'source_highlights':
          if (scopeConfig.includeAtlas) {
            siloPromises.push(
              deps.searchSourceHighlights({ query: args.query, k: candidatePool, workspace: args.workspace }),
            );
          }
          break;
      }
    }

    const siloResults = await Promise.all(siloPromises);
    const hits = fuseCrossSilo(siloResults, { k });

    // Count per-silo stats
    const siloBreakdown: Record<SiloKind, number> = {
      transcripts: 0,
      atlas_files: 0,
      atlas_changelog: 0,
      source_highlights: 0,
    };
    for (const results of siloResults) {
      for (const hit of results) {
        siloBreakdown[hit.silo] = (siloBreakdown[hit.silo] ?? 0) + 1;
      }
    }

    // ── Format response ────────────────────────────────────────────
    if (hits.length === 0) {
      return {
        content: [
          {
            type: 'text',
            text: `No results for "${args.query}" (scope: ${scope}).`,
          },
        ],
      };
    }

    const header = `brain_search "${args.query}" (scope: ${scope}) — ${hits.length} results\n${formatSiloBreakdown(siloBreakdown)}`;
    const hitLines = hits.map((hit, i) => formatHit(hit, i));
    const footer = `_${siloBreakdown.transcripts + siloBreakdown.atlas_files + siloBreakdown.atlas_changelog + siloBreakdown.source_highlights} candidates fused, top ${hits.length} returned._`;

    return {
      content: [
        {
          type: 'text',
          text: [header, '', ...hitLines, '', footer].join('\n'),
        },
      ],
    };
  });
}
