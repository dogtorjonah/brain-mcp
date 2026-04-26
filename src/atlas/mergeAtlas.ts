/**
 * Atlas merge — port atlas_files metadata and atlas_changelog entries from a
 * source Atlas database (typically a git worktree) into the local Atlas.
 *
 * Three-way merge strategy:
 *   - atlas_files:    INSERT new records; UPDATE existing ones when the source
 *                     has richer metadata (non-empty blurb, purpose, etc.).
 *   - atlas_changelog: INSERT entries that don't already exist (deduped by
 *                     file_path + summary + created_at).
 *   - FTS indexes:    rebuilt for touched records.
 */

import path from 'node:path';
import fs from 'node:fs';
import type { AtlasDatabase } from './db.js';
import { backupAtlasDatabase, populateFts, populateChangelogFts } from './db.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtlasMergeResult {
  /** Number of atlas_files INSERT-ed (new records). */
  filesInserted: number;
  /** Number of atlas_files UPDATE-d with richer metadata. */
  filesUpdated: number;
  /** Number of atlas_changelog rows INSERT-ed (new entries). */
  changelogInserted: number;
  /** Path to the pre-merge backup (null if skipped). */
  backupPath: string | null;
}

export interface AtlasMergePreview {
  filesInserted: number;
  filesUpdated: number;
  changelogInserted: number;
  /** File paths that would be inserted as new atlas_files records. */
  newFilePaths: string[];
  /** File paths that would be updated with richer metadata. */
  updatedFilePaths: string[];
  /** Preview of changelog entries that would be ported (truncated summaries). */
  changelogPreview: Array<{ file_path: string; summary: string; created_at: string }>;
}

// ---------------------------------------------------------------------------
// Merge logic
// ---------------------------------------------------------------------------

/**
 * Find all git worktrees that have an `.atlas/atlas.sqlite` and return
 * their paths plus the worktree branch name.
 */
export function discoverWorktreeAtlases(sourceRoot: string): Array<{
  worktreePath: string;
  dbPath: string;
  branch: string;
}> {
  const results: Array<{
    worktreePath: string;
    dbPath: string;
    branch: string;
  }> = [];

  const worktreesDir = path.join(sourceRoot, '.voxxo-swarm', 'worktrees', 'chambers');
  if (!fs.existsSync(worktreesDir)) return results;

  try {
    const chambers = fs.readdirSync(worktreesDir, { withFileTypes: true });
    for (const chamber of chambers) {
      if (!chamber.isDirectory()) continue;
      const sharedDir = path.join(worktreesDir, chamber.name, 'shared');
      const atlasPath = path.join(sharedDir, '.atlas', 'atlas.sqlite');
      if (!fs.existsSync(atlasPath)) continue;

      // Extract branch name from the directory structure: evolve/<id>
      const branch = `evolve/${chamber.name}`;
      results.push({
        worktreePath: sharedDir,
        dbPath: atlasPath,
        branch,
      });
    }
  } catch {
    // permission errors etc.
  }

  return results;
}

/**
 * Resolve a source Atlas DB path from either a branch name, a worktree ID,
 * or an explicit path.
 */
export function resolveSourceDb(
  sourceRoot: string,
  source: string,
): { dbPath: string; label: string } | { error: string } {
  // 1. Explicit path (absolute or relative to sourceRoot)
  if (source.startsWith('/') || source.startsWith('./') || source.endsWith('.sqlite')) {
    const absPath = path.resolve(sourceRoot, source);
    if (!fs.existsSync(absPath)) {
      return { error: `Source database not found: ${absPath}` };
    }
    return { dbPath: absPath, label: absPath };
  }

  // 2. Full branch name like "evolve/TABNDPgU1Ne8" or just the ID "TABNDPgU1Ne8"
  const chamberId = source.startsWith('evolve/') ? source.slice(7) : source;
  const worktreeDir = path.join(
    sourceRoot,
    '.voxxo-swarm', 'worktrees', 'chambers', chamberId, 'shared',
  );
  const atlasPath = path.join(worktreeDir, '.atlas', 'atlas.sqlite');
  if (!fs.existsSync(atlasPath)) {
    // Try listing available worktrees
    const available = discoverWorktreeAtlases(sourceRoot);
    if (available.length === 0) {
      return { error: `No worktree Atlas databases found. Pass an explicit path or worktree ID.` };
    }
    const names = available.map((w) => w.branch).join(', ');
    return { error: `Worktree "${source}" not found. Available: ${names}` };
  }

  return { dbPath: atlasPath, label: `evolve/${chamberId}` };
}

/**
 * Open a source database read-only and ATTACH it to the target for cross-DB queries.
 * Returns cleanup function.
 */
function attachSourceDb(
  targetDb: AtlasDatabase,
  sourceDbPath: string,
): { sourceAlias: string; detach: () => void } {
  const sourceAlias = 'source_atlas';
  targetDb.exec(`ATTACH '${sourceDbPath.replace(/'/g, "''")}' AS ${sourceAlias}`);
  return {
    sourceAlias,
    detach: () => {
      try { targetDb.exec(`DETACH DATABASE ${sourceAlias}`); } catch { /* ignore */ }
    },
  };
}

/**
 * Merge atlas_files from source into target.
 * - INSERT new records (files not in target at all).
 * - UPDATE existing records where source has richer metadata.
 */
function mergeAtlasFiles(
  targetDb: AtlasDatabase,
  sourceAlias: string,
  apply: boolean,
): { inserted: number; updated: number; newFilePaths: string[]; updatedFilePaths: string[] } {
  // --- INSERT new records ---
  const insertSql = apply
    ? `INSERT OR IGNORE INTO atlas_files (
         workspace, file_path, file_hash, cluster, loc, blurb, purpose,
         public_api, exports, patterns, dependencies, data_flows, key_types,
         hazards, conventions, cross_refs, language, extraction_model,
         last_extracted, created_at, updated_at, source_highlights
       )
       SELECT
         s.workspace, s.file_path, s.file_hash, s.cluster, s.loc, s.blurb, s.purpose,
         s.public_api, s.exports, s.patterns, s.dependencies, s.data_flows, s.key_types,
         s.hazards, s.conventions, s.cross_refs, s.language, s.extraction_model,
         s.last_extracted, s.created_at, s.updated_at, s.source_highlights
       FROM ${sourceAlias}.atlas_files AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_files AS t
         WHERE t.workspace = s.workspace AND t.file_path = s.file_path
       )`
    : `SELECT COUNT(*) AS cnt FROM ${sourceAlias}.atlas_files AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_files AS t
         WHERE t.workspace = s.workspace AND t.file_path = s.file_path
       )`;

  let inserted = 0;
  const newFilePaths: string[] = [];

  if (apply) {
    const result = targetDb.prepare(insertSql).run() as { changes?: number };
    inserted = Number(result.changes ?? 0);

    // Collect the new file paths for reporting
    const newRows = targetDb.prepare(
      `SELECT s.file_path FROM ${sourceAlias}.atlas_files AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_files AS t
         WHERE t.workspace = s.workspace AND t.file_path = s.file_path
         AND t.id IS NOT NULL
       )
       ORDER BY s.file_path`,
    ).all() as Array<{ file_path: string }>;
    // Note: after insert they now exist, so the NOT EXISTS above returns nothing.
    // Instead, let's track by counting diff.
  } else {
    const row = targetDb.prepare(insertSql).get() as { cnt: number } | undefined;
    inserted = row?.cnt ?? 0;
  }

  // Get new file paths (preview or post-insert)
  if (!apply) {
    const paths = targetDb.prepare(
      `SELECT s.file_path FROM ${sourceAlias}.atlas_files AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_files AS t
         WHERE t.workspace = s.workspace AND t.file_path = s.file_path
       )
       ORDER BY s.file_path`,
    ).all() as Array<{ file_path: string }>;
    newFilePaths.push(...paths.map((r) => r.file_path));
  }

  // --- UPDATE existing records with richer metadata ---
  let updated = 0;
  const updatedFilePaths: string[] = [];

  if (apply) {
    const updateResult = targetDb.prepare(
      `UPDATE atlas_files SET
         blurb = CASE
           WHEN COALESCE(NULLIF(s.blurb, ''), '') <> '' AND (atlas_files.blurb IS NULL OR atlas_files.blurb = '')
           THEN s.blurb ELSE atlas_files.blurb END,
         purpose = CASE
           WHEN COALESCE(NULLIF(s.purpose, ''), '') <> '' AND (atlas_files.purpose IS NULL OR atlas_files.purpose = '')
           THEN s.purpose ELSE atlas_files.purpose END,
         public_api = CASE
           WHEN s.public_api NOT IN ('[]', '') AND atlas_files.public_api IN ('[]', '')
           THEN s.public_api ELSE atlas_files.public_api END,
         exports = CASE
           WHEN s.exports NOT IN ('[]', '') AND atlas_files.exports IN ('[]', '')
           THEN s.exports ELSE atlas_files.exports END,
         patterns = CASE
           WHEN s.patterns NOT IN ('[]', '') AND atlas_files.patterns IN ('[]', '')
           THEN s.patterns ELSE atlas_files.patterns END,
         data_flows = CASE
           WHEN s.data_flows NOT IN ('[]', '') AND atlas_files.data_flows IN ('[]', '')
           THEN s.data_flows ELSE atlas_files.data_flows END,
         key_types = CASE
           WHEN s.key_types NOT IN ('[]', '') AND atlas_files.key_types IN ('[]', '')
           THEN s.key_types ELSE atlas_files.key_types END,
         hazards = CASE
           WHEN s.hazards NOT IN ('[]', '') AND atlas_files.hazards IN ('[]', '')
           THEN s.hazards ELSE atlas_files.hazards END,
         conventions = CASE
           WHEN s.conventions NOT IN ('[]', '') AND atlas_files.conventions IN ('[]', '')
           THEN s.conventions ELSE atlas_files.conventions END,
         source_highlights = CASE
           WHEN s.source_highlights NOT IN ('[]', '') AND atlas_files.source_highlights IN ('[]', '')
           THEN s.source_highlights ELSE atlas_files.source_highlights END,
         cross_refs = CASE
           WHEN s.cross_refs NOT IN ('null', '{}', '') AND atlas_files.cross_refs IN ('null', '{}', '')
           THEN s.cross_refs ELSE atlas_files.cross_refs END,
         extraction_model = COALESCE(s.extraction_model, atlas_files.extraction_model),
         last_extracted = COALESCE(s.last_extracted, atlas_files.last_extracted),
         updated_at = CASE
           WHEN s.updated_at > atlas_files.updated_at THEN s.updated_at
           ELSE atlas_files.updated_at END
       FROM ${sourceAlias}.atlas_files AS s
       WHERE atlas_files.workspace = s.workspace
         AND atlas_files.file_path = s.file_path
         AND (
           (COALESCE(NULLIF(s.blurb, ''), '') <> '' AND (atlas_files.blurb IS NULL OR atlas_files.blurb = ''))
           OR (COALESCE(NULLIF(s.purpose, ''), '') <> '' AND (atlas_files.purpose IS NULL OR atlas_files.purpose = ''))
           OR (s.public_api NOT IN ('[]', '') AND atlas_files.public_api IN ('[]', ''))
           OR (s.patterns NOT IN ('[]', '') AND atlas_files.patterns IN ('[]', ''))
           OR (s.hazards NOT IN ('[]', '') AND atlas_files.hazards IN ('[]', ''))
           OR (s.data_flows NOT IN ('[]', '') AND atlas_files.data_flows IN ('[]', ''))
           OR (s.key_types NOT IN ('[]', '') AND atlas_files.key_types IN ('[]', ''))
           OR (s.conventions NOT IN ('[]', '') AND atlas_files.conventions IN ('[]', ''))
           OR (s.source_highlights NOT IN ('[]', '') AND atlas_files.source_highlights IN ('[]', ''))
           OR (s.cross_refs NOT IN ('null', '{}', '') AND atlas_files.cross_refs IN ('null', '{}', ''))
         )`,
    ).run() as { changes?: number };
    updated = Number(updateResult.changes ?? 0);
  } else {
    // Preview: count how many would be updated
    const countRow = targetDb.prepare(
      `SELECT COUNT(*) AS cnt FROM atlas_files
       JOIN ${sourceAlias}.atlas_files AS s
         ON atlas_files.workspace = s.workspace AND atlas_files.file_path = s.file_path
       WHERE (
         (COALESCE(NULLIF(s.blurb, ''), '') <> '' AND (atlas_files.blurb IS NULL OR atlas_files.blurb = ''))
         OR (COALESCE(NULLIF(s.purpose, ''), '') <> '' AND (atlas_files.purpose IS NULL OR atlas_files.purpose = ''))
         OR (s.public_api NOT IN ('[]', '') AND atlas_files.public_api IN ('[]', ''))
         OR (s.patterns NOT IN ('[]', '') AND atlas_files.patterns IN ('[]', ''))
         OR (s.hazards NOT IN ('[]', '') AND atlas_files.hazards IN ('[]', ''))
         OR (s.data_flows NOT IN ('[]', '') AND atlas_files.data_flows IN ('[]', ''))
         OR (s.key_types NOT IN ('[]', '') AND atlas_files.key_types IN ('[]', ''))
         OR (s.conventions NOT IN ('[]', '') AND atlas_files.conventions IN ('[]', ''))
         OR (s.source_highlights NOT IN ('[]', '') AND atlas_files.source_highlights IN ('[]', ''))
         OR (s.cross_refs NOT IN ('null', '{}', '') AND atlas_files.cross_refs IN ('null', '{}', ''))
       )`,
    ).get() as { cnt: number } | undefined;
    updated = countRow?.cnt ?? 0;

    // Collect which files would be updated
    const updatePaths = targetDb.prepare(
      `SELECT atlas_files.file_path FROM atlas_files
       JOIN ${sourceAlias}.atlas_files AS s
         ON atlas_files.workspace = s.workspace AND atlas_files.file_path = s.file_path
       WHERE (
         (COALESCE(NULLIF(s.blurb, ''), '') <> '' AND (atlas_files.blurb IS NULL OR atlas_files.blurb = ''))
         OR (COALESCE(NULLIF(s.purpose, ''), '') <> '' AND (atlas_files.purpose IS NULL OR atlas_files.purpose = ''))
         OR (s.public_api NOT IN ('[]', '') AND atlas_files.public_api IN ('[]', ''))
         OR (s.patterns NOT IN ('[]', '') AND atlas_files.patterns IN ('[]', ''))
         OR (s.hazards NOT IN ('[]', '') AND atlas_files.hazards IN ('[]', ''))
         OR (s.data_flows NOT IN ('[]', '') AND atlas_files.data_flows IN ('[]', ''))
         OR (s.key_types NOT IN ('[]', '') AND atlas_files.key_types IN ('[]', ''))
         OR (s.conventions NOT IN ('[]', '') AND atlas_files.conventions IN ('[]', ''))
         OR (s.source_highlights NOT IN ('[]', '') AND atlas_files.source_highlights IN ('[]', ''))
         OR (s.cross_refs NOT IN ('null', '{}', '') AND atlas_files.cross_refs IN ('null', '{}', ''))
       )
       ORDER BY atlas_files.file_path`,
    ).all() as Array<{ file_path: string }>;
    updatedFilePaths.push(...updatePaths.map((r) => r.file_path));
  }

  return { inserted, updated, newFilePaths, updatedFilePaths };
}

/**
 * Merge atlas_changelog entries from source into target.
 * Deduplicates by file_path + summary + created_at.
 */
function mergeAtlasChangelog(
  targetDb: AtlasDatabase,
  sourceAlias: string,
  apply: boolean,
): { inserted: number; preview: Array<{ file_path: string; summary: string; created_at: string }> } {
  const dedupCondition = `
    m.file_path = s.file_path
    AND m.summary = s.summary
    AND m.created_at = s.created_at
  `;

  if (apply) {
    const result = targetDb.prepare(
      `INSERT INTO atlas_changelog (
         workspace, file_path, summary, patterns_added, patterns_removed,
         hazards_added, hazards_removed, cluster, breaking_changes, commit_sha,
         author_instance_id, author_engine, author_name, review_entry_id, source,
         verification_status, verification_notes, recovery_key, created_at
       )
       SELECT
         s.workspace, s.file_path, s.summary, s.patterns_added, s.patterns_removed,
         s.hazards_added, s.hazards_removed, s.cluster, s.breaking_changes, s.commit_sha,
         s.author_instance_id, s.author_engine, s.author_name, s.review_entry_id, s.source,
         s.verification_status, s.verification_notes, s.recovery_key, s.created_at
       FROM ${sourceAlias}.atlas_changelog AS s
       WHERE NOT EXISTS (
         SELECT 1 FROM atlas_changelog AS m WHERE ${dedupCondition}
       )`,
    ).run() as { changes?: number };

    const inserted = Number(result.changes ?? 0);
    return { inserted, preview: [] };
  }

  // Preview
  const rows = targetDb.prepare(
    `SELECT s.file_path, substr(s.summary, 1, 120) AS summary, s.created_at
     FROM ${sourceAlias}.atlas_changelog AS s
     WHERE NOT EXISTS (
       SELECT 1 FROM atlas_changelog AS m WHERE ${dedupCondition}
     )
     ORDER BY s.created_at`,
  ).all() as Array<{ file_path: string; summary: string; created_at: string }>;

  return { inserted: rows.length, preview: rows };
}

/**
 * Rebuild FTS entries for all records that were touched by the merge.
 */
function rebuildFtsForMergedRecords(targetDb: AtlasDatabase): void {
  // Rebuild file FTS for all files (conservative but safe)
  const fileIds = targetDb.prepare(
    'SELECT id FROM atlas_files ORDER BY id ASC',
  ).all() as Array<{ id: number }>;
  for (const row of fileIds) {
    try { populateFts(targetDb, row.id); } catch { /* ignore */ }
  }

  // Rebuild changelog FTS for all entries
  const changelogIds = targetDb.prepare(
    'SELECT id FROM atlas_changelog ORDER BY id ASC',
  ).all() as Array<{ id: number }>;
  for (const row of changelogIds) {
    try { populateChangelogFts(targetDb, row.id); } catch { /* ignore */ }
  }
}

/**
 * Lightweight FTS rebuild — only rebuild entries that were actually inserted
 * by looking at the max IDs before merge.
 */
function rebuildFtsForNewRecords(targetDb: AtlasDatabase, maxFileIdBefore: number, maxChangelogIdBefore: number): void {
  // New file FTS entries
  const newFileIds = targetDb.prepare(
    'SELECT id FROM atlas_files WHERE id > ? ORDER BY id ASC',
  ).all(maxFileIdBefore) as Array<{ id: number }>;
  for (const row of newFileIds) {
    try { populateFts(targetDb, row.id); } catch { /* ignore */ }
  }

  // Updated file FTS entries — we need to refresh FTS for any file whose
  // metadata was updated. For simplicity, rebuild all files that existed
  // before (since we can't easily track which ones were updated).
  // This is still fast because populateFts is a simple DELETE+INSERT.
  const existingFileIds = targetDb.prepare(
    'SELECT id FROM atlas_files WHERE id <= ? ORDER BY id ASC',
  ).all(maxFileIdBefore) as Array<{ id: number }>;
  for (const row of existingFileIds) {
    try { populateFts(targetDb, row.id); } catch { /* ignore */ }
  }

  // New changelog FTS entries
  const newChangelogIds = targetDb.prepare(
    'SELECT id FROM atlas_changelog WHERE id > ? ORDER BY id ASC',
  ).all(maxChangelogIdBefore) as Array<{ id: number }>;
  for (const row of newChangelogIds) {
    try { populateChangelogFts(targetDb, row.id); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run an Atlas merge from a source database into the local Atlas.
 * Returns a preview when apply=false, or applies the merge when apply=true.
 */
export function runAtlasMerge(
  targetDb: AtlasDatabase,
  sourceDbPath: string,
  targetDbPath: string,
  options: { apply: boolean },
): AtlasMergePreview | AtlasMergeResult {
  const { apply } = options;

  // Capture max IDs before merge for targeted FTS rebuild
  let maxFileIdBefore = 0;
  let maxChangelogIdBefore = 0;
  if (apply) {
    const fileIdRow = targetDb.prepare('SELECT MAX(id) AS max_id FROM atlas_files').get() as { max_id: number | null } | undefined;
    maxFileIdBefore = fileIdRow?.max_id ?? 0;
    const changelogIdRow = targetDb.prepare('SELECT MAX(id) AS max_id FROM atlas_changelog').get() as { max_id: number | null } | undefined;
    maxChangelogIdBefore = changelogIdRow?.max_id ?? 0;
  }

  const { sourceAlias, detach } = attachSourceDb(targetDb, sourceDbPath);
  try {
    const fileResult = mergeAtlasFiles(targetDb, sourceAlias, apply);
    const changelogResult = mergeAtlasChangelog(targetDb, sourceAlias, apply);

    if (apply) {
      // Rebuild FTS for new/updated records
      rebuildFtsForNewRecords(targetDb, maxFileIdBefore, maxChangelogIdBefore);

      return {
        filesInserted: fileResult.inserted,
        filesUpdated: fileResult.updated,
        changelogInserted: changelogResult.inserted,
        backupPath: null, // caller sets this
      };
    }

    return {
      filesInserted: fileResult.inserted,
      filesUpdated: fileResult.updated,
      changelogInserted: changelogResult.inserted,
      newFilePaths: fileResult.newFilePaths,
      updatedFilePaths: fileResult.updatedFilePaths,
      changelogPreview: changelogResult.preview,
    };
  } finally {
    detach();
  }
}

/**
 * Format a merge preview or result for display.
 */
export function formatAtlasMergeResult(
  result: AtlasMergePreview | AtlasMergeResult,
  sourceLabel: string,
  options: { dryRun: boolean },
): string {
  const { dryRun } = options;
  const lines: string[] = [];

  if (dryRun) {
    lines.push(`📋 Atlas merge preview — source: ${sourceLabel}`);
  } else {
    lines.push(`✅ Atlas merge applied — source: ${sourceLabel}`);
  }

  lines.push('');
  lines.push(`  atlas_files:`);
  lines.push(`    New records:    ${result.filesInserted}`);
  lines.push(`    Updated (richer metadata): ${result.filesUpdated}`);

  lines.push('');
  lines.push(`  atlas_changelog:`);
  lines.push(`    New entries:    ${result.changelogInserted}`);

  // Preview-specific details
  if ('newFilePaths' in result && result.newFilePaths.length > 0) {
    lines.push('');
    lines.push('  New files to be inserted:');
    for (const fp of result.newFilePaths) {
      lines.push(`    + ${fp}`);
    }
  }

  if ('updatedFilePaths' in result && result.updatedFilePaths.length > 0) {
    lines.push('');
    lines.push('  Files getting richer metadata:');
    for (const fp of result.updatedFilePaths.slice(0, 30)) {
      lines.push(`    ↗ ${fp}`);
    }
    if (result.updatedFilePaths.length > 30) {
      lines.push(`    ... and ${result.updatedFilePaths.length - 30} more`);
    }
  }

  if ('changelogPreview' in result && result.changelogPreview.length > 0) {
    lines.push('');
    lines.push(`  Sample changelog entries to port (showing first 10 of ${result.changelogPreview.length}):`);
    for (const entry of result.changelogPreview.slice(0, 10)) {
      const summary = entry.summary.length > 80 ? entry.summary.slice(0, 77) + '...' : entry.summary;
      lines.push(`    [${entry.created_at}] ${entry.file_path}: ${summary}`);
    }
    if (result.changelogPreview.length > 10) {
      lines.push(`    ... and ${result.changelogPreview.length - 10} more`);
    }
  }

  if (!('backupPath' in result) || !result.backupPath) {
    lines.push('');
    if (dryRun) {
      lines.push('Call with confirm=true to apply the merge. A backup will be created automatically.');
    }
  } else {
    lines.push(`  Backup: ${result.backupPath}`);
  }

  return lines.join('\n');
}
