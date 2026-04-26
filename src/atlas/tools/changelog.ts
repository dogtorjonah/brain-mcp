import { execSync } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import type { AtlasChangelogRecord, AtlasChangelogSearchHit } from '../db.js';
import {
  queryAtlasChangelog,
  searchChangelogFts,
  searchChangelogVector,
} from '../db.js';
import { embedAtlasQueryText } from '../embeddings.js';
import { trackQuery } from '../queryLog.js';
import { resolveWorkspaceDb } from './bridge.js';

interface RankedResult {
  changelog_id: number;
  score: number;
  record: AtlasChangelogRecord;
  source: 'fts' | 'vector';
}

function parseSqliteUtcTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalTimestamp(value: string | null | undefined): string {
  const parsed = parseSqliteUtcTimestamp(value);
  return parsed ? parsed.toLocaleString() : 'unknown';
}

function formatStringList(values: string[]): string {
  return values.length > 0 ? values.join(', ') : '(none)';
}

function mapHitsToRanked(hits: AtlasChangelogSearchHit[]): RankedResult[] {
  return hits
    .filter((hit) => hit.record.id > 0)
    .map((hit) => ({
      changelog_id: hit.record.id,
      score: hit.score,
      record: hit.record,
      source: hit.source,
    }));
}

function fuseResults(bm25: RankedResult[], vector: RankedResult[], k = 60): RankedResult[] {
  const scores = new Map<number, { score: number; record: AtlasChangelogRecord; source: RankedResult['source'] }>();

  bm25.forEach((result, index) => {
    const current = scores.get(result.changelog_id);
    scores.set(result.changelog_id, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  vector.forEach((result, index) => {
    const current = scores.get(result.changelog_id);
    scores.set(result.changelog_id, {
      score: (current?.score ?? 0) + 1 / (k + index + 1),
      record: current?.record ?? result.record,
      source: current?.source ?? result.source,
    });
  });

  return [...scores.entries()]
    .sort((left, right) => right[1].score - left[1].score)
    .map(([changelogId, value]) => ({
      changelog_id: changelogId,
      score: value.score,
      record: value.record,
      source: value.source,
    }));
}

function matchesFilters(
  entry: AtlasChangelogRecord,
  filters: {
    file?: string;
    file_prefix?: string;
    cluster?: string;
    author_name?: string;
    author_instance_id?: string;
    author_engine?: string;
    since?: string;
    until?: string;
    verification_status?: string;
    breaking_only?: boolean;
  },
): boolean {
  if (filters.file && entry.file_path !== filters.file) return false;
  if (filters.file_prefix && !entry.file_path.startsWith(filters.file_prefix)) return false;
  if (filters.cluster && entry.cluster !== filters.cluster) return false;
  if (filters.author_name && entry.author_name !== filters.author_name) return false;
  if (filters.author_instance_id && entry.author_instance_id !== filters.author_instance_id) return false;
  if (filters.author_engine && entry.author_engine !== filters.author_engine) return false;
  if (filters.since && entry.created_at < filters.since) return false;
  if (filters.until && entry.created_at > filters.until) return false;
  if (filters.verification_status && entry.verification_status !== filters.verification_status) return false;
  if (filters.breaking_only && !entry.breaking_changes) return false;
  return true;
}

/**
 * Retrieve the git diff for a specific file at a given commit.
 * Returns the diff output or null if unavailable.
 */
function getGitDiff(sourceRoot: string, commitSha: string, filePath: string): string | null {
  try {
    // Show the diff introduced by this commit for this specific file
    const diff = execSync(
      `git show ${commitSha} -- ${JSON.stringify(filePath)}`,
      {
        cwd: sourceRoot,
        encoding: 'utf8',
        timeout: 10_000,
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 512 * 1024, // 512KB max — avoid blowing up on huge diffs
      },
    ).trim();
    return diff || null;
  } catch {
    // Commit may no longer exist (rebased away), or not a git repo
    return null;
  }
}

function formatEntry(entry: AtlasChangelogRecord, diff?: string | null): string {
  const lines = [
    `# ${entry.file_path}`,
    `- id: ${entry.id}`,
    `- created_at: ${formatLocalTimestamp(entry.created_at)}`,
    `- summary: ${entry.summary}`,
    `- cluster: ${entry.cluster ?? '(none)'}`,
    `- breaking_changes: ${entry.breaking_changes ? 'true' : 'false'}`,
    `- verification_status: ${entry.verification_status}`,
    `- source: ${entry.source}`,
    `- commit_sha: ${entry.commit_sha ?? '(none)'}`,
    `- author_name: ${entry.author_name ?? '(none)'}`,
    `- author_instance_id: ${entry.author_instance_id ?? '(none)'}`,
    `- author_engine: ${entry.author_engine ?? '(none)'}`,
    `- review_entry_id: ${entry.review_entry_id ?? '(none)'}`,
    `- patterns_added: ${formatStringList(entry.patterns_added)}`,
    `- patterns_removed: ${formatStringList(entry.patterns_removed)}`,
    `- hazards_added: ${formatStringList(entry.hazards_added)}`,
    `- hazards_removed: ${formatStringList(entry.hazards_removed)}`,
    `- verification_notes: ${entry.verification_notes ?? '(none)'}`,
  ];

  if (diff) {
    lines.push('');
    lines.push('## Diff');
    lines.push('```diff');
    lines.push(diff);
    lines.push('```');
  }

  return lines.join('\n');
}

// ── Query action handler ──
async function handleQuery(runtime: AtlasRuntime, args: Record<string, unknown>) {
  const file = args.file as string | undefined;
  const file_prefix = args.file_prefix as string | undefined;
  const query = args.query as string | undefined;
  const cluster = args.cluster as string | undefined;
  const author_name = args.author_name as string | undefined;
  const author_instance_id = args.author_instance_id as string | undefined;
  const author_engine = args.author_engine as string | undefined;
  const since = args.since as string | undefined;
  const until = args.until as string | undefined;
  const verification_status = args.verification_status as string | undefined;
  const breaking_only = args.breaking_only as boolean | undefined;
  const limit = args.limit as number | undefined;
  const workspace = args.workspace as string | undefined;
  const include_diff = args.include_diff as boolean | undefined;

  const maxResults = Math.max(1, Math.min(limit ?? 20, 100));
  const filterSet = {
    file,
    file_prefix,
    cluster,
    author_name,
    author_instance_id,
    author_engine,
    since,
    until,
    verification_status,
    breaking_only,
  };

  // Resolve the correct database for cross-workspace queries
  const resolved = resolveWorkspaceDb(runtime, workspace);
  if ('error' in resolved) {
    return { content: [{ type: 'text' as const, text: resolved.error }] };
  }
  const { db: targetDb, workspace: activeWorkspace } = resolved;

  let entries: AtlasChangelogRecord[];
  if (query) {
    const candidateLimit = Math.min(100, Math.max(maxResults * 5, 25));
    const bm25Results = mapHitsToRanked(searchChangelogFts(targetDb, activeWorkspace, query, candidateLimit));
    let vectorResults: RankedResult[] = [];
    try {
      const embedding = await embedAtlasQueryText(query, runtime.config);
      vectorResults = mapHitsToRanked(searchChangelogVector(targetDb, activeWorkspace, embedding, candidateLimit));
    } catch {
      vectorResults = [];
    }

    const fused = fuseResults(bm25Results, vectorResults);
    entries = fused
      .map((result) => result.record)
      .filter((entry) => matchesFilters(entry, filterSet))
      .slice(0, maxResults);
  } else {
    entries = queryAtlasChangelog(targetDb, {
      workspace: activeWorkspace,
      file,
      file_prefix,
      cluster,
      author_name,
      author_instance_id,
      author_engine,
      since,
      until,
      verification_status,
      breaking_only,
      limit: maxResults,
    });
  }

  trackQuery(
    query || file || file_prefix || cluster || 'atlas_changelog',
    entries.map((entry) => entry.id),
    [...new Set(entries.map((entry) => entry.file_path))],
  );

  // Resolve diffs when requested — only for entries that have a commit_sha
  const formattedEntries = entries.map((entry) => {
    let diff: string | null = null;
    if (include_diff && entry.commit_sha) {
      diff = getGitDiff(runtime.config.sourceRoot, entry.commit_sha, entry.file_path);
    }
    return formatEntry(entry, diff);
  });

  return {
    content: [{
      type: 'text' as const,
      text: entries.length === 0
        ? 'No atlas changelog entries matched.'
        : formattedEntries.join('\n\n'),
    }],
  };
}

// ── Composite registration ──
export function registerChangelogTools(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_changelog',
    'Query changelog history for atlas entries. Retrieves changelog entries with filters (file, cluster, author, date range, breaking-only, verification status, free-text search). To WRITE changelog entries, use atlas_commit — it records changelog automatically when you pass patterns_added/removed or hazards_added/removed.',
    {
      action: z.enum(['query']).describe('Action to perform. Only "query" is supported — writing is handled by atlas_commit.'),
      // query action params
      file: z.string().optional().describe('Exact file path to filter by'),
      file_prefix: z.string().optional().describe('File path prefix to filter by (e.g. "src/stores/")'),
      query: z.string().optional().describe('Free-text search across changelog entries'),
      cluster: z.string().optional().describe('Filter by cluster name'),
      author_name: z.string().optional().describe('Filter by stamped author name'),
      author_instance_id: z.string().optional().describe('Filter by stamped author instance ID'),
      author_engine: z.string().optional().describe('Filter by stamped author engine'),
      since: z.string().optional().describe('ISO date — only entries after this date'),
      until: z.string().optional().describe('ISO date — only entries before this date'),
      verification_status: z.string().optional().describe('Filter by verification status'),
      breaking_only: coercedOptionalBoolean.describe('If true, only return entries with breaking changes'),
      include_diff: coercedOptionalBoolean.describe('If true, include the git diff for each entry that has a commit_sha. Shows exactly what code changed.'),
      limit: z.coerce.number().int().min(1).max(100).optional().describe('Max results (default 20, max 100)'),
      workspace: z.string().optional().describe('Override workspace (defaults to current)'),
    },
    async (args: Record<string, unknown>) => {
      const { action } = args;
      if (action === 'query') {
        return handleQuery(runtime, args);
      }
      return { content: [{ type: 'text' as const, text: `Unknown action: ${action}. Only "query" is supported. To write changelog entries, use atlas_commit with patterns_added/hazards_added fields.` }] };
    },
  );
}
