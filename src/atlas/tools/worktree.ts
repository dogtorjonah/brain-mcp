/**
 * atlas_worktree_status / atlas_worktree_diff
 *
 * Compares the live worktree on disk to Atlas' latest retained file snapshots.
 * This is the agent-facing replacement for reaching for git status/diff when
 * the question is "what changed relative to Atlas' remembered source state?"
 */

import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime, SourceHighlight } from '../types.js';
import {
  getAtlasFileAsync,
  listAtlasFilesAsync,
  lookupSnapshotAsync,
  lookupSnapshotRecordAsync,
} from '../dbAsync.js';
import { annotateWithHighlights, computeUnifiedDiff, parseDiffStat, type DiffStat } from './diff.js';
import { toolWithDescription } from './helpers.js';

const coercedOptionalBoolean = z.preprocess((value) => {
  if (value == null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  }
  return value;
}, z.boolean().optional());

export const atlasWorktreeStatusInputSchema = z.object({
  file_path: z.string().min(1).optional().describe('Optional file or directory path to check. Defaults to all Atlas-indexed files.'),
  paths: z.array(z.string().min(1)).optional().describe('Optional file or directory paths to check. Combined with file_path when both are provided.'),
  include_untracked: coercedOptionalBoolean.describe('Also scan disk for files not known to Atlas. Default true.'),
  max_untracked: z.coerce.number().int().min(0).max(1000).default(100).describe('Maximum untracked files to list. Default 100.'),
  max_results: z.coerce.number().int().min(1).max(2000).default(200).describe('Maximum Atlas-tracked entries to list. Default 200.'),
  scan_limit: z.coerce.number().int().min(100).max(100000).default(20000).describe('Maximum disk files to scan for untracked discovery. Default 20000.'),
  workspace: z.string().optional().describe('Workspace (defaults to current).'),
});

export const atlasWorktreeDiffInputSchema = z.object({
  file_path: z.string().min(1).optional().describe('Optional file or directory path to diff. Defaults to all modified Atlas-indexed files.'),
  paths: z.array(z.string().min(1)).optional().describe('Optional file or directory paths to diff. Combined with file_path when both are provided.'),
  mode: z.enum(['unified', 'stat']).default('unified').describe('Output mode: unified diff or stat summary.'),
  context_lines: z.coerce.number().int().min(0).max(20).default(3).describe('Context lines around each hunk. Default 3.'),
  max_files: z.coerce.number().int().min(1).max(100).default(20).describe('Maximum changed files to diff. Default 20.'),
  workspace: z.string().optional().describe('Workspace (defaults to current).'),
});

export type WorktreeEntryState = 'clean' | 'modified' | 'deleted' | 'untracked' | 'snapshot_missing' | 'read_error';

export interface WorktreeStatusEntry {
  file_path: string;
  state: WorktreeEntryState;
  current_sha1: string | null;
  current_snapshot_hash: string | null;
  atlas_snapshot_hash: string | null;
  atlas_file_hash: string | null;
  snapshot_changelog_id: number | null;
  snapshot_created_at: string | null;
  reason?: string;
}

export interface WorktreeStatusOptions {
  filePath?: string;
  paths?: string[];
  includeUntracked: boolean;
  maxUntracked: number;
  maxResults: number;
  scanLimit: number;
  workspace?: string;
}

export interface WorktreeStatusResult {
  workspace: string;
  source_root: string;
  filters: string[];
  checked_atlas_files: number;
  clean_count: number;
  modified_count: number;
  deleted_count: number;
  snapshot_missing_count: number;
  read_error_count: number;
  listed_atlas_entries: WorktreeStatusEntry[];
  omitted_atlas_entries: number;
  untracked_entries: WorktreeStatusEntry[];
  omitted_untracked_entries: number;
  untracked_scan_truncated: boolean;
}

export interface WorktreeDiffOptions {
  filePath?: string;
  paths?: string[];
  mode: 'unified' | 'stat';
  contextLines: number;
  maxFiles: number;
  workspace?: string;
}

export interface WorktreeDiffFile {
  file_path: string;
  state: 'modified' | 'deleted';
  snapshot_changelog_id: number | null;
  snapshot_created_at: string | null;
  stat: DiffStat;
  diff_content: string | null;
  source_highlights: Array<{ startLine: number; endLine: number; label: string }>;
}

export interface WorktreeDiffResult {
  workspace: string;
  source_root: string;
  files: WorktreeDiffFile[];
  skipped: Array<{ file_path: string; reason: string }>;
  total_stat: DiffStat;
  omitted_files: number;
}

interface CurrentFileRead {
  exists: boolean;
  content: string | null;
  sha1: string | null;
  snapshotHash: string | null;
  error?: string;
}

function atlasDbReadOptions(runtime: AtlasRuntime): { dbPath: string; cwd: string } {
  return {
    dbPath: runtime.config.dbPath,
    cwd: runtime.config.sourceRoot,
  };
}

const DEFAULT_IGNORED_SEGMENTS = new Set([
  '.atlas',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.voxxo-swarm',
  '.voxxo-swarm-worktrees',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

const DEFAULT_IGNORED_PREFIXES = [
  'data/',
  'relay/data/',
  'app/.next/',
  'app/out/',
  'app-solid/dist/',
  'terminal/dist/',
];

function toWorkspacePath(sourceRoot: string, rawPath: string): string | null {
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(sourceRoot, rawPath);
  const relative = path.relative(sourceRoot, resolved);
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function sourcePath(sourceRoot: string, workspacePath: string): string {
  return path.join(sourceRoot, ...workspacePath.split('/').filter(Boolean));
}

function normalizeFilters(sourceRoot: string, filePath: string | undefined, paths: string[] | undefined): string[] | { error: string } {
  const raw = [
    ...(filePath ? [filePath] : []),
    ...(paths ?? []),
  ];
  const normalized: string[] = [];
  for (const candidate of raw) {
    const rel = toWorkspacePath(sourceRoot, candidate);
    if (rel === null) {
      return { error: `Path is outside Atlas source root: ${candidate}` };
    }
    const trimmed = rel.replace(/\/+$/g, '');
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

function matchesFilters(filePath: string, filters: string[]): boolean {
  if (filters.length === 0) return true;
  return filters.some((filter) => filter === '' || filePath === filter || filePath.startsWith(`${filter}/`));
}

function shouldIgnoreWorkspacePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized) return false;
  if (DEFAULT_IGNORED_PREFIXES.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    return true;
  }
  return normalized.split('/').some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}

async function readCurrentFile(sourceRoot: string, filePath: string): Promise<CurrentFileRead> {
  try {
    const buffer = await readFile(sourcePath(sourceRoot, filePath));
    const content = buffer.toString('utf-8');
    return {
      exists: true,
      content,
      sha1: createHash('sha1').update(buffer).digest('hex'),
      snapshotHash: createHash('sha256').update(content, 'utf-8').digest('hex'),
    };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return { exists: false, content: null, sha1: null, snapshotHash: null };
    }
    return {
      exists: false,
      content: null,
      sha1: null,
      snapshotHash: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function scanDiskFiles(
  sourceRoot: string,
  filters: string[],
  scanLimit: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const roots = filters.length > 0 ? filters : [''];
  const files: string[] = [];
  const seen = new Set<string>();
  let scanned = 0;
  let truncated = false;

  const pushFile = (filePath: string): void => {
    if (seen.has(filePath) || shouldIgnoreWorkspacePath(filePath)) return;
    seen.add(filePath);
    files.push(filePath);
  };

  for (const root of roots) {
    if (truncated) break;
    if (root && shouldIgnoreWorkspacePath(root)) continue;
    const absRoot = sourcePath(sourceRoot, root);
    let stat;
    try {
      stat = await lstat(absRoot);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    if (stat.isFile()) {
      pushFile(root);
      continue;
    }
    if (!stat.isDirectory()) continue;

    const stack: string[] = [root];
    while (stack.length > 0) {
      const dirPath = stack.pop() ?? '';
      if (shouldIgnoreWorkspacePath(dirPath)) continue;
      let entries;
      try {
        entries = await readdir(sourcePath(sourceRoot, dirPath), { withFileTypes: true });
      } catch {
        continue;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const childPath = dirPath ? `${dirPath}/${entry.name}` : entry.name;
        if (shouldIgnoreWorkspacePath(childPath) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          stack.push(childPath);
          continue;
        }
        if (!entry.isFile()) continue;
        scanned += 1;
        if (scanned > scanLimit) {
          truncated = true;
          break;
        }
        pushFile(childPath);
      }
      if (truncated) break;
    }
  }

  return { files: files.sort(), truncated };
}

async function compareAtlasEntry(runtime: AtlasRuntime, workspace: string, filePath: string): Promise<WorktreeStatusEntry> {
  const dbOpts = atlasDbReadOptions(runtime);
  const [fileRecord, snapshot] = await Promise.all([
    getAtlasFileAsync(workspace, filePath, dbOpts),
    lookupSnapshotRecordAsync(workspace, filePath, null, dbOpts),
  ]);
  const current = await readCurrentFile(runtime.config.sourceRoot, filePath);

  const base = {
    file_path: filePath,
    current_sha1: current.sha1,
    current_snapshot_hash: current.snapshotHash,
    atlas_snapshot_hash: snapshot?.content_hash ?? null,
    atlas_file_hash: fileRecord?.file_hash ?? null,
    snapshot_changelog_id: snapshot?.changelog_id ?? null,
    snapshot_created_at: snapshot?.created_at ?? null,
  };

  if (current.error) {
    return { ...base, state: 'read_error', reason: current.error };
  }
  if (!current.exists) {
    return { ...base, state: 'deleted' };
  }
  if (snapshot) {
    return {
      ...base,
      state: current.snapshotHash === snapshot.content_hash ? 'clean' : 'modified',
    };
  }
  if (fileRecord?.file_hash && current.sha1 === fileRecord.file_hash) {
    return { ...base, state: 'clean', reason: 'Matched Atlas file_hash; no retained snapshot baseline is available.' };
  }
  return {
    ...base,
    state: 'snapshot_missing',
    reason: 'No retained Atlas snapshot baseline is available for this file.',
  };
}

async function buildUntrackedEntries(
  runtime: AtlasRuntime,
  atlasPaths: Set<string>,
  filters: string[],
  maxUntracked: number,
  scanLimit: number,
): Promise<{ entries: WorktreeStatusEntry[]; omitted: number; truncated: boolean }> {
  if (maxUntracked === 0) return { entries: [], omitted: 0, truncated: false };
  const scan = await scanDiskFiles(runtime.config.sourceRoot, filters, scanLimit);
  const untracked = scan.files
    .filter((filePath) => !atlasPaths.has(filePath))
    .filter((filePath) => matchesFilters(filePath, filters));
  const listed = untracked.slice(0, maxUntracked);
  const entries = await mapLimit(listed, 16, async (filePath): Promise<WorktreeStatusEntry> => {
    const current = await readCurrentFile(runtime.config.sourceRoot, filePath);
    return {
      file_path: filePath,
      state: 'untracked',
      current_sha1: current.sha1,
      current_snapshot_hash: current.snapshotHash,
      atlas_snapshot_hash: null,
      atlas_file_hash: null,
      snapshot_changelog_id: null,
      snapshot_created_at: null,
      ...(current.error ? { reason: current.error } : {}),
    };
  });
  return {
    entries,
    omitted: Math.max(0, untracked.length - listed.length),
    truncated: scan.truncated,
  };
}

export async function computeWorktreeStatus(
  runtime: AtlasRuntime,
  options: WorktreeStatusOptions,
): Promise<WorktreeStatusResult | { error: string }> {
  const workspace = options.workspace ?? runtime.config.workspace;
  const filters = normalizeFilters(runtime.config.sourceRoot, options.filePath, options.paths);
  if ('error' in filters) return filters;

  const atlasRecords = await listAtlasFilesAsync(workspace, atlasDbReadOptions(runtime));
  const atlasFiles = atlasRecords
    .map((record) => record.file_path)
    .filter((filePath) => matchesFilters(filePath, filters))
    .filter((filePath) => !shouldIgnoreWorkspacePath(filePath));
  const atlasPathSet = new Set(atlasRecords.map((record) => record.file_path));
  const allEntries = await mapLimit(atlasFiles, 16, (filePath) => compareAtlasEntry(runtime, workspace, filePath));
  const interesting = filters.length > 0
    ? allEntries
    : allEntries.filter((entry) => entry.state !== 'clean');
  const listedAtlasEntries = interesting.slice(0, options.maxResults);
  const untracked = options.includeUntracked
    ? await buildUntrackedEntries(runtime, atlasPathSet, filters, options.maxUntracked, options.scanLimit)
    : { entries: [], omitted: 0, truncated: false };

  return {
    workspace,
    source_root: runtime.config.sourceRoot,
    filters,
    checked_atlas_files: atlasFiles.length,
    clean_count: allEntries.filter((entry) => entry.state === 'clean').length,
    modified_count: allEntries.filter((entry) => entry.state === 'modified').length,
    deleted_count: allEntries.filter((entry) => entry.state === 'deleted').length,
    snapshot_missing_count: allEntries.filter((entry) => entry.state === 'snapshot_missing').length,
    read_error_count: allEntries.filter((entry) => entry.state === 'read_error').length,
    listed_atlas_entries: listedAtlasEntries,
    omitted_atlas_entries: Math.max(0, interesting.length - listedAtlasEntries.length),
    untracked_entries: untracked.entries,
    omitted_untracked_entries: untracked.omitted,
    untracked_scan_truncated: untracked.truncated,
  };
}

async function computeFileDiff(
  runtime: AtlasRuntime,
  workspace: string,
  entry: WorktreeStatusEntry & { state: 'modified' | 'deleted' },
  mode: 'unified' | 'stat',
  contextLines: number,
): Promise<WorktreeDiffFile | { file_path: string; reason: string }> {
  const dbOpts = atlasDbReadOptions(runtime);
  const oldContent = await lookupSnapshotAsync(workspace, entry.file_path, null, dbOpts);
  if (oldContent === null) {
    return { file_path: entry.file_path, reason: 'No retained Atlas snapshot content is available.' };
  }

  const current = entry.state === 'deleted'
    ? { content: '' }
    : await readCurrentFile(runtime.config.sourceRoot, entry.file_path);
  if ('error' in current && current.error) {
    return { file_path: entry.file_path, reason: current.error };
  }
  if (current.content === null) {
    return { file_path: entry.file_path, reason: 'Current worktree file could not be read.' };
  }

  const diffContent = computeUnifiedDiff(oldContent.split('\n'), current.content.split('\n'), contextLines);
  const stat = parseDiffStat(diffContent);
  const fileRecord = await getAtlasFileAsync(workspace, entry.file_path, dbOpts);
  const highlights: SourceHighlight[] = fileRecord?.source_highlights ?? [];
  return {
    file_path: entry.file_path,
    state: entry.state,
    snapshot_changelog_id: entry.snapshot_changelog_id,
    snapshot_created_at: entry.snapshot_created_at,
    stat,
    diff_content: mode === 'unified' ? diffContent : null,
    source_highlights: annotateWithHighlights(diffContent, highlights),
  };
}

export async function computeWorktreeDiff(
  runtime: AtlasRuntime,
  options: WorktreeDiffOptions,
): Promise<WorktreeDiffResult | { error: string }> {
  const workspace = options.workspace ?? runtime.config.workspace;
  const status = await computeWorktreeStatus(runtime, {
    filePath: options.filePath,
    paths: options.paths,
    includeUntracked: false,
    maxUntracked: 0,
    maxResults: 2000,
    scanLimit: 100,
    workspace,
  });
  if ('error' in status) return status;

  const candidates = status.listed_atlas_entries
    .filter((entry): entry is WorktreeStatusEntry & { state: 'modified' | 'deleted' } => entry.state === 'modified' || entry.state === 'deleted');
  const selected = candidates.slice(0, options.maxFiles);
  const diffed = await mapLimit(selected, 8, (entry) => computeFileDiff(
    runtime,
    workspace,
    entry,
    options.mode,
    options.contextLines,
  ));

  const files: WorktreeDiffFile[] = [];
  const skipped: Array<{ file_path: string; reason: string }> = [];
  for (const result of diffed) {
    if ('reason' in result) skipped.push(result);
    else files.push(result);
  }

  const totalStat = files.reduce<DiffStat>(
    (acc, file) => ({
      insertions: acc.insertions + file.stat.insertions,
      deletions: acc.deletions + file.stat.deletions,
      lines_changed: acc.lines_changed + file.stat.lines_changed,
    }),
    { insertions: 0, deletions: 0, lines_changed: 0 },
  );

  return {
    workspace,
    source_root: runtime.config.sourceRoot,
    files,
    skipped,
    total_stat: totalStat,
    omitted_files: Math.max(0, candidates.length - selected.length),
  };
}

function statePrefix(state: WorktreeEntryState): string {
  switch (state) {
    case 'modified': return 'M';
    case 'deleted': return 'D';
    case 'untracked': return '??';
    case 'snapshot_missing': return '!';
    case 'read_error': return 'ERR';
    case 'clean': return 'OK';
  }
}

function formatSnapshotSuffix(entry: WorktreeStatusEntry): string {
  if (entry.snapshot_changelog_id != null) return `snapshot #${entry.snapshot_changelog_id}`;
  if (entry.snapshot_created_at) return `snapshot ${entry.snapshot_created_at}`;
  if (entry.atlas_file_hash) return 'Atlas file_hash only';
  return 'no Atlas baseline';
}

function formatStatusResult(result: WorktreeStatusResult): string {
  const lines: string[] = [
    'Atlas worktree status',
    `Workspace: ${result.workspace}`,
    `Source root: ${result.source_root}`,
  ];
  if (result.filters.length > 0) lines.push(`Filters: ${result.filters.join(', ')}`);
  lines.push(
    `Checked Atlas files: ${result.checked_atlas_files}`,
    `Clean: ${result.clean_count}; modified: ${result.modified_count}; deleted: ${result.deleted_count}; snapshot-missing: ${result.snapshot_missing_count}; read-errors: ${result.read_error_count}; untracked: ${result.untracked_entries.length}${result.omitted_untracked_entries ? ` (+${result.omitted_untracked_entries} omitted)` : ''}`,
    '',
  );

  if (result.listed_atlas_entries.length === 0 && result.untracked_entries.length === 0) {
    lines.push('No Atlas worktree changes detected.');
  }

  for (const entry of result.listed_atlas_entries) {
    lines.push(`${statePrefix(entry.state)} ${entry.file_path} (${formatSnapshotSuffix(entry)})${entry.reason ? ` - ${entry.reason}` : ''}`);
  }
  for (const entry of result.untracked_entries) {
    lines.push(`${statePrefix(entry.state)} ${entry.file_path}`);
  }

  if (result.omitted_atlas_entries > 0) {
    lines.push(`... ${result.omitted_atlas_entries} more Atlas entries omitted by max_results.`);
  }
  if (result.untracked_scan_truncated) {
    lines.push('Untracked scan stopped at scan_limit; results may be incomplete.');
  }

  return lines.join('\n');
}

function formatDiffResult(result: WorktreeDiffResult, mode: 'unified' | 'stat'): string {
  const lines: string[] = [
    'Atlas worktree diff',
    `Workspace: ${result.workspace}`,
    `Source root: ${result.source_root}`,
    `${result.total_stat.insertions} insertions(+), ${result.total_stat.deletions} deletions(-), ${result.total_stat.lines_changed} lines changed`,
    '',
  ];

  if (result.files.length === 0 && result.skipped.length === 0) {
    lines.push('No modified Atlas-tracked files detected.');
    return lines.join('\n');
  }

  for (const file of result.files) {
    lines.push(`${file.state === 'deleted' ? 'D' : 'M'} ${file.file_path} (${file.stat.insertions} insertions, ${file.stat.deletions} deletions; snapshot #${file.snapshot_changelog_id ?? '?'})`);
    if (mode === 'unified') {
      lines.push(`--- Atlas snapshot ${file.snapshot_changelog_id ?? '?'}`);
      lines.push(`+++ Worktree ${file.file_path}`);
      lines.push(file.diff_content || '(no line-level changes detected)');
      if (file.source_highlights.length > 0) {
        lines.push('Source highlights in changed regions:');
        for (const highlight of file.source_highlights) {
          lines.push(`  - Lines ${highlight.startLine}-${highlight.endLine}: ${highlight.label}`);
        }
      }
      lines.push('');
    }
  }

  for (const skipped of result.skipped) {
    lines.push(`SKIP ${skipped.file_path} - ${skipped.reason}`);
  }
  if (result.omitted_files > 0) {
    lines.push(`... ${result.omitted_files} more changed files omitted by max_files.`);
  }

  return lines.join('\n').trimEnd();
}

export function registerWorktreeTools(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_worktree_status',
    [
      'Show live disk changes relative to Atlas latest snapshots.',
      '',
      'Use this instead of git_status when the review question is Atlas freshness: it checks Atlas-indexed files against the latest retained atlas_file_snapshots rows and optionally lists disk files not known to Atlas.',
      '',
      'States: M modified, D deleted, ?? untracked, ! missing snapshot baseline, ERR read error.',
    ].join('\n'),
    atlasWorktreeStatusInputSchema.shape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = atlasWorktreeStatusInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: [{ type: 'text' as const, text: `Invalid parameters: ${parsed.error.message}` }] };
      }
      const result = await computeWorktreeStatus(runtime, {
        filePath: parsed.data.file_path,
        paths: parsed.data.paths,
        includeUntracked: parsed.data.include_untracked ?? true,
        maxUntracked: parsed.data.max_untracked,
        maxResults: parsed.data.max_results,
        scanLimit: parsed.data.scan_limit,
        workspace: parsed.data.workspace,
      });
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }] };
      }
      return { content: [{ type: 'text' as const, text: formatStatusResult(result) }] };
    },
  );

  toolWithDescription(server)(
    'atlas_worktree_diff',
    [
      'Diff live disk files against Atlas latest snapshots.',
      '',
      'Use this instead of git_diff when the baseline should be Atlas remembered source state. It only diffs Atlas-tracked files with retained snapshot content; untracked files are reported by atlas_worktree_status.',
    ].join('\n'),
    atlasWorktreeDiffInputSchema.shape,
    async (rawArgs: Record<string, unknown>) => {
      const parsed = atlasWorktreeDiffInputSchema.safeParse(rawArgs);
      if (!parsed.success) {
        return { content: [{ type: 'text' as const, text: `Invalid parameters: ${parsed.error.message}` }] };
      }
      const result = await computeWorktreeDiff(runtime, {
        filePath: parsed.data.file_path,
        paths: parsed.data.paths,
        mode: parsed.data.mode,
        contextLines: parsed.data.context_lines,
        maxFiles: parsed.data.max_files,
        workspace: parsed.data.workspace,
      });
      if ('error' in result) {
        return { content: [{ type: 'text' as const, text: `ERROR: ${result.error}` }] };
      }
      return { content: [{ type: 'text' as const, text: formatDiffResult(result, parsed.data.mode) }] };
    },
  );
}
