/**
 * atlas_diff — compute unified diffs between Atlas file snapshots.
 *
 * Enables agents and the UI to see exactly what changed in a file between
 * two changelog entries, with source-highlight annotations and changelog
 * metadata alongside the mechanical diff.
 *
 * Resolution chain:
 * 1. Check atlas_file_snapshots for both endpoints → instant diff
 * 2. If an exact snapshot is missing, use the nearest retained prior snapshot
 * 3. If snapshots are unavailable, check commit_sha → git show
 * 4. If none of those are available, return a descriptive error
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import {
  lookupSnapshot,
  lookupSnapshotRecord,
  getAtlasFile,
  mapChangelogRecord,
  type AtlasDatabase,
  type AtlasChangelogRecord,
} from '../db.js';
import type { SourceHighlight } from '../types.js';

// ── Types (Step 3a) ────────────────────────────────────────────────────────

export const atlasDiffInputSchema = z.object({
  file_path: z.string().min(1).describe('File path to diff'),
  from: z.string().min(1).describe("Source endpoint: changelog_id (numeric), ISO timestamp, or 'prev'"),
  to: z.string().min(1).describe("Target endpoint: changelog_id (numeric), ISO timestamp, or 'latest'"),
  mode: z.enum(['unified', 'stat']).default('unified').describe('Output mode: unified diff or stat summary'),
  workspace: z.string().optional().describe('Workspace (defaults to current)'),
});

export const atlasChangelogDiffInputSchema = z.object({
  changelog_id: z.coerce.number().int().positive().describe('Atlas changelog ID. The file path is inferred from this row.'),
  from: z.string().min(1).default('changelog').describe('Source endpoint. Use "changelog" for the selected changelog ID, "prev" for the prior entry, a numeric changelog ID, ISO timestamp, or "latest".'),
  to: z.string().min(1).default('latest').describe('Target endpoint. Use "changelog" for the selected changelog ID, a numeric changelog ID, ISO timestamp, or "latest".'),
  mode: z.enum(['unified', 'stat']).default('unified').describe('Output mode: unified diff or stat summary'),
  workspace: z.string().optional().describe('Workspace (defaults to current)'),
});

export const atlasSnapshotInputSchema = z.object({
  changelog_id: z.coerce.number().int().positive().optional().describe('Atlas changelog ID. When provided, file_path is inferred unless overridden.'),
  file_path: z.string().min(1).optional().describe('File path to inspect. Required when using a timestamp or "latest" without changelog_id.'),
  at: z.string().min(1).optional().describe('Endpoint to inspect: "changelog" (selected changelog_id), numeric changelog ID, ISO timestamp, "latest", or "prev" with changelog_id. Defaults to "changelog" when changelog_id is provided, otherwise "latest".'),
  start_line: z.coerce.number().int().min(1).optional().describe('First 1-indexed line to return. Defaults to 1.'),
  end_line: z.coerce.number().int().min(1).optional().describe('Last 1-indexed line to return. Defaults to the end of the file, capped by max_lines.'),
  max_lines: z.coerce.number().int().min(1).max(5000).default(400).describe('Maximum lines to return (default 400, max 5000).'),
  workspace: z.string().optional().describe('Workspace (defaults to current)'),
});

export type DiffContentSource = 'exact_snapshot' | 'nearest_snapshot' | 'git';

export interface DiffEndpointMeta {
  changelog_id: number | null;
  summary: string;
  author: string | null;
  timestamp: string | null;
  content_source?: DiffContentSource;
  snapshot_changelog_id?: number | null;
  snapshot_timestamp?: string | null;
}

export interface DiffStat {
  insertions: number;
  deletions: number;
  lines_changed: number;
}

export interface DiffHighlightAnnotation {
  startLine: number;
  endLine: number;
  label: string;
}

export interface DiffResult {
  file_path: string;
  from_meta: DiffEndpointMeta;
  to_meta: DiffEndpointMeta;
  diff_content: string | null;
  stat: DiffStat | null;
  source_highlights: DiffHighlightAnnotation[];
}

export interface SnapshotResult {
  file_path: string;
  endpoint_meta: DiffEndpointMeta;
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
  truncated: boolean;
}

// ── Resolution (Step 3b) ───────────────────────────────────────────────────

interface ResolvedEndpoint {
  content: string;
  changelogId: number | null;
  meta: DiffEndpointMeta;
}

function parseEndpointId(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return null;
}

function isIsoTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(value.trim());
}

/**
 * Find a changelog row by ID in the active workspace.
 */
function findChangelogById(
  db: AtlasDatabase,
  workspace: string,
  changelogId: number,
): AtlasChangelogRecord | null {
  const row = db.prepare(
    'SELECT * FROM atlas_changelog WHERE id = ? AND workspace = ? LIMIT 1',
  ).get(changelogId, workspace) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapChangelogRecord(row);
}

/**
 * Find the nearest changelog row for a file at or before a given timestamp.
 */
function findChangelogByTimestamp(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  timestamp: string,
): AtlasChangelogRecord | null {
  const normalizedTs = timestamp.includes('T') ? timestamp : `${timestamp}T23:59:59`;
  const row = db.prepare(
    `SELECT * FROM atlas_changelog
     WHERE workspace = ? AND file_path = ? AND created_at <= ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspace, filePath, normalizedTs) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapChangelogRecord(row);
}

/**
 * Find the most recent changelog row for a file.
 */
function findLatestChangelog(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
): AtlasChangelogRecord | null {
  const row = db.prepare(
    `SELECT * FROM atlas_changelog
     WHERE workspace = ? AND file_path = ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspace, filePath) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapChangelogRecord(row);
}

/**
 * Find the changelog row immediately before a given changelog_id for a file.
 */
function findPrevChangelog(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  beforeId: number,
): AtlasChangelogRecord | null {
  // Get the timestamp of the target entry first
  const target = db.prepare(
    'SELECT created_at FROM atlas_changelog WHERE id = ? AND workspace = ? LIMIT 1',
  ).get(beforeId, workspace) as { created_at: string } | undefined;
  if (!target) return null;

  const row = db.prepare(
    `SELECT * FROM atlas_changelog
     WHERE workspace = ? AND file_path = ? AND created_at < ?
     ORDER BY created_at DESC LIMIT 1`,
  ).get(workspace, filePath, target.created_at) as Record<string, unknown> | undefined;

  if (!row) return null;
  return mapChangelogRecord(row);
}

interface NearestSnapshotRecord {
  changelog_id: number;
  snapshot_created_at: string;
}

/**
 * Find the newest retained snapshot for this file at or before a changelog.
 *
 * atlas_commit skips duplicate snapshots when file content is unchanged, and
 * older exact snapshots may be pruned by ATLAS_SNAPSHOT_WINDOW. A prior retained
 * snapshot is still the correct file state when it predates the target entry.
 */
function findNearestSnapshotAtOrBeforeChangelog(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  changelog: AtlasChangelogRecord,
): NearestSnapshotRecord | null {
  const row = db.prepare(
    `SELECT
       s.changelog_id AS changelog_id,
       s.created_at AS snapshot_created_at
     FROM atlas_file_snapshots AS s
     JOIN atlas_changelog AS c ON c.id = s.changelog_id
     WHERE s.workspace = ?
       AND s.file_path = ?
       AND c.workspace = ?
       AND c.file_path = ?
       AND c.created_at <= ?
     ORDER BY c.created_at DESC, s.created_at DESC
     LIMIT 1`,
  ).get(workspace, filePath, workspace, filePath, changelog.created_at) as {
    changelog_id: number;
    snapshot_created_at: string;
  } | undefined;

  if (!row) return null;
  return {
    changelog_id: Number(row.changelog_id),
    snapshot_created_at: String(row.snapshot_created_at),
  };
}

/**
 * Try to reconstruct file content from git when snapshot is missing.
 */
function reconstructFromGit(
  commitSha: string | null,
  filePath: string,
  sourceRoot: string,
): string | null {
  if (!commitSha) return null;
  try {
    // Use execFileSync to avoid shell injection — each argument is passed
    // directly to the git binary without shell interpolation.
    const content = execFileSync(
      'git',
      ['show', `${commitSha}:${filePath}`],
      { cwd: sourceRoot, encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return content || null;
  } catch {
    return null;
  }
}

function buildMeta(
  changelog: AtlasChangelogRecord | null,
  contentSource?: DiffContentSource,
  snapshot?: { changelogId: number | null; timestamp: string | null },
): DiffEndpointMeta {
  if (!changelog) {
    return {
      changelog_id: null,
      summary: '(no changelog entry)',
      author: null,
      timestamp: null,
      content_source: contentSource,
      snapshot_changelog_id: snapshot?.changelogId,
      snapshot_timestamp: snapshot?.timestamp,
    };
  }
  const author = [changelog.author_name, changelog.author_engine].filter(Boolean).join(' / ') || null;
  return {
    changelog_id: changelog.id,
    summary: changelog.summary,
    author,
    timestamp: changelog.created_at,
    content_source: contentSource,
    snapshot_changelog_id: snapshot?.changelogId,
    snapshot_timestamp: snapshot?.timestamp,
  };
}

/**
 * Resolve a concrete changelog row to actual file content.
 */
function resolveChangelogContent(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  changelog: AtlasChangelogRecord,
  sourceRoot: string,
): ResolvedEndpoint | { error: string } {
  if (changelog.file_path !== filePath) {
    return {
      error: `Changelog #${changelog.id} belongs to ${changelog.file_path}, not ${filePath}`,
    };
  }

  const exactSnapshot = lookupSnapshotRecord(db, filePath, workspace, changelog.id);
  const exactContent = exactSnapshot
    ? lookupSnapshot(db, filePath, workspace, changelog.id)
    : null;
  if (exactContent !== null) {
    return {
      content: exactContent,
      changelogId: changelog.id,
      meta: buildMeta(changelog, 'exact_snapshot', {
        changelogId: exactSnapshot?.changelog_id ?? changelog.id,
        timestamp: exactSnapshot?.created_at ?? null,
      }),
    };
  }

  const nearestSnapshot = findNearestSnapshotAtOrBeforeChangelog(db, workspace, filePath, changelog);
  if (nearestSnapshot) {
    const nearestContent = lookupSnapshot(db, filePath, workspace, nearestSnapshot.changelog_id);
    if (nearestContent !== null) {
      return {
        content: nearestContent,
        changelogId: changelog.id,
        meta: buildMeta(changelog, 'nearest_snapshot', {
          changelogId: nearestSnapshot.changelog_id,
          timestamp: nearestSnapshot.snapshot_created_at,
        }),
      };
    }
  }

  const gitContent = reconstructFromGit(changelog.commit_sha, filePath, sourceRoot);
  if (gitContent !== null) {
    return {
      content: gitContent,
      changelogId: changelog.id,
      meta: buildMeta(changelog, 'git'),
    };
  }

  return { error: `No snapshot or git content available for ${filePath} at changelog #${changelog.id}` };
}

/**
 * Resolve an endpoint (from/to/snapshot) to actual file content.
 */
function resolveEndpoint(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  endpoint: string,
  sourceRoot: string,
  // For 'prev', we need to know the 'to' endpoint's changelog id
  toChangelogId?: number | null,
): ResolvedEndpoint | { error: string } {
  // Case 1: numeric changelog_id
  const numericId = parseEndpointId(endpoint);
  if (numericId !== null) {
    const changelog = findChangelogById(db, workspace, numericId);
    if (!changelog) {
      return { error: `No changelog entry found for #${numericId} in workspace ${workspace}` };
    }
    return resolveChangelogContent(db, workspace, filePath, changelog, sourceRoot);
  }

  // Case 2: ISO timestamp
  if (isIsoTimestamp(endpoint)) {
    const changelog = findChangelogByTimestamp(db, workspace, filePath, endpoint);
    if (!changelog) return { error: `No changelog entry found for ${filePath} at or before ${endpoint}` };

    return resolveChangelogContent(db, workspace, filePath, changelog, sourceRoot);
  }

  // Case 3: 'prev' — entry before the 'to' endpoint
  if (endpoint === 'prev') {
    if (toChangelogId == null) {
      return { error: "'prev' requires a resolved 'to' endpoint first" };
    }
    const changelog = findPrevChangelog(db, workspace, filePath, toChangelogId);
    if (!changelog) return { error: `No previous changelog entry found for ${filePath} before #${toChangelogId}` };

    return resolveChangelogContent(db, workspace, filePath, changelog, sourceRoot);
  }

  // Case 4: 'latest'
  if (endpoint === 'latest') {
    const changelog = findLatestChangelog(db, workspace, filePath);
    if (!changelog) return { error: `No changelog entries found for ${filePath}` };

    return resolveChangelogContent(db, workspace, filePath, changelog, sourceRoot);
  }

  return { error: `Unrecognized endpoint value: "${endpoint}". Use changelog_id, ISO timestamp, 'prev', or 'latest'.` };
}

// ── Diff Engine (Step 3c) ──────────────────────────────────────────────────

/**
 * Lightweight unified diff implementation (Myers-like).
 * For MVP we use a simple line-based diff — no external dependency needed.
 */
export function computeUnifiedDiff(oldLines: string[], newLines: string[], contextLines = 3): string {
  // Build a simple LCS-based diff
  const hunks: Array<{ oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] }> = [];

  // Simple O(ND) approach for small-to-medium files
  const n = oldLines.length;
  const m = newLines.length;

  // Build edit script using simple comparison
  const edits: Array<'equal' | 'delete' | 'insert'> = [];
  let i = 0;
  let j = 0;

  // Use a hash map for faster matching
  const newLineMap = new Map<string, number[]>();
  for (let k = 0; k < m; k++) {
    const line = newLines[k];
    if (line !== undefined) {
      const entries = newLineMap.get(line);
      if (entries) entries.push(k);
      else newLineMap.set(line, [k]);
    }
  }

  const matched = new Set<number>();
  const oldMatched = new Array<boolean>(n).fill(false);

  // Pass 1: match unique lines
  for (let k = 0; k < n; k++) {
    const line = oldLines[k];
    if (line === undefined) continue;
    const candidates = newLineMap.get(line);
    if (candidates && candidates.length === 1) {
      const newIdx = candidates[0]!;
      oldMatched[k] = true;
      matched.add(newIdx);
    }
  }

  // Build simple diff output using the matched lines as anchors
  const result: string[] = [];

  // Simple approach: walk both sequences and emit changes
  i = 0;
  j = 0;

  while (i < n || j < m) {
    const oldLine = oldLines[i];
    const newLine = newLines[j];

    if (i < n && j < m && oldLine === newLine) {
      result.push(` ${oldLine}`);
      i++;
      j++;
    } else if (i < n && j < m) {
      // Check if old line appears later in new
      let foundOldInNew = -1;
      for (let k = j + 1; k < Math.min(j + 20, m); k++) {
        if (newLines[k] === oldLine) { foundOldInNew = k; break; }
      }
      // Check if new line appears later in old
      let foundNewInOld = -1;
      for (let k = i + 1; k < Math.min(i + 20, n); k++) {
        if (oldLines[k] === newLine) { foundNewInOld = k; break; }
      }

      if (foundOldInNew >= 0 && (foundNewInOld < 0 || foundOldInNew - j <= foundNewInOld - i)) {
        // New lines were inserted
        for (let k = j; k < foundOldInNew; k++) {
          result.push(`+${newLines[k]}`);
        }
        j = foundOldInNew;
      } else if (foundNewInOld >= 0) {
        // Old lines were deleted
        for (let k = i; k < foundNewInOld; k++) {
          result.push(`-${oldLines[k]}`);
        }
        i = foundNewInOld;
      } else {
        // Both changed — emit delete then insert
        if (i < n) { result.push(`-${oldLine}`); i++; }
        if (j < m) { result.push(`+${newLine}`); j++; }
      }
    } else if (i < n) {
      result.push(`-${oldLine}`);
      i++;
    } else if (j < m) {
      result.push(`+${newLine}`);
      j++;
    }
  }

  // Group into hunks with context
  if (result.length === 0) return '';

  // Find change regions
  const changeIndices: number[] = [];
  for (let k = 0; k < result.length; k++) {
    const line = result[k];
    if (line && (line.startsWith('+') || line.startsWith('-'))) {
      changeIndices.push(k);
    }
  }

  if (changeIndices.length === 0) return ''; // No changes

  // Build hunks
  const hunksList: string[] = [];
  let hunkStart = Math.max(0, changeIndices[0]! - contextLines);
  let hunkEnd = changeIndices[changeIndices.length - 1]!;
  // Extend context
  for (let k = 0; k < changeIndices.length - 1; k++) {
    const gap = changeIndices[k + 1]! - changeIndices[k]!;
    if (gap > contextLines * 2) {
      // Split into separate hunks
      const end1 = Math.min(result.length, changeIndices[k]! + contextLines);
      const start2 = Math.max(0, changeIndices[k + 1]! - contextLines);

      const hunkLines = result.slice(hunkStart, end1);
      const oldCount = hunkLines.filter((l) => !l?.startsWith('+')).length;
      const newCount = hunkLines.filter((l) => !l?.startsWith('-')).length;
      const oldStartLine = countLinesBefore(result, hunkStart, '-');
      const newStartLine = countLinesBefore(result, hunkStart, '+');

      hunksList.push(`@@ -${oldStartLine + 1},${oldCount} +${newStartLine + 1},${newCount} @@`);
      hunksList.push(...hunkLines);

      hunkStart = start2;
    }
  }

  // Last hunk
  const lastHunkLines = result.slice(hunkStart, Math.min(result.length, hunkEnd + contextLines + 1));
  if (lastHunkLines.length > 0) {
    const oldCount = lastHunkLines.filter((l) => !l?.startsWith('+')).length;
    const newCount = lastHunkLines.filter((l) => !l?.startsWith('-')).length;
    const oldStartLine = countLinesBefore(result, hunkStart, '-');
    const newStartLine = countLinesBefore(result, hunkStart, '+');

    hunksList.push(`@@ -${oldStartLine + 1},${oldCount} +${newStartLine + 1},${newCount} @@`);
    hunksList.push(...lastHunkLines);
  }

  return hunksList.length > 0 ? hunksList.join('\n') : '';
}

/** Count non-excluded lines before a given index in the diff result. */
function countLinesBefore(result: string[], index: number, exclude: string): number {
  let count = 0;
  for (let k = 0; k < index; k++) {
    const line = result[k];
    if (line && !line.startsWith(exclude)) count++;
  }
  return count;
}

export function parseDiffStat(diffContent: string): DiffStat {
  let insertions = 0;
  let deletions = 0;
  for (const line of diffContent.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++') && !line.startsWith('@@')) insertions++;
    else if (line.startsWith('-') && !line.startsWith('---') && !line.startsWith('@@')) deletions++;
  }
  return { insertions, deletions, lines_changed: insertions + deletions };
}

/**
 * Intersect source highlights with diff hunks to produce annotations.
 */
export function annotateWithHighlights(
  diffContent: string,
  highlights: SourceHighlight[],
): DiffHighlightAnnotation[] {
  if (!highlights.length || !diffContent) return [];

  const annotations: DiffHighlightAnnotation[] = [];

  // Extract line numbers from diff hunks
  const hunkHeaders = diffContent.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/g);
  if (!hunkHeaders) return [];

  // Track new-file line numbers through the diff
  let currentNewLine = 0;
  const changedNewLines = new Set<number>();

  for (const line of diffContent.split('\n')) {
    const hunkMatch = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunkMatch) {
      currentNewLine = Number(hunkMatch[1]) - 1;
      continue;
    }
    if (line.startsWith('+')) {
      currentNewLine++;
      changedNewLines.add(currentNewLine);
    } else if (line.startsWith('-')) {
      // deleted line — don't advance new line counter
    } else if (line.startsWith(' ')) {
      currentNewLine++;
    }
  }

  // Check which highlights overlap with changed lines
  for (const hl of highlights) {
    let hasOverlap = false;
    for (let ln = hl.startLine; ln <= hl.endLine; ln++) {
      if (changedNewLines.has(ln)) { hasOverlap = true; break; }
    }
    if (hasOverlap) {
      annotations.push({
        startLine: hl.startLine,
        endLine: hl.endLine,
        label: hl.label ?? `snippet ${hl.id}`,
      });
    }
  }

  return annotations;
}

// ── Core Diff Function (exposed for API endpoint reuse) ────────────────────

export interface DiffOptions {
  filePath: string;
  from: string;
  to: string;
  mode: 'unified' | 'stat';
  workspace?: string;
}

export interface ChangelogDiffOptions {
  changelogId: number;
  from?: string;
  to?: string;
  mode: 'unified' | 'stat';
  workspace?: string;
}

export interface SnapshotOptions {
  changelogId?: number;
  filePath?: string;
  at?: string;
  startLine?: number;
  endLine?: number;
  maxLines: number;
  workspace?: string;
}

export function computeDiff(runtime: AtlasRuntime, options: DiffOptions): DiffResult | { error: string } {
  const db = runtime.db;
  const workspace = options.workspace ?? runtime.config.workspace;
  const sourceRoot = runtime.config.sourceRoot;

  // Resolve 'to' endpoint first (needed for 'prev' resolution)
  const toResult = resolveEndpoint(db, workspace, options.filePath, options.to, sourceRoot);
  if ('error' in toResult) return toResult;

  // Resolve 'from' endpoint, passing 'to' changelog id for 'prev' support
  const fromResult = resolveEndpoint(db, workspace, options.filePath, options.from, sourceRoot, toResult.changelogId);
  if ('error' in fromResult) return fromResult;

  // Compute diff
  const oldLines = fromResult.content.split('\n');
  const newLines = toResult.content.split('\n');

  // Quick check: are they identical?
  const oldHash = createHash('sha256').update(fromResult.content, 'utf-8').digest('hex');
  const newHash = createHash('sha256').update(toResult.content, 'utf-8').digest('hex');

  let diffContent: string;
  if (oldHash === newHash) {
    diffContent = '';
  } else {
    diffContent = computeUnifiedDiff(oldLines, newLines);
  }

  // Get source highlights for annotation
  const fileRecord = getAtlasFile(db, workspace, options.filePath);
  const highlights = fileRecord?.source_highlights ?? [];
  const annotations = annotateWithHighlights(diffContent, highlights);

  const result: DiffResult = {
    file_path: options.filePath,
    from_meta: fromResult.meta,
    to_meta: toResult.meta,
    diff_content: options.mode === 'unified' ? diffContent : null,
    stat: options.mode === 'stat' ? parseDiffStat(diffContent) : (diffContent ? parseDiffStat(diffContent) : null),
    source_highlights: annotations,
  };

  return result;
}

function normalizeChangelogEndpoint(endpoint: string | undefined, changelogId: number, fallback: string): string {
  const normalized = (endpoint ?? fallback).trim();
  return normalized === 'changelog' ? String(changelogId) : normalized;
}

export function computeChangelogDiff(runtime: AtlasRuntime, options: ChangelogDiffOptions): DiffResult | { error: string } {
  const db = runtime.db;
  const workspace = options.workspace ?? runtime.config.workspace;
  const changelog = findChangelogById(db, workspace, options.changelogId);
  if (!changelog) {
    return { error: `No changelog entry found for #${options.changelogId} in workspace ${workspace}` };
  }

  return computeDiff(runtime, {
    filePath: changelog.file_path,
    from: normalizeChangelogEndpoint(options.from, options.changelogId, 'changelog'),
    to: normalizeChangelogEndpoint(options.to, options.changelogId, 'latest'),
    mode: options.mode,
    workspace,
  });
}

export function computeSnapshot(runtime: AtlasRuntime, options: SnapshotOptions): SnapshotResult | { error: string } {
  const db = runtime.db;
  const workspace = options.workspace ?? runtime.config.workspace;
  const sourceRoot = runtime.config.sourceRoot;

  let filePath = options.filePath;
  let endpoint = options.at?.trim();
  let targetChangelogId: number | undefined = options.changelogId;

  if (targetChangelogId != null) {
    const changelog = findChangelogById(db, workspace, targetChangelogId);
    if (!changelog) {
      return { error: `No changelog entry found for #${targetChangelogId} in workspace ${workspace}` };
    }
    filePath ??= changelog.file_path;
    endpoint = normalizeChangelogEndpoint(endpoint, targetChangelogId, 'changelog');
  } else {
    endpoint ??= 'latest';
    const parsedEndpointId = parseEndpointId(endpoint);
    if (parsedEndpointId !== null) {
      const changelog = findChangelogById(db, workspace, parsedEndpointId);
      if (!changelog) {
        return { error: `No changelog entry found for #${parsedEndpointId} in workspace ${workspace}` };
      }
      targetChangelogId = parsedEndpointId;
      filePath ??= changelog.file_path;
    }
  }

  if (!filePath) {
    return { error: 'atlas_snapshot requires file_path unless changelog_id or numeric at=... can infer it.' };
  }

  const resolvedEndpoint = endpoint ?? 'latest';
  if (resolvedEndpoint === 'changelog') {
    return { error: 'at="changelog" requires changelog_id.' };
  }

  const resolved = resolveEndpoint(db, workspace, filePath, resolvedEndpoint, sourceRoot, targetChangelogId);
  if ('error' in resolved) return resolved;

  const lines = resolved.content.split('\n');
  const totalLines = lines.length;
  const startLine = Math.min(Math.max(options.startLine ?? 1, 1), Math.max(totalLines, 1));
  const requestedEndLine = options.endLine ?? totalLines;
  const cappedEndLine = Math.min(Math.max(requestedEndLine, startLine), totalLines);
  const maxEndLine = Math.min(cappedEndLine, startLine + options.maxLines - 1);
  const content = lines.slice(startLine - 1, maxEndLine).join('\n');

  return {
    file_path: filePath,
    endpoint_meta: resolved.meta,
    start_line: startLine,
    end_line: maxEndLine,
    total_lines: totalLines,
    content,
    truncated: maxEndLine < cappedEndLine,
  };
}

function formatContentSource(meta: DiffEndpointMeta): string | null {
  if (!meta.content_source) return null;
  if (meta.content_source === 'nearest_snapshot' && meta.snapshot_changelog_id != null) {
    return `nearest retained snapshot from changelog #${meta.snapshot_changelog_id}`;
  }
  if (meta.content_source === 'exact_snapshot') return 'exact Atlas snapshot';
  if (meta.content_source === 'git') return 'git reconstruction';
  return meta.content_source;
}

function formatDiffResult(result: DiffResult, title = `Diff for ${result.file_path}`): string {
  const parts: string[] = [];

  parts.push(title);
  parts.push('');

  parts.push('── FROM ──');
  parts.push(`  Changelog #${result.from_meta.changelog_id ?? '?'}`);
  parts.push(`  Summary: ${result.from_meta.summary}`);
  if (result.from_meta.author) parts.push(`  Author: ${result.from_meta.author}`);
  if (result.from_meta.timestamp) parts.push(`  Time: ${result.from_meta.timestamp}`);
  const fromSource = formatContentSource(result.from_meta);
  if (fromSource) parts.push(`  Content source: ${fromSource}`);

  parts.push('── TO ──');
  parts.push(`  Changelog #${result.to_meta.changelog_id ?? '?'}`);
  parts.push(`  Summary: ${result.to_meta.summary}`);
  if (result.to_meta.author) parts.push(`  Author: ${result.to_meta.author}`);
  if (result.to_meta.timestamp) parts.push(`  Time: ${result.to_meta.timestamp}`);
  const toSource = formatContentSource(result.to_meta);
  if (toSource) parts.push(`  Content source: ${toSource}`);
  parts.push('');

  if (result.stat) {
    parts.push(`${result.stat.insertions} insertions(+), ${result.stat.deletions} deletions(-), ${result.stat.lines_changed} lines changed`);
    parts.push('');
  }

  if (result.diff_content) {
    parts.push(result.diff_content);
  } else if (result.stat && result.stat.lines_changed === 0) {
    parts.push('(no changes detected)');
  }

  if (result.source_highlights.length > 0) {
    parts.push('');
    parts.push('Source highlights in changed regions:');
    for (const ann of result.source_highlights) {
      parts.push(`  - Lines ${ann.startLine}-${ann.endLine}: ${ann.label}`);
    }
  }

  return parts.join('\n');
}

function formatSnapshotResult(result: SnapshotResult): string {
  const parts: string[] = [];

  parts.push(`Snapshot for ${result.file_path}`);
  parts.push(`Changelog #${result.endpoint_meta.changelog_id ?? '?'}`);
  parts.push(`Summary: ${result.endpoint_meta.summary}`);
  if (result.endpoint_meta.author) parts.push(`Author: ${result.endpoint_meta.author}`);
  if (result.endpoint_meta.timestamp) parts.push(`Time: ${result.endpoint_meta.timestamp}`);
  const source = formatContentSource(result.endpoint_meta);
  if (source) parts.push(`Content source: ${source}`);
  parts.push(`Lines: ${result.start_line}-${result.end_line} of ${result.total_lines}${result.truncated ? ' (truncated by max_lines)' : ''}`);
  parts.push('');
  parts.push('```');
  parts.push(result.content);
  parts.push('```');

  return parts.join('\n');
}

// ── Tool Registration (Step 3d) ────────────────────────────────────────────

export function registerDiffTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_diff',
    [
      'Compute a unified diff between two snapshots of a file.',
      '',
      '## Parameters',
      '- **file_path** (required): The file to diff.',
      '- **from** (required): Source endpoint — changelog_id (numeric), ISO timestamp, or "prev" (entry before `to`).',
      '- **to** (required): Target endpoint — changelog_id (numeric), ISO timestamp, or "latest" (most recent entry).',
      '- **mode** (optional): "unified" (default) for full diff, "stat" for insertion/deletion counts.',
      '',
      '## Resolution Chain',
      '1. Check atlas_file_snapshots for both endpoints → instant diff',
      '2. If an exact snapshot is missing, use the nearest retained prior snapshot',
      '3. If snapshots are unavailable, reconstruct from git via commit_sha',
      '4. If none are available, returns a descriptive error',
      '',
      '## Output',
      '- Unified diff with hunk headers',
      '- Changelog metadata (summary, author, timestamp) for both endpoints',
      '- Source highlight annotations showing which changed regions are key sections',
      '- Stat mode returns insertion/deletion counts instead of full diff',
    ].join('\n'),
    atlasDiffInputSchema.shape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = atlasDiffInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: `Invalid parameters: ${parsed.error.message}` }],
        };
      }

      const result = computeDiff(runtime, {
        filePath: parsed.data.file_path,
        from: parsed.data.from,
        to: parsed.data.to,
        mode: parsed.data.mode,
        workspace: parsed.data.workspace,
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text' as const, text: `❌ ${result.error}` }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: formatDiffResult(result) }],
      };
    },
  );

  toolWithDescription(server)(
    'atlas_changelog_diff',
    [
      'Diff from a changelog ID without manually looking up the file path.',
      '',
      '## Parameters',
      '- **changelog_id** (required): Atlas changelog ID; the file_path is inferred from the changelog row.',
      '- **from** (optional): Source endpoint. Defaults to "changelog" (the selected changelog ID). Use "prev" to show what the selected changelog introduced, or any atlas_diff endpoint.',
      '- **to** (optional): Target endpoint. Defaults to "latest". Use "changelog" to target the selected changelog ID, or any atlas_diff endpoint.',
      '- **mode** (optional): "unified" (default) for full diff, "stat" for insertion/deletion counts.',
      '',
      'Examples:',
      '- changelog_id=14017, mode=stat -> compare that historical file state to latest.',
      '- changelog_id=14017, from=prev, to=changelog -> show what that changelog introduced.',
      '',
      'Uses the same resolution chain as atlas_diff: exact snapshot, nearest retained prior snapshot, then git reconstruction from commit_sha.',
    ].join('\n'),
    atlasChangelogDiffInputSchema.shape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = atlasChangelogDiffInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: `Invalid parameters: ${parsed.error.message}` }],
        };
      }

      const result = computeChangelogDiff(runtime, {
        changelogId: parsed.data.changelog_id,
        from: parsed.data.from,
        to: parsed.data.to,
        mode: parsed.data.mode,
        workspace: parsed.data.workspace,
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text' as const, text: `❌ ${result.error}` }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: formatDiffResult(result, `Diff for changelog #${parsed.data.changelog_id} (${result.file_path})`),
        }],
      };
    },
  );

  toolWithDescription(server)(
    'atlas_snapshot',
    [
      'Show file content as Atlas knew it at a changelog, timestamp, or latest endpoint.',
      '',
      '## Parameters',
      '- **changelog_id**: Changelog ID to inspect; file_path is inferred unless overridden.',
      '- **file_path**: Required when using a timestamp or "latest" without changelog_id.',
      '- **at**: Endpoint to inspect. Defaults to "changelog" with changelog_id, otherwise "latest". Supports numeric changelog IDs, ISO timestamps, "latest", and "prev" with changelog_id.',
      '- **start_line/end_line/max_lines**: Limit the returned source window. max_lines defaults to 400 and caps at 5000.',
      '',
      'Uses the same resolution chain as atlas_diff: exact snapshot, nearest retained prior snapshot, then git reconstruction from commit_sha.',
    ].join('\n'),
    atlasSnapshotInputSchema.shape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = atlasSnapshotInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return {
          content: [{ type: 'text' as const, text: `Invalid parameters: ${parsed.error.message}` }],
        };
      }

      const result = computeSnapshot(runtime, {
        changelogId: parsed.data.changelog_id,
        filePath: parsed.data.file_path,
        at: parsed.data.at,
        startLine: parsed.data.start_line,
        endLine: parsed.data.end_line,
        maxLines: parsed.data.max_lines,
        workspace: parsed.data.workspace,
      });

      if ('error' in result) {
        return {
          content: [{ type: 'text' as const, text: `❌ ${result.error}` }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: formatSnapshotResult(result) }],
      };
    },
  );
}
