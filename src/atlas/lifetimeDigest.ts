/**
 * Lifetime atlas changelog digest for brain-mcp handoffs.
 *
 * Pulls the calling identity's full atlas_changelog authorship for a workspace,
 * then renders either a flat chronological list or a budget-aware digest with
 * recent entries verbatim, focus-relevant older highlights, and an aggregated
 * rollup of the rest. Mirrors brain-api's lifetimeDigest.ts (which itself is
 * the brain-api port of voxxo-swarm relay's atlasLookup.getLifetimeChangelogDigest).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

type AtlasSqliteDb = InstanceType<typeof Database>;

const DEFAULT_LIFETIME_DIGEST_BUDGET = 25_000;
const DEFAULT_RECENT_LIFETIME_ENTRY_LIMIT = 100;
const DEFAULT_RELEVANT_OLDER_ENTRY_LIMIT = 8;
const DEFAULT_ROLLUP_TOP_FILE_LIMIT = 5;

const FOCUS_TERM_STOPWORDS = new Set([
  'about', 'after', 'again', 'agent', 'around', 'before', 'being', 'between',
  'build', 'check', 'continue', 'current', 'fixing', 'focus', 'history', 'issue',
  'later', 'maybe', 'prompt', 'rebirth', 'request', 'still', 'task', 'that',
  'there', 'these', 'thing', 'this', 'those', 'user', 'with',
]);

export interface AtlasLifetimeChangelogEntry {
  createdAt: string;
  filePath: string;
  summary: string;
  breakingChanges: boolean;
}

export interface LifetimeDigestOptions {
  /** Workspace name. When omitted, inferred from atlas_files. */
  workspace?: string;
  /** Per-section character budget. Default 25k. */
  sectionBudget?: number;
  /** Last-N entries shown verbatim. Default 100. */
  recentEntryLimit?: number;
  /** Older entries kept as focus-relevant highlights. Default 8. */
  relevantOlderEntryLimit?: number;
  /** File paths to score older entries against. */
  focusFilePaths?: readonly string[];
  /** Free-text query to score older entries against. */
  focusText?: string;
}

interface FocusFileTokens {
  exactPaths: Set<string>;
  fileNames: Set<string>;
  pathTerms: Set<string>;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Walk up from cwd looking for `<dir>/.brain/atlas.sqlite`. Caps at 8 hops.
 */
export function findBrainAtlasDbForCwd(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, '.brain', 'atlas.sqlite');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

function hasTableColumn(db: AtlasSqliteDb, tableName: string, columnName: string): boolean {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name?: string }>;
    return rows.some((row) => row.name === columnName);
  } catch {
    return false;
  }
}

function inferWorkspace(db: AtlasSqliteDb): string | null {
  try {
    const row = db.prepare(
      `SELECT workspace
       FROM atlas_files
       WHERE workspace IS NOT NULL AND workspace != ''
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    ).get() as { workspace?: string } | undefined;
    return row?.workspace?.trim() || null;
  } catch {
    return null;
  }
}

function verificationClause(db: AtlasSqliteDb): string {
  return hasTableColumn(db, 'atlas_changelog', 'verification_status')
    ? " AND verification_status != 'rejected'"
    : '';
}

function queryLifetimeChangelog(
  db: AtlasSqliteDb,
  workspace: string,
  authorName: string,
  authorInstanceIds: readonly string[],
): { totalCount: number; entries: AtlasLifetimeChangelogEntry[] } {
  const supportsAuthorName = hasTableColumn(db, 'atlas_changelog', 'author_name');
  const supportsAuthorIdentity = hasTableColumn(db, 'atlas_changelog', 'author_identity');
  const uniqueIds = [...new Set(authorInstanceIds.map((value) => value.trim()).filter(Boolean))];
  const trimmedAuthorName = authorName.trim();

  const authorClauses: string[] = [];
  const authorParams: string[] = [];

  if (supportsAuthorIdentity && trimmedAuthorName) {
    authorClauses.push('author_identity = ?');
    authorParams.push(trimmedAuthorName);
  }
  if (supportsAuthorName && trimmedAuthorName) {
    authorClauses.push('author_name = ?');
    authorParams.push(trimmedAuthorName);
  }
  if (uniqueIds.length > 0) {
    const placeholders = uniqueIds.map(() => '?').join(', ');
    authorClauses.push(`author_instance_id IN (${placeholders})`);
    authorParams.push(...uniqueIds);
  }
  if (authorClauses.length === 0) return { totalCount: 0, entries: [] };

  const whereClause = [
    'workspace = ?',
    `(${authorClauses.join(' OR ')})`,
    verificationClause(db).replace(/^ AND /, ''),
  ].filter(Boolean).join(' AND ');
  const baseParams = [workspace, ...authorParams];

  const totalRow = db.prepare(
    `SELECT COUNT(*) AS total
     FROM atlas_changelog
     WHERE ${whereClause}`,
  ).get(...baseParams) as { total?: number } | undefined;

  const rows = db.prepare(
    `SELECT created_at, file_path, summary, breaking_changes
     FROM atlas_changelog
     WHERE ${whereClause}
     ORDER BY created_at DESC, id DESC`,
  ).all(...baseParams) as Array<Record<string, unknown>>;

  const entries = rows.map((row) => ({
    createdAt: String(row.created_at ?? ''),
    filePath: String(row.file_path ?? ''),
    summary: String(row.summary ?? ''),
    breakingChanges: Number(row.breaking_changes ?? 0) !== 0,
  })).reverse();

  return {
    totalCount: Number(totalRow?.total ?? entries.length),
    entries,
  };
}

// ---------------------------------------------------------------------------
// Formatting + scoring
// ---------------------------------------------------------------------------

function parseSqliteUtcTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLifetimeTimestamp(value: string): string {
  const parsed = parseSqliteUtcTimestamp(value);
  return parsed
    ? parsed.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : value;
}

function normalizeSummary(summary: string): string {
  return summary.replace(/\s+/g, ' ').trim();
}

function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}... [truncated]`;
}

function tokenizeFocusText(text: string | null | undefined): string[] {
  if (!text?.trim()) return [];
  return [
    ...new Set(
      text
        .toLowerCase()
        .match(/[a-z0-9_./-]{4,}/g)
        ?.filter((term) => !FOCUS_TERM_STOPWORDS.has(term))
        .slice(0, 24) ?? [],
    ),
  ];
}

function buildFocusFileTokens(filePaths: readonly string[]): FocusFileTokens {
  const exactPaths = new Set<string>();
  const fileNames = new Set<string>();
  const pathTerms = new Set<string>();

  for (const filePath of filePaths) {
    const normalized = filePath.trim().toLowerCase();
    if (!normalized) continue;
    exactPaths.add(normalized);
    const segments = normalized.split('/').filter(Boolean);
    const fileName = segments[segments.length - 1];
    if (fileName) fileNames.add(fileName);
    for (const segment of segments) {
      if (segment.length >= 4) pathTerms.add(segment);
    }
  }

  return { exactPaths, fileNames, pathTerms };
}

function scoreLifetimeEntryForFocus(
  entry: AtlasLifetimeChangelogEntry,
  focusFiles: FocusFileTokens,
  focusTerms: readonly string[],
): number {
  let score = 0;
  const normalizedPath = entry.filePath.trim().toLowerCase();
  const normalizedEntrySummary = normalizeSummary(entry.summary).toLowerCase();

  if (focusFiles.exactPaths.has(normalizedPath)) score += 10;
  const fileName = normalizedPath.split('/').pop();
  if (fileName && focusFiles.fileNames.has(fileName)) score += 6;
  for (const term of focusFiles.pathTerms) {
    if (normalizedPath.includes(term)) score += 2;
  }
  for (const term of focusTerms) {
    if (normalizedEntrySummary.includes(term)) score += 3;
    if (normalizedPath.includes(term)) score += 1;
  }

  return score;
}

function formatLifetimeEntry(entry: AtlasLifetimeChangelogEntry): string {
  const prefix = entry.breakingChanges ? 'BREAKING ' : '';
  return [
    `  ${prefix}[${formatLifetimeTimestamp(entry.createdAt)}] ${entry.filePath}`,
    `    ${normalizeSummary(entry.summary)}`,
  ].join('\n');
}

function formatOlderHistoryRollup(entries: readonly AtlasLifetimeChangelogEntry[]): string {
  if (entries.length === 0) return '';

  const countsByFile = new Map<string, number>();
  for (const entry of entries) {
    countsByFile.set(entry.filePath, (countsByFile.get(entry.filePath) ?? 0) + 1);
  }

  const rankedFiles = [...countsByFile.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const topFiles = rankedFiles.slice(0, DEFAULT_ROLLUP_TOP_FILE_LIMIT);
  const remainingFileCount = Math.max(0, rankedFiles.length - topFiles.length);
  const remainingEntryCount = Math.max(
    0,
    entries.length - topFiles.reduce((sum, [, count]) => sum + count, 0),
  );
  const firstEntry = entries[0];
  const lastEntry = entries[entries.length - 1];
  if (!firstEntry || !lastEntry) return '';

  const lines = [
    `Older history rollup: ${entries.length} earlier entr${entries.length === 1 ? 'y' : 'ies'} across ${countsByFile.size} file${countsByFile.size === 1 ? '' : 's'}.`,
    `Date span: ${formatLifetimeTimestamp(firstEntry.createdAt)} -> ${formatLifetimeTimestamp(lastEntry.createdAt)}`,
  ];

  if (topFiles.length > 0) {
    lines.push('Top files:');
    for (const [filePath, count] of topFiles) {
      lines.push(`  - ${filePath}: ${count}`);
    }
  }
  if (remainingFileCount > 0) {
    lines.push(`Other files: ${remainingFileCount} file${remainingFileCount === 1 ? '' : 's'} / ${remainingEntryCount} entr${remainingEntryCount === 1 ? 'y' : 'ies'}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render a budget-aware lifetime digest:
 *   - all recent entries (last N) verbatim
 *   - focus-relevant older highlights (top K by score)
 *   - aggregated rollup of remaining older entries
 *
 * Returns '' when no atlas DB exists for cwd, no workspace can be inferred, or
 * the identity has no commits in this workspace.
 */
export function getLifetimeChangelogDigest(
  cwd: string,
  authorName: string,
  authorInstanceIds: readonly string[],
  options: LifetimeDigestOptions = {},
): string {
  const dbPath = findBrainAtlasDbForCwd(cwd);
  if (!dbPath) return '';

  let db: AtlasSqliteDb;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return '';
  }

  try {
    const resolvedWorkspace = options.workspace?.trim() || inferWorkspace(db);
    if (!resolvedWorkspace) return '';

    const { totalCount, entries } = queryLifetimeChangelog(
      db,
      resolvedWorkspace,
      authorName,
      authorInstanceIds,
    );
    if (entries.length === 0) return '';

    const trimmedAuthorName = authorName.trim();
    const recentEntryLimit = Math.max(1, options.recentEntryLimit ?? DEFAULT_RECENT_LIFETIME_ENTRY_LIMIT);
    const relevantOlderEntryLimit = Math.max(0, options.relevantOlderEntryLimit ?? DEFAULT_RELEVANT_OLDER_ENTRY_LIMIT);
    const sectionBudget = Math.max(500, options.sectionBudget ?? DEFAULT_LIFETIME_DIGEST_BUDGET);
    const recentEntries = entries.slice(-recentEntryLimit);
    const olderEntries = entries.slice(0, Math.max(0, entries.length - recentEntries.length));
    const focusFiles = buildFocusFileTokens(options.focusFilePaths ?? []);
    const focusTerms = tokenizeFocusText(options.focusText);

    const relevantOlderEntries = olderEntries
      .map((entry) => ({
        entry,
        score: scoreLifetimeEntryForFocus(entry, focusFiles, focusTerms),
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || b.entry.createdAt.localeCompare(a.entry.createdAt))
      .slice(0, relevantOlderEntryLimit)
      .map((candidate) => candidate.entry)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const highlightedKeys = new Set(
      relevantOlderEntries.map((entry) => `${entry.createdAt} ${entry.filePath} ${entry.summary}`),
    );
    const rolledUpOlderEntries = olderEntries.filter(
      (entry) => !highlightedKeys.has(`${entry.createdAt} ${entry.filePath} ${entry.summary}`),
    );

    const lines: string[] = [
      `Total commits by ${trimmedAuthorName || 'this agent'}: ${totalCount}`,
      `Prompt digest: ${recentEntries.length} recent entr${recentEntries.length === 1 ? 'y' : 'ies'} shown verbatim-by-meaning${relevantOlderEntries.length > 0 ? `, ${relevantOlderEntries.length} context-relevant older highlight${relevantOlderEntries.length === 1 ? '' : 's'}` : ''}${rolledUpOlderEntries.length > 0 ? `, ${rolledUpOlderEntries.length} older entr${rolledUpOlderEntries.length === 1 ? 'y' : 'ies'} summarized` : ''}.`,
      '',
      'Recent entries:',
      ...recentEntries.map(formatLifetimeEntry),
    ];

    if (relevantOlderEntries.length > 0) {
      lines.push('', 'Relevant older history:', ...relevantOlderEntries.map(formatLifetimeEntry));
    }
    if (rolledUpOlderEntries.length > 0) {
      lines.push('', formatOlderHistoryRollup(rolledUpOlderEntries));
    }

    return truncateText(lines.join('\n').trim(), sectionBudget);
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}
