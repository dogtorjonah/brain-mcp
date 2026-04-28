import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import { DEFAULT_EMBED_CONFIG } from '../persistence/denseRetrieval/types.js';

const require = createRequire(import.meta.url);
import type {
  AtlasCrossRefs,
  AtlasFileRecord,
  AtlasMetaRecord,
  AtlasQueueRecord,
  AtlasSourceChunk,
  AtlasSourceChunkKind,
  SourceHighlight,
} from './types.js';

export interface AtlasStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface AtlasDatabase {
  prepare(sql: string): AtlasStatement;
  pragma(sql: string): unknown;
  exec(sql: string): unknown;
  loadExtension(extensionPath: string): unknown;
  transaction<F extends (...args: any[]) => unknown>(fn: F): any;
  close(): void;
}

export interface AtlasSearchHit {
  file: AtlasFileRecord;
  rank: number;
  score: number;
  source: 'fts' | 'vector';
}

export interface AtlasExportRow {
  file: AtlasFileRecord;
  embedding: number[] | null;
}

export interface AtlasChangelogRecord {
  id: number;
  workspace: string;
  file_path: string;
  summary: string;
  patterns_added: string[];
  patterns_removed: string[];
  hazards_added: string[];
  hazards_removed: string[];
  cluster: string | null;
  breaking_changes: boolean;
  commit_sha: string | null;
  author_instance_id: string | null;
  author_engine: string | null;
  author_name: string | null;
  author_identity: string | null;
  review_entry_id: string | null;
  source: string;
  verification_status: string;
  verification_notes: string | null;
  created_at: string;
}

export interface AtlasChangelogInsertInput {
  workspace: string;
  file_path: string;
  summary: string;
  patterns_added?: string[];
  patterns_removed?: string[];
  hazards_added?: string[];
  hazards_removed?: string[];
  cluster?: string | null;
  breaking_changes?: boolean;
  commit_sha?: string | null;
  author_instance_id?: string | null;
  author_engine?: string | null;
  author_name?: string | null;
  author_identity?: string | null;
  review_entry_id?: string | null;
  source?: string;
  verification_status?: string;
  verification_notes?: string | null;
  recovery_key?: string | null;
  created_at?: string | null;
}

export interface AtlasChangelogAuthorBackfillInput {
  id: number;
  author_instance_id: string;
  author_engine?: string | null;
  author_name?: string | null;
}

export interface AtlasChangelogQuery {
  workspace: string;
  file?: string;
  file_prefix?: string;
  query?: string;
  cluster?: string;
  author_instance_id?: string;
  author_engine?: string;
  author_name?: string;
  author_identity?: string;
  since?: string;
  until?: string;
  verification_status?: string;
  breaking_only?: boolean;
  limit?: number;
}

export interface AtlasChangelogSearchHit {
  record: AtlasChangelogRecord;
  rank: number;
  score: number;
  source: 'fts' | 'vector';
}

export interface AtlasSourceChunkRecord {
  id: number;
  workspace: string;
  file_id: number;
  file_path: string;
  kind: AtlasSourceChunkKind;
  label: string | null;
  startLine: number;
  endLine: number;
  content: string;
  textHash: string;
}

export interface AtlasSourceChunkSearchHit {
  chunk: AtlasSourceChunkRecord;
  rank: number;
  score: number;
  source: 'vector';
}

export interface AtlasDbOptions {
  dbPath: string;
  migrationDir: string;
  sqliteVecExtension?: string;
  embeddingDimensions?: number;
  /**
   * If false (default), `openAtlasDatabase` throws `AtlasNotInitializedError`
   * when the file does not yet exist. Set true only from the explicit init/reset
   * paths so other tool calls can't silently scaffold a DB in the wrong cwd.
   */
  allowCreate?: boolean;
  /**
   * Source root for stamping the brain-mcp owner marker on first creation.
   * Defaults to dirname(dirname(dbPath)) (i.e. the repo root above `.brain/`).
   */
  sourceRoot?: string;
  /**
   * Forcibly claim an existing un-marked DB as brain-mcp's. Used by
   * `atlas_admin action=init force=true` to adopt legacy DBs.
   */
  forceClaim?: boolean;
}

export const ATLAS_OWNER_MARKER_WORKSPACE = '__brain_mcp_owner__';
export const ATLAS_OWNER_PROVIDER = 'brain-mcp';

export class AtlasNotInitializedError extends Error {
  constructor(public readonly dbPath: string) {
    super(
      `Atlas not initialized at ${dbPath}. ` +
      `Run \`atlas_admin action=init confirm=true\` to bootstrap a fresh atlas for this workspace.`,
    );
    this.name = 'AtlasNotInitializedError';
  }
}

export class ForeignAtlasError extends Error {
  constructor(public readonly dbPath: string, public readonly foreignProvider: string | null) {
    const reason = foreignProvider
      ? `it is owned by provider="${foreignProvider}"`
      : `it has data but no brain-mcp owner marker`;
    super(
      `Refusing to open atlas DB at ${dbPath}: ${reason}. ` +
      `Either move the foreign DB out of the way, or run ` +
      `\`atlas_admin action=init force=true confirm=true\` to claim it.`,
    );
    this.name = 'ForeignAtlasError';
  }
}

export interface AtlasImportEdgeRecord {
  workspace: string;
  source_file: string;
  target_file: string;
}

export type AtlasSymbolKind =
  | 'function'
  | 'class'
  | 'type'
  | 'interface'
  | 'const'
  | 'enum'
  | 'namespace'
  | 're-export'
  | 'value'
  | 'default'
  | 'unknown';

export interface AtlasSymbolRecord {
  id: number;
  workspace: string;
  file_path: string;
  name: string;
  kind: AtlasSymbolKind;
  exported: boolean;
  line_start: number | null;
  line_end: number | null;
  signature_hash: string | null;
}

export interface AtlasReferenceRecord {
  id: number;
  workspace: string;
  source_symbol_id: number | null;
  target_symbol_id: number | null;
  edge_type: string;
  source_file: string;
  target_file: string;
  usage_count: number;
  confidence: number;
  provenance: string;
  last_verified: string | null;
}

export interface AtlasSymbolUpsertInput {
  workspace: string;
  file_path: string;
  name: string;
  kind: string;
  exported?: boolean;
  line_start?: number | null;
  line_end?: number | null;
  signature_hash?: string | null;
}

export interface AtlasMetaUpsertInput {
  workspace: string;
  source_root: string;
  brain_version?: string | null;
}

export interface AtlasFileUpsertInput {
  workspace: string;
  file_path: string;
  file_hash?: string | null;
  cluster?: string | null;
  loc?: number;
  blurb?: string;
  purpose?: string;
  public_api?: unknown[];
  exports?: Array<{ name: string; type: string }>;
  patterns?: string[];
  dependencies?: Record<string, unknown>;
  data_flows?: string[];
  key_types?: unknown[];
  hazards?: string[];
  conventions?: string[];
  cross_refs?: AtlasCrossRefs | null;
  source_highlights?: SourceHighlight[];
  language?: string;
  extraction_model?: string | null;
  last_extracted?: string | null;
}

function ensureDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readMigrationFiles(migrationDir: string): string[] {
  if (!fs.existsSync(migrationDir)) {
    return [];
  }
  return fs.readdirSync(migrationDir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => path.join(migrationDir, name));
}

function resolveSqliteVecPath(explicit?: string): string | null {
  if (explicit) return explicit;
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') return sv.getLoadablePath();
  } catch { /* not installed */ }
  return null;
}

function loadSqliteVec(db: AtlasDatabase, extensionPath?: string): boolean {
  const vecPath = resolveSqliteVecPath(extensionPath);
  if (!vecPath) {
    console.warn('[atlas] sqlite-vec extension not found — vector search will be unavailable');
    return false;
  }

  try {
    db.loadExtension(vecPath);
    return true;
  } catch (err) {
    console.warn(`[atlas] Failed to load sqlite-vec from ${vecPath}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

function healVec0Table(
  db: AtlasDatabase,
  tableName: 'atlas_embeddings' | 'atlas_changelog_embeddings' | 'atlas_source_chunk_embeddings',
  idColumn: 'file_id' | 'changelog_id' | 'chunk_id',
  embeddingDimensions: number,
): void {
  try {
    // Probe with a real insert + immediate delete.
    // vec0 v0.1.x requires integer primary keys as SQL literals, not bound params.
    db.prepare(`INSERT INTO ${tableName} (${idColumn}, embedding) VALUES (-1, ?)`)
      .run(JSON.stringify(new Array(embeddingDimensions).fill(0)));
    db.prepare(`DELETE FROM ${tableName} WHERE ${idColumn} = -1`).run();
  } catch {
    // Probe failed — table is broken. Recreate it.
    console.warn(`[atlas] ${tableName} vec0 table is non-functional — recreating`);
    try {
      db.exec(`DROP TABLE IF EXISTS ${tableName}`);
      db.exec(
        `CREATE VIRTUAL TABLE ${tableName} USING vec0(${idColumn} INTEGER PRIMARY KEY, embedding float[${embeddingDimensions}])`,
      );
      console.log(`[atlas] ${tableName} vec0 table recreated successfully`);
    } catch (err) {
      console.warn(`[atlas] Failed to recreate ${tableName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function resolveEmbeddingDimensions(explicit?: number): number {
  return Number.isFinite(explicit) && (explicit as number) > 0
    ? Math.floor(explicit as number)
    : DEFAULT_EMBED_CONFIG.dimensions;
}

function rewriteVecDimensions(sql: string, embeddingDimensions: number): string {
  return sql.replace(/float\[\d+\]/g, `float[${embeddingDimensions}]`);
}

// Minimum interval between auto-backups (1 hour).
// Each process that opens the DB checks — only creates a backup if the newest
// existing backup is older than this threshold.
const AUTO_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

function shouldAutoBackup(dbPath: string): boolean {
  const atlasDir = path.dirname(dbPath);
  const backupDir = path.join(atlasDir, 'backups');
  const basename = path.basename(dbPath, '.sqlite');
  try {
    if (!fs.existsSync(backupDir)) return true;
    const backups = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(basename) && f.endsWith('.sqlite'))
      .sort()
      .reverse();
    if (backups.length === 0) return true;
    const newestPath = path.join(backupDir, backups[0]!);
    const stat = fs.statSync(newestPath);
    return Date.now() - stat.mtimeMs > AUTO_BACKUP_INTERVAL_MS;
  } catch {
    return true;
  }
}

export function openAtlasDatabase(options: AtlasDbOptions): AtlasDatabase {
  const dbExisted = fs.existsSync(options.dbPath);
  if (!dbExisted && !options.allowCreate) {
    throw new AtlasNotInitializedError(options.dbPath);
  }
  ensureDirectory(options.dbPath);
  const embeddingDimensions = resolveEmbeddingDimensions(options.embeddingDimensions);

  // Auto-backup on open — creates a safe snapshot if no recent backup exists.
  // This runs BEFORE opening the DB for writes, so if corruption has already
  // occurred we don't overwrite a good backup with a bad one.
  if (shouldAutoBackup(options.dbPath)) {
    try {
      // Quick integrity check before backing up — don't backup a corrupt DB
      const probeDb = new Database(options.dbPath, { readonly: true });
      const result = probeDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
      const isHealthy = result.length === 1 && result[0]?.integrity_check === 'ok';
      probeDb.close();
      if (isHealthy) {
        backupAtlasDatabase(options.dbPath);
        console.log('[atlas] Auto-backup created on open (healthy DB confirmed)');
      } else {
        console.warn('[atlas] Skipping auto-backup — integrity check failed. DB may be corrupt.');
      }
    } catch (err) {
      console.warn(`[atlas] Auto-backup skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const db = new Database(options.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Prevent SQLITE_BUSY errors under concurrent multi-process access:
  // Wait up to 30 seconds for locks instead of failing immediately.
  db.pragma('busy_timeout = 30000');
  // NORMAL sync is safe with WAL — fsync on checkpoint only, not every commit.
  // This avoids the corruption risk of WAL + synchronous=OFF while keeping good perf.
  db.pragma('synchronous = NORMAL');
  // Limit WAL file growth — auto-checkpoint every 1000 pages (~4MB).
  // Prevents unbounded WAL growth when many writers are active.
  db.pragma('wal_autocheckpoint = 1000');
  const vecLoaded = loadSqliteVec(db, options.sqliteVecExtension);

  // Migration tracking — only run each migration file once
  db.exec(`CREATE TABLE IF NOT EXISTS atlas_schema_migrations (
    filename TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const appliedSet = new Set(
    (db.prepare('SELECT filename FROM atlas_schema_migrations').all() as { filename: string }[])
      .map((r) => r.filename),
  );

  for (const migrationPath of readMigrationFiles(options.migrationDir)) {
    const filename = path.basename(migrationPath);
    if (appliedSet.has(filename)) continue;

    const sql = fs.readFileSync(migrationPath, 'utf8');
    // Run everything except vec0 statements first, then attempt vec0 separately
    const vec0Pattern = /CREATE\s+VIRTUAL\s+TABLE[^;]*USING\s+vec0\s*\([^)]*\)\s*;/gi;
    const vec0Statements = sql.match(vec0Pattern) ?? [];
    const sqlWithoutVec0 = sql.replace(vec0Pattern, '');

    try {
      db.exec(sqlWithoutVec0);
    } catch (err) {
      // Bootstrap tolerance: existing DBs won't have the tracking table yet,
      // so we may re-run migrations whose effects already exist (e.g., ALTER TABLE
      // ADD COLUMN on a column that's already there). Treat as already-applied.
      if (err instanceof Error && /duplicate column name|already exists/i.test(err.message)) {
        console.log(`[atlas] Migration ${filename} already applied (bootstrap) — skipping`);
        db.prepare('INSERT INTO atlas_schema_migrations (filename) VALUES (?)').run(filename);
        continue;
      }
      throw err;
    }

    for (const vec0Stmt of vec0Statements) {
      try {
        db.exec(rewriteVecDimensions(vec0Stmt, embeddingDimensions));
      } catch {
        console.warn('[atlas] Skipping vec0 table — sqlite-vec extension not available');
      }
    }

    db.prepare('INSERT INTO atlas_schema_migrations (filename) VALUES (?)').run(filename);
  }

  // If the extension loaded, verify the vec0 table is functional and heal if needed
  if (vecLoaded) {
    healVec0Table(db, 'atlas_embeddings', 'file_id', embeddingDimensions);
    healVec0Table(db, 'atlas_changelog_embeddings', 'changelog_id', embeddingDimensions);
    healVec0Table(db, 'atlas_source_chunk_embeddings', 'chunk_id', embeddingDimensions);
  }

  backfillSymbolsAndReferencesFromAtlasFiles(db);

  // Owner marker — refuse to operate on a DB owned by something else.
  // Empty DBs (just-created or legacy brain-mcp DBs with no data) are claimed
  // automatically. Non-empty unmarked DBs require force=true via init.
  const sourceRoot = options.sourceRoot ?? path.dirname(path.dirname(options.dbPath));
  try {
    verifyOrStampOwner(db, options.dbPath, sourceRoot, {
      allowClaim: options.forceClaim === true,
    });
  } catch (err) {
    db.close();
    throw err;
  }

  return db;
}

function readOwnerMarkerRow(db: AtlasDatabase): { provider: string | null } | null {
  try {
    const row = db
      .prepare('SELECT provider FROM atlas_meta WHERE workspace = ?')
      .get(ATLAS_OWNER_MARKER_WORKSPACE) as { provider: string | null } | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function isAtlasEmpty(db: AtlasDatabase): boolean {
  const tables = ['atlas_files', 'atlas_meta', 'atlas_changelog'] as const;
  try {
    for (const table of tables) {
      const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      if (row.n > 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function stampBrainMcpOwner(db: AtlasDatabase, sourceRoot: string): void {
  db.prepare(
    `INSERT INTO atlas_meta (workspace, source_root, provider, provider_config, brain_version, updated_at)
     VALUES (?, ?, ?, '{}', NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace) DO UPDATE SET
       source_root = excluded.source_root,
       provider = excluded.provider,
       updated_at = CURRENT_TIMESTAMP`,
  ).run(ATLAS_OWNER_MARKER_WORKSPACE, sourceRoot, ATLAS_OWNER_PROVIDER);
}

export type AtlasOwnershipState =
  | { kind: 'missing' }
  | { kind: 'fresh' }
  | { kind: 'brain_mcp'; hasData: boolean }
  | { kind: 'foreign'; provider: string | null };

/**
 * Read-only peek at a DB file to classify its ownership without going through
 * the migration / claim path. Used by cross-workspace handlers that need to
 * decide whether to refuse or proceed before opening the DB for writes.
 */
export function inspectAtlasOwnership(dbPath: string): AtlasOwnershipState {
  if (!fs.existsSync(dbPath)) return { kind: 'missing' };
  let probe: AtlasDatabase | null = null;
  try {
    probe = new Database(dbPath, { readonly: true }) as unknown as AtlasDatabase;
    const marker = readOwnerMarkerRow(probe);
    if (marker) {
      if (marker.provider === ATLAS_OWNER_PROVIDER) {
        const hasData = !isAtlasEmpty(probe);
        return { kind: 'brain_mcp', hasData };
      }
      return { kind: 'foreign', provider: marker.provider };
    }
    return isAtlasEmpty(probe) ? { kind: 'fresh' } : { kind: 'foreign', provider: null };
  } catch {
    return { kind: 'foreign', provider: null };
  } finally {
    probe?.close();
  }
}

/**
 * Returns true if the DB has the brain-mcp owner marker (or just got stamped).
 * Throws ForeignAtlasError if the DB is owned by something else, or has data
 * with no marker and `allowClaim` is false.
 */
export function verifyOrStampOwner(
  db: AtlasDatabase,
  dbPath: string,
  sourceRoot: string,
  options: { allowClaim?: boolean } = {},
): void {
  const marker = readOwnerMarkerRow(db);
  if (marker) {
    if (marker.provider === ATLAS_OWNER_PROVIDER) return;
    throw new ForeignAtlasError(dbPath, marker.provider);
  }
  if (options.allowClaim || isAtlasEmpty(db)) {
    stampBrainMcpOwner(db, sourceRoot);
    return;
  }
  throw new ForeignAtlasError(dbPath, null);
}

// ---------------------------------------------------------------------------
// Atlas backup — auto-snapshot before any destructive operation
// ---------------------------------------------------------------------------

const MAX_BACKUPS = 5;

/**
 * Create a timestamped backup of the atlas database.
 * Backups are stored in .brain/backups/ alongside the database.
 * Keeps at most MAX_BACKUPS copies, pruning oldest when exceeded.
 * Returns the backup path on success, or null if the source doesn't exist.
 */
export function backupAtlasDatabase(dbPath: string): string | null {
  if (!fs.existsSync(dbPath)) return null;

  const atlasDir = path.dirname(dbPath);
  const backupDir = path.join(atlasDir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const basename = path.basename(dbPath, '.sqlite');
  const backupPath = path.join(backupDir, `${basename}_${timestamp}.sqlite`);

  try {
    // Use SQLite's native backup API via VACUUM INTO — this is safe even when
    // other processes are actively writing. Unlike fs.copyFileSync, VACUUM INTO
    // produces a consistent, self-contained snapshot that includes all WAL data.
    // This is the ONLY correct way to backup a WAL-mode database.
    const sourceDb = new Database(dbPath, { readonly: true });
    sourceDb.pragma('busy_timeout = 5000');
    try {
      sourceDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    } finally {
      sourceDb.close();
    }
    console.log(`[atlas-backup] Backed up ${dbPath} → ${backupPath} (VACUUM INTO)`);
  } catch (err) {
    console.error(`[atlas-backup] Failed to backup ${dbPath}:`, err instanceof Error ? err.message : String(err));
    // Fallback: raw copy (better than nothing, but may be inconsistent)
    try {
      fs.copyFileSync(dbPath, backupPath);
      console.warn(`[atlas-backup] Fallback: raw file copy (may be inconsistent if WAL is active)`);
    } catch {
      return null;
    }
  }

  // Prune old backups — keep only the newest MAX_BACKUPS
  try {
    const files = fs.readdirSync(backupDir)
      .filter((f) => f.startsWith(basename) && f.endsWith('.sqlite'))
      .sort()
      .reverse();

    for (const old of files.slice(MAX_BACKUPS)) {
      const oldPath = path.join(backupDir, old);
      fs.unlinkSync(oldPath);
      // Clean up sidecar WAL if present
      try { fs.unlinkSync(`${oldPath}-wal`); } catch { /* ignore */ }
      try { fs.unlinkSync(`${oldPath}-shm`); } catch { /* ignore */ }
      console.log(`[atlas-backup] Pruned old backup: ${old}`);
    }
  } catch {
    // Non-fatal — pruning failure shouldn't block the operation
  }

  return backupPath;
}

export function deleteAtlasDatabaseFiles(dbPath: string): void {
  const sidecars = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
  for (const filePath of sidecars) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }
}

export function resetAtlasDatabase(options: AtlasDbOptions, currentDb?: AtlasDatabase): AtlasDatabase {
  // Auto-backup before destroying — always restorable
  const backupPath = backupAtlasDatabase(options.dbPath);
  if (backupPath) {
    console.log(`[atlas-reset] Pre-reset backup saved: ${backupPath}`);
  }

  if (currentDb) {
    try {
      currentDb.close();
    } catch {
      // Ignore close errors during reset; the file delete below is the source of truth.
    }
  }

  deleteAtlasDatabaseFiles(options.dbPath);
  return openAtlasDatabase({ ...options, allowCreate: true, forceClaim: true });
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.trim() === '') {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function parseEmbeddingValue(value: unknown): number[] | null {
  if (value == null) return null;

  if (Array.isArray(value)) {
    return value.every((entry) => typeof entry === 'number') ? value as number[] : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'number')
        ? parsed as number[]
        : null;
    } catch {
      return null;
    }
  }

  if (Buffer.isBuffer(value)) {
    return parseEmbeddingValue(value.toString('utf8'));
  }

  return null;
}

function stringifyFtsValue(value: unknown): string {
  if (value == null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

// Common English stopwords that poison FTS5 implicit-AND queries
const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'shall', 'can', 'need',
  'it', 'its', 'this', 'that', 'these', 'those', 'i', 'me', 'my', 'we',
  'our', 'you', 'your', 'he', 'she', 'they', 'them', 'their', 'who',
  'which', 'what', 'where', 'when', 'how', 'why', 'if', 'then', 'so',
  'no', 'not', 'all', 'each', 'every', 'any', 'some', 'such', 'only',
  'about', 'up', 'out', 'just', 'into', 'also', 'than', 'very', 'too',
]);

function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prepare a user query for FTS5 MATCH.
 * Strips punctuation, removes stopwords, uses OR semantics for NL queries.
 */
export function prepareFtsQuery(raw: string): string {
  const normalized = normalizeSearchText(raw);
  const cleaned = normalized.replace(/[?!@#$%^&*(){}[\]<>:;"'`,.|\\~/+=]/g, ' ');
  const tokens = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return '';
  return tokens.join(' OR ');
}

function ftsDocumentForRecord(record: AtlasFileRecord): Record<string, string> {
  return {
    file_path: normalizeSearchText(record.file_path),
    blurb: normalizeSearchText(record.blurb),
    purpose: normalizeSearchText(record.purpose),
    public_api: normalizeSearchText(stringifyFtsValue(record.public_api)),
    patterns: normalizeSearchText(stringifyFtsValue(record.patterns)),
    hazards: normalizeSearchText(stringifyFtsValue(record.hazards)),
    cross_refs: normalizeSearchText(stringifyFtsValue(record.cross_refs ?? {})),
  };
}

export function mapFileRecord(row: Record<string, unknown>): AtlasFileRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    file_hash: row.file_hash == null ? null : String(row.file_hash),
    cluster: row.cluster == null ? null : String(row.cluster),
    loc: Number(row.loc ?? 0),
    blurb: String(row.blurb ?? ''),
    purpose: String(row.purpose ?? ''),
    public_api: parseJson<unknown[]>(row.public_api, []),
    exports: parseJson<Array<{ name: string; type: string }>>(row.exports, []),
    patterns: parseJson<string[]>(row.patterns, []),
    dependencies: parseJson<Record<string, unknown>>(row.dependencies, {}),
    data_flows: parseJson<string[]>(row.data_flows, []),
    key_types: parseJson<unknown[]>(row.key_types, []),
    hazards: parseJson<string[]>(row.hazards, []),
    conventions: parseJson<string[]>(row.conventions, []),
    cross_refs: parseJson<AtlasCrossRefs | null>(row.cross_refs, null),
    source_highlights: (() => { const parsed = parseJson<SourceHighlight[]>(row.source_highlights, []); return Array.isArray(parsed) ? parsed : []; })(),
    language: String(row.language ?? 'typescript'),
    extraction_model: row.extraction_model == null ? null : String(row.extraction_model),
    last_extracted: row.last_extracted == null ? null : String(row.last_extracted),
  };
}

function mapSourceChunkRecord(row: Record<string, unknown>): AtlasSourceChunkRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_id: Number(row.file_id ?? 0),
    file_path: String(row.file_path ?? ''),
    kind: String(row.chunk_kind ?? 'raw') === 'highlight' ? 'highlight' : 'raw',
    label: row.label == null ? null : String(row.label),
    startLine: Number(row.start_line ?? 0),
    endLine: Number(row.end_line ?? 0),
    content: String(row.content ?? ''),
    textHash: String(row.text_hash ?? ''),
  };
}

export function mapQueueRecord(row: Record<string, unknown>): AtlasQueueRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    trigger_reason: String(row.trigger_reason ?? 'file_release'),
    queued_at: String(row.queued_at ?? ''),
    started_at: row.started_at == null ? null : String(row.started_at),
    completed_at: row.completed_at == null ? null : String(row.completed_at),
    status: String(row.status ?? 'pending'),
    error_message: row.error_message == null ? null : String(row.error_message),
  };
}

export function mapMetaRecord(row: Record<string, unknown>): AtlasMetaRecord {
  return {
    workspace: String(row.workspace ?? ''),
    source_root: String(row.source_root ?? ''),
    brain_version: row.brain_version == null ? null : String(row.brain_version),
    updated_at: String(row.updated_at ?? ''),
  };
}

export function mapChangelogRecord(row: Record<string, unknown>): AtlasChangelogRecord {
  return {
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    summary: String(row.summary ?? ''),
    patterns_added: parseJson<string[]>(row.patterns_added, []),
    patterns_removed: parseJson<string[]>(row.patterns_removed, []),
    hazards_added: parseJson<string[]>(row.hazards_added, []),
    hazards_removed: parseJson<string[]>(row.hazards_removed, []),
    cluster: row.cluster == null ? null : String(row.cluster),
    breaking_changes: Number(row.breaking_changes ?? 0) !== 0,
    commit_sha: row.commit_sha == null ? null : String(row.commit_sha),
    author_instance_id: row.author_instance_id == null ? null : String(row.author_instance_id),
    author_engine: row.author_engine == null ? null : String(row.author_engine),
    author_name: row.author_name == null ? null : String(row.author_name),
    author_identity: row.author_identity == null ? null : String(row.author_identity),
    review_entry_id: row.review_entry_id == null ? null : String(row.review_entry_id),
    source: String(row.source ?? 'agent'),
    verification_status: String(row.verification_status ?? 'pending'),
    verification_notes: row.verification_notes == null ? null : String(row.verification_notes),
    created_at: String(row.created_at ?? ''),
  };
}

export function getAtlasChangelogByRecoveryKey(
  db: AtlasDatabase,
  workspace: string,
  recoveryKey: string,
): AtlasChangelogRecord | null {
  const row = db.prepare(
    'SELECT * FROM atlas_changelog WHERE workspace = ? AND recovery_key = ? LIMIT 1',
  ).get(workspace, recoveryKey) as Record<string, unknown> | undefined;
  return row ? mapChangelogRecord(row) : null;
}

export function getAtlasFile(db: AtlasDatabase, workspace: string, filePath: string): AtlasFileRecord | null {
  const row = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as Record<string, unknown> | undefined;
  return row ? mapFileRecord(row) : null;
}

export function searchAtlasFiles(db: AtlasDatabase, workspace: string, query: string, limit = 5): AtlasFileRecord[] {
  // Split into meaningful tokens with stopword removal (OR semantics across tokens)
  const tokens = normalizeSearchText(query)
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return [];

  const conditions = tokens.map(
    () => '(file_path LIKE ? OR blurb LIKE ? OR purpose LIKE ? OR exports LIKE ? OR patterns LIKE ? OR hazards LIKE ?)',
  );
  const whereClause = conditions.join(' OR ');
  const params: (string | number)[] = [workspace];
  for (const token of tokens) {
    const like = `%${token}%`;
    params.push(like, like, like, like, like, like);
  }
  params.push(limit);

  const rows = db.prepare(
    `SELECT * FROM atlas_files
     WHERE workspace = ?
       AND (${whereClause})
     ORDER BY updated_at DESC, file_path ASC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function searchFts(db: AtlasDatabase, workspace: string, query: string, limit = 10): AtlasSearchHit[] {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) return [];
  try {
    const rows = db.prepare(
      `SELECT f.*, rank
       FROM atlas_fts
       JOIN atlas_files AS f ON f.id = atlas_fts.rowid
       WHERE f.workspace = ?
         AND atlas_fts MATCH ?
       ORDER BY rank ASC, f.file_path ASC
       LIMIT ?`,
    ).all(workspace, ftsQuery, limit) as Array<Record<string, unknown> & { rank?: number }>;

    return rows.map((row, index) => ({
      file: mapFileRecord(row),
      rank: index + 1,
      score: typeof row.rank === 'number' ? row.rank : index + 1,
      source: 'fts',
    }));
  } catch (err) {
    console.warn('[atlas-core] FTS search failed for query:', JSON.stringify(ftsQuery), (err as Error).message);
    return [];
  }
}

export function searchVector(db: AtlasDatabase, workspace: string, embedding: number[], limit = 10): AtlasSearchHit[] {
  try {
    const rows = db.prepare(
      `SELECT f.*, distance
       FROM atlas_embeddings
       JOIN atlas_files AS f ON f.id = atlas_embeddings.file_id
       WHERE f.workspace = ?
         AND embedding MATCH ?
         AND k = ?
       ORDER BY distance ASC, f.file_path ASC
       LIMIT ?`,
    ).all(workspace, JSON.stringify(embedding), limit, limit) as Array<Record<string, unknown> & { distance?: number }>;

    return rows.map((row, index) => ({
      file: mapFileRecord(row),
      rank: index + 1,
      score: typeof row.distance === 'number' ? row.distance : index + 1,
      source: 'vector',
    }));
  } catch (err) {
    console.warn('[atlas-core] vector search failed:', (err as Error).message);
    return [];
  }
}

export function searchSourceChunks(
  db: AtlasDatabase,
  workspace: string,
  embedding: number[],
  limit = 10,
): AtlasSourceChunkSearchHit[] {
  try {
    const rows = db.prepare(
      `SELECT c.*, distance
       FROM atlas_source_chunk_embeddings
       JOIN atlas_source_chunks AS c ON c.id = atlas_source_chunk_embeddings.chunk_id
       WHERE c.workspace = ?
         AND embedding MATCH ?
         AND k = ?
       ORDER BY distance ASC, c.file_path ASC, c.start_line ASC
       LIMIT ?`,
    ).all(workspace, JSON.stringify(embedding), limit, limit) as Array<Record<string, unknown> & { distance?: number }>;

    return rows.map((row, index) => ({
      chunk: mapSourceChunkRecord(row),
      rank: index + 1,
      score: typeof row.distance === 'number' ? row.distance : index + 1,
      source: 'vector',
    }));
  } catch (err) {
    console.warn('[atlas-core] source chunk vector search failed:', (err as Error).message);
    return [];
  }
}

export function searchChangelogFts(
  db: AtlasDatabase,
  workspace: string,
  query: string,
  limit = 10,
): AtlasChangelogSearchHit[] {
  const ftsQuery = prepareFtsQuery(query);
  if (!ftsQuery) return [];

  try {
    const rows = db.prepare(
      `SELECT c.*, rank
       FROM atlas_changelog_fts
       JOIN atlas_changelog AS c ON c.id = atlas_changelog_fts.rowid
       WHERE c.workspace = ?
         AND atlas_changelog_fts MATCH ?
       ORDER BY rank ASC, c.created_at DESC, c.id DESC
       LIMIT ?`,
    ).all(workspace, ftsQuery, limit) as Array<Record<string, unknown> & { rank?: number }>;

    return rows.map((row, index) => ({
      record: mapChangelogRecord(row),
      rank: index + 1,
      score: typeof row.rank === 'number' ? row.rank : index + 1,
      source: 'fts',
    }));
  } catch (err) {
    console.warn('[atlas-core] changelog FTS search failed for query:', JSON.stringify(ftsQuery), (err as Error).message);
    return [];
  }
}

export function searchChangelogVector(
  db: AtlasDatabase,
  workspace: string,
  embedding: number[],
  limit = 10,
): AtlasChangelogSearchHit[] {
  try {
    const rows = db.prepare(
      `SELECT c.*, distance
       FROM atlas_changelog_embeddings
       JOIN atlas_changelog AS c ON c.id = atlas_changelog_embeddings.changelog_id
       WHERE c.workspace = ?
         AND embedding MATCH ?
         AND k = ?
       ORDER BY distance ASC, c.created_at DESC, c.id DESC
       LIMIT ?`,
    ).all(workspace, JSON.stringify(embedding), limit, limit) as Array<Record<string, unknown> & { distance?: number }>;

    return rows.map((row, index) => ({
      record: mapChangelogRecord(row),
      rank: index + 1,
      score: typeof row.distance === 'number' ? row.distance : index + 1,
      source: 'vector',
    }));
  } catch (err) {
    console.warn('[atlas-core] changelog vector search failed:', (err as Error).message);
    return [];
  }
}

export function populateFts(db: AtlasDatabase, fileId: number): void {
  const row = db.prepare('SELECT * FROM atlas_files WHERE id = ? LIMIT 1').get(fileId) as Record<string, unknown> | undefined;
  if (!row) {
    return;
  }

  const record = mapFileRecord(row);
  const document = ftsDocumentForRecord(record);

  db.prepare('DELETE FROM atlas_fts WHERE rowid = ?').run(fileId);
  db.prepare(
    `INSERT INTO atlas_fts (
       rowid, file_path, blurb, purpose, public_api, patterns, hazards, cross_refs
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    fileId,
    document.file_path,
    document.blurb,
    document.purpose,
    document.public_api,
    document.patterns,
    document.hazards,
    document.cross_refs,
  );
}

function changelogFtsDocumentForRecord(record: AtlasChangelogRecord): Record<string, string> {
  return {
    file_path: normalizeSearchText(record.file_path),
    summary: normalizeSearchText(record.summary),
    cluster: normalizeSearchText(record.cluster ?? ''),
    patterns_added: normalizeSearchText(stringifyFtsValue(record.patterns_added)),
    hazards_added: normalizeSearchText(stringifyFtsValue(record.hazards_added)),
  };
}

export function populateChangelogFts(db: AtlasDatabase, changelogId: number): void {
  const row = db.prepare('SELECT * FROM atlas_changelog WHERE id = ? LIMIT 1').get(changelogId) as Record<string, unknown> | undefined;
  if (!row) {
    return;
  }

  const record = mapChangelogRecord(row);
  const document = changelogFtsDocumentForRecord(record);

  db.prepare('DELETE FROM atlas_changelog_fts WHERE rowid = ?').run(changelogId);
  db.prepare(
    `INSERT INTO atlas_changelog_fts (
      rowid, file_path, summary, cluster, patterns_added, hazards_added
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    changelogId,
    document.file_path,
    document.summary,
    document.cluster,
    document.patterns_added,
    document.hazards_added,
  );
}

export function rebuildFts(db: AtlasDatabase): void {
  db.prepare('DELETE FROM atlas_fts').run();
  const rows = db.prepare('SELECT id FROM atlas_files ORDER BY id ASC').all() as Array<{ id: number }>;
  for (const row of rows) {
    populateFts(db, row.id);
  }
}

export function listClusterFiles(db: AtlasDatabase, workspace: string, cluster: string): AtlasFileRecord[] {
  const rows = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? AND cluster = ? ORDER BY file_path ASC',
  ).all(workspace, cluster) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function listPatternFiles(db: AtlasDatabase, workspace: string, pattern: string, limit?: number): AtlasFileRecord[] {
  const effectiveLimit = Math.max(1, Math.min(limit ?? 200, 500));
  const rows = db.prepare(
    `SELECT * FROM atlas_files
     WHERE workspace = ?
       AND EXISTS (
         SELECT 1
         FROM json_each(atlas_files.patterns)
         WHERE json_each.value = ?
       )
     ORDER BY file_path ASC
     LIMIT ?`,
  ).all(workspace, pattern, effectiveLimit) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function listDistinctPatterns(db: AtlasDatabase, workspace: string, limit?: number): string[] {
  const effectiveLimit = Math.max(1, Math.min(limit ?? 200, 1000));
  const rows = db.prepare(
    `SELECT DISTINCT je.value AS pattern
     FROM atlas_files, json_each(atlas_files.patterns) AS je
     WHERE atlas_files.workspace = ?
     ORDER BY je.value ASC
     LIMIT ?`,
  ).all(workspace, effectiveLimit) as Array<{ pattern: string }>;
  return rows.map((row) => row.pattern).filter((p) => typeof p === 'string' && p.trim().length > 0);
}

export function countDistinctPatterns(db: AtlasDatabase, workspace: string): number {
  const row = db.prepare(
    `SELECT COUNT(DISTINCT je.value) AS cnt
     FROM atlas_files, json_each(atlas_files.patterns) AS je
     WHERE atlas_files.workspace = ?`,
  ).get(workspace) as { cnt: number } | undefined;
  return row?.cnt ?? 0;
}

export function insertAtlasChangelog(db: AtlasDatabase, input: AtlasChangelogInsertInput): AtlasChangelogRecord {
  const result = db.prepare(
    `INSERT INTO atlas_changelog (
      workspace, file_path, summary, patterns_added, patterns_removed,
      hazards_added, hazards_removed, cluster, breaking_changes, commit_sha,
      author_instance_id, author_engine, author_name, author_identity, review_entry_id, source,
      verification_status, verification_notes, recovery_key, created_at
    ) VALUES (
      @workspace, @file_path, @summary, @patterns_added, @patterns_removed,
      @hazards_added, @hazards_removed, @cluster, @breaking_changes, @commit_sha,
      @author_instance_id, @author_engine, @author_name, @author_identity, @review_entry_id, @source,
      @verification_status, @verification_notes, @recovery_key, COALESCE(@created_at, CURRENT_TIMESTAMP)
    )`,
  ).run({
    workspace: input.workspace,
    file_path: input.file_path,
    summary: input.summary,
    patterns_added: JSON.stringify(input.patterns_added ?? []),
    patterns_removed: JSON.stringify(input.patterns_removed ?? []),
    hazards_added: JSON.stringify(input.hazards_added ?? []),
    hazards_removed: JSON.stringify(input.hazards_removed ?? []),
    cluster: input.cluster ?? null,
    breaking_changes: input.breaking_changes ? 1 : 0,
    commit_sha: input.commit_sha ?? null,
    author_instance_id: input.author_instance_id ?? null,
    author_engine: input.author_engine ?? null,
    author_name: input.author_name ?? null,
    author_identity: input.author_identity ?? null,
    review_entry_id: input.review_entry_id ?? null,
    source: input.source ?? 'agent',
    verification_status: input.verification_status ?? 'pending',
    verification_notes: input.verification_notes ?? null,
    recovery_key: input.recovery_key ?? null,
    created_at: input.created_at ?? null,
  }) as { lastInsertRowid?: number | bigint };

  const insertId = result.lastInsertRowid == null ? null : Number(result.lastInsertRowid);
  if (insertId == null || !Number.isFinite(insertId)) {
    throw new Error('Failed to determine atlas_changelog insert id.');
  }

  const row = db.prepare(
    'SELECT * FROM atlas_changelog WHERE id = ? LIMIT 1',
  ).get(insertId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('Inserted atlas_changelog row could not be read back.');
  }
  return mapChangelogRecord(row);
}

export function upsertChangelogEmbedding(
  db: AtlasDatabase,
  changelogId: number,
  embedding: number[],
): void {
  try {
    db.prepare(`DELETE FROM atlas_changelog_embeddings WHERE changelog_id = ${changelogId}`).run();
    db.prepare(
      `INSERT INTO atlas_changelog_embeddings (changelog_id, embedding) VALUES (${changelogId}, ?)`,
    ).run(JSON.stringify(embedding));
  } catch (err) {
    console.warn(`[atlas] changelog embedding write failed for changelog_id=${changelogId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function upsertSourceChunkEmbedding(
  db: AtlasDatabase,
  chunkId: number,
  embedding: number[],
): void {
  try {
    db.prepare(`DELETE FROM atlas_source_chunk_embeddings WHERE chunk_id = ${chunkId}`).run();
    db.prepare(
      `INSERT INTO atlas_source_chunk_embeddings (chunk_id, embedding) VALUES (${chunkId}, ?)`,
    ).run(JSON.stringify(embedding));
  } catch (err) {
    console.warn(`[atlas] source chunk embedding write failed for chunk_id=${chunkId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function queryAtlasChangelog(db: AtlasDatabase, filters: AtlasChangelogQuery): AtlasChangelogRecord[] {
  const whereParts: string[] = ['c.workspace = ?'];
  const params: Array<string | number> = [filters.workspace];

  if (filters.file) {
    whereParts.push('c.file_path = ?');
    params.push(filters.file);
  }
  if (filters.file_prefix) {
    whereParts.push('c.file_path LIKE ?');
    params.push(`${filters.file_prefix}%`);
  }
  if (filters.cluster) {
    whereParts.push('c.cluster = ?');
    params.push(filters.cluster);
  }
  if (filters.author_instance_id) {
    whereParts.push('c.author_instance_id = ?');
    params.push(filters.author_instance_id);
  }
  if (filters.author_engine) {
    whereParts.push('c.author_engine = ?');
    params.push(filters.author_engine);
  }
  if (filters.author_name) {
    whereParts.push('c.author_name = ?');
    params.push(filters.author_name);
  }
  if (filters.author_identity) {
    whereParts.push('c.author_identity = ?');
    params.push(filters.author_identity);
  }
  if (filters.since) {
    whereParts.push('c.created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until) {
    whereParts.push('c.created_at <= ?');
    params.push(filters.until);
  }
  if (filters.verification_status) {
    whereParts.push('c.verification_status = ?');
    params.push(filters.verification_status);
  }
  if (filters.breaking_only) {
    whereParts.push('c.breaking_changes = 1');
  }

  let fromClause = 'atlas_changelog AS c';
  if (filters.query) {
    const ftsQuery = prepareFtsQuery(filters.query);
    if (!ftsQuery) {
      return [];
    }
    fromClause = 'atlas_changelog_fts JOIN atlas_changelog AS c ON c.id = atlas_changelog_fts.rowid';
    whereParts.push('atlas_changelog_fts MATCH ?');
    params.push(ftsQuery);
  }

  const limit = Math.max(1, Math.min(filters.limit ?? 20, 2000));
  params.push(limit);

  const rows = db.prepare(
    `SELECT c.*
     FROM ${fromClause}
     WHERE ${whereParts.join(' AND ')}
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT ?`,
  ).all(...params) as Record<string, unknown>[];

  return rows.map(mapChangelogRecord);
}

/**
 * Fetch every pending atlas_changelog row for the provided file set.
 * Used by git-commit-push so staged files are matched against the full
 * uncommitted backlog, not just the newest changelog page.
 */
export function queryPendingAtlasChangelogForFiles(
  db: AtlasDatabase,
  workspace: string,
  filePaths: string[],
): AtlasChangelogRecord[] {
  const uniquePaths = [...new Set(filePaths.map((value) => value.trim()).filter(Boolean))];
  if (!uniquePaths.length) return [];

  const CHUNK_SIZE = 200;
  const records: AtlasChangelogRecord[] = [];
  for (let i = 0; i < uniquePaths.length; i += CHUNK_SIZE) {
    const chunk = uniquePaths.slice(i, i + CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.prepare(
      `SELECT *
         FROM atlas_changelog
        WHERE workspace = ?
          AND commit_sha IS NULL
          AND file_path IN (${placeholders})
        ORDER BY created_at DESC, id DESC`,
    ).all(workspace, ...chunk) as Record<string, unknown>[];
    records.push(...rows.map(mapChangelogRecord));
  }

  records.sort((left, right) => {
    const createdAtOrder = right.created_at.localeCompare(left.created_at);
    return createdAtOrder !== 0 ? createdAtOrder : right.id - left.id;
  });
  return records;
}

/**
 * Stamp a `commit_sha` onto the given atlas_changelog rows. Used by the
 * one-click commit-and-push flow so rows transition from "uncommitted"
 * (commit_sha IS NULL) to "attributed to <sha>". Returns the number of
 * rows actually updated (may be less than ids.length if any rows are
 * missing or already have a non-null commit_sha — we don't overwrite).
 */
export function stampAtlasChangelogCommit(
  db: AtlasDatabase,
  ids: number[],
  commitSha: string,
): number {
  if (!ids.length) return 0;
  const placeholders = ids.map(() => '?').join(',');
  const result = db.prepare(
    `UPDATE atlas_changelog
        SET commit_sha = ?
      WHERE commit_sha IS NULL
        AND id IN (${placeholders})`,
  ).run(commitSha, ...ids) as { changes?: number };
  return Number(result.changes ?? 0);
}

export function listAllAtlasChangelog(db: AtlasDatabase, workspace: string): AtlasChangelogRecord[] {
  const rows = db.prepare(
    `SELECT *
     FROM atlas_changelog
     WHERE workspace = ?
     ORDER BY created_at DESC, id DESC`,
  ).all(workspace) as Record<string, unknown>[];
  return rows.map(mapChangelogRecord);
}

export function backfillAtlasChangelogAuthors(
  db: AtlasDatabase,
  rows: AtlasChangelogAuthorBackfillInput[],
): { attempted: number; updated: number; updatedIds: number[] } {
  if (rows.length === 0) {
    return { attempted: 0, updated: 0, updatedIds: [] };
  }

  const updateAuthor = db.prepare(
    `UPDATE atlas_changelog
        SET author_instance_id = CASE
              WHEN author_instance_id IS NULL OR trim(author_instance_id) = '' THEN @author_instance_id
              ELSE author_instance_id
            END,
            author_engine = CASE
              WHEN (author_engine IS NULL OR trim(author_engine) = '')
                AND @author_engine IS NOT NULL
                AND trim(@author_engine) <> '' THEN @author_engine
              ELSE author_engine
            END,
            author_name = CASE
              WHEN (author_name IS NULL OR trim(author_name) = '')
                AND @author_name IS NOT NULL
                AND trim(@author_name) <> '' THEN @author_name
              ELSE author_name
            END
      WHERE id = @id
        AND (
          (author_instance_id IS NULL OR trim(author_instance_id) = '')
          OR (
            (author_engine IS NULL OR trim(author_engine) = '')
            AND @author_engine IS NOT NULL
            AND trim(@author_engine) <> ''
          )
          OR (
            (author_name IS NULL OR trim(author_name) = '')
            AND @author_name IS NOT NULL
            AND trim(@author_name) <> ''
          )
        )`,
  );

  const updateInTransaction = db.transaction((inputs: AtlasChangelogAuthorBackfillInput[]) => {
    const updatedIds: number[] = [];
    for (const input of inputs) {
      const result = updateAuthor.run({
        id: input.id,
        author_instance_id: input.author_instance_id,
        author_engine: input.author_engine ?? null,
        author_name: input.author_name ?? null,
      }) as { changes?: number };
      if (Number(result.changes ?? 0) > 0) {
        updatedIds.push(input.id);
      }
    }
    return updatedIds;
  });

  const updatedIds = updateInTransaction(rows) as number[];
  return {
    attempted: rows.length,
    updated: updatedIds.length,
    updatedIds,
  };
}

export function enqueueReextract(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  triggerReason = 'file_release',
): void {
  db.prepare(
    `INSERT INTO atlas_reextract_queue (workspace, file_path, trigger_reason, status)
     VALUES (?, ?, ?, 'pending')`,
  ).run(workspace, filePath, triggerReason);
}

function normalizeSymbolKind(kind: string): AtlasSymbolKind {
  const normalized = kind.trim().toLowerCase();
  switch (normalized) {
    case 'function':
    case 'class':
    case 'type':
    case 'interface':
    case 'const':
    case 'enum':
    case 'namespace':
    case 're-export':
    case 'value':
    case 'default':
      return normalized;
    default:
      return 'unknown';
  }
}

function buildSignatureHash(filePath: string, name: string, kind: string): string {
  return createHash('sha1').update(`${filePath}:${name}:${kind}`).digest('hex');
}

function mapUsageTypeToEdgeType(usageType: string): 'runtime_call' | 'type_ref' | 'reexport' | 'config_ref' {
  const normalized = usageType.trim().toLowerCase();
  if (normalized.includes('type')) {
    return 'type_ref';
  }
  if (normalized.includes('re-export') || normalized.includes('reexport')) {
    return 'reexport';
  }
  if (normalized.includes('config')) {
    return 'config_ref';
  }
  return 'runtime_call';
}

export function listSymbols(
  db: AtlasDatabase,
  workspace: string,
  filePath?: string,
): AtlasSymbolRecord[] {
  const rows = (filePath
    ? db.prepare(
      `SELECT id, workspace, file_path, name, kind, exported, line_start, line_end, signature_hash
       FROM symbols
       WHERE workspace = ? AND file_path = ?
       ORDER BY file_path ASC, name ASC`,
    ).all(workspace, filePath)
    : db.prepare(
      `SELECT id, workspace, file_path, name, kind, exported, line_start, line_end, signature_hash
       FROM symbols
       WHERE workspace = ?
       ORDER BY file_path ASC, name ASC`,
    ).all(workspace)) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    file_path: String(row.file_path ?? ''),
    name: String(row.name ?? ''),
    kind: normalizeSymbolKind(String(row.kind ?? 'unknown')),
    exported: Number(row.exported ?? 0) === 1,
    line_start: row.line_start == null ? null : Number(row.line_start),
    line_end: row.line_end == null ? null : Number(row.line_end),
    signature_hash: row.signature_hash == null ? null : String(row.signature_hash),
  }));
}

export function listReferences(
  db: AtlasDatabase,
  workspace: string,
  sourceFile?: string,
): AtlasReferenceRecord[] {
  const rows = (sourceFile
    ? db.prepare(
      `SELECT id, workspace, source_symbol_id, target_symbol_id, edge_type,
              source_file, target_file, usage_count, confidence, provenance, last_verified
       FROM "references"
       WHERE workspace = ? AND source_file = ?
       ORDER BY source_file ASC, target_file ASC, id ASC`,
    ).all(workspace, sourceFile)
    : db.prepare(
      `SELECT id, workspace, source_symbol_id, target_symbol_id, edge_type,
              source_file, target_file, usage_count, confidence, provenance, last_verified
       FROM "references"
       WHERE workspace = ?
       ORDER BY source_file ASC, target_file ASC, id ASC`,
    ).all(workspace)) as Record<string, unknown>[];

  return rows.map((row) => ({
    id: Number(row.id ?? 0),
    workspace: String(row.workspace ?? ''),
    source_symbol_id: row.source_symbol_id == null ? null : Number(row.source_symbol_id),
    target_symbol_id: row.target_symbol_id == null ? null : Number(row.target_symbol_id),
    edge_type: String(row.edge_type ?? 'runtime_call'),
    source_file: String(row.source_file ?? ''),
    target_file: String(row.target_file ?? ''),
    usage_count: Number(row.usage_count ?? 1),
    confidence: Number(row.confidence ?? 1),
    provenance: String(row.provenance ?? 'inferred'),
    last_verified: row.last_verified == null ? null : String(row.last_verified),
  }));
}

export function upsertSymbolsForFile(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  symbols: AtlasSymbolUpsertInput[],
): void {
  const deleteStmt = db.prepare('DELETE FROM symbols WHERE workspace = ? AND file_path = ?');
  const insertStmt = db.prepare(
    `INSERT INTO symbols (
       workspace, file_path, name, kind, exported, line_start, line_end, signature_hash, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace, file_path, name, kind) DO UPDATE SET
       exported = excluded.exported,
       line_start = excluded.line_start,
       line_end = excluded.line_end,
       signature_hash = excluded.signature_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );

  const tx = db.transaction((rows: AtlasSymbolUpsertInput[]) => {
    deleteStmt.run(workspace, filePath);

    const dedupe = new Set<string>();
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) continue;
      const kind = normalizeSymbolKind(row.kind);
      const key = `${name}:${kind}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      insertStmt.run(
        workspace,
        filePath,
        name,
        kind,
        row.exported === false ? 0 : 1,
        row.line_start ?? null,
        row.line_end ?? null,
        row.signature_hash ?? buildSignatureHash(filePath, name, kind),
      );
    }
  });

  tx(symbols);
}

export function replaceReferencesForFile(
  db: AtlasDatabase,
  workspace: string,
  sourceFile: string,
  crossRefs: AtlasCrossRefs | null,
): void {
  // Only delete non-AST references — AST-sourced edges from the structure phase are preserved
  const deleteStmt = db.prepare(
    `DELETE FROM "references" WHERE workspace = ? AND source_file = ? AND provenance != 'ast'`,
  );
  const insertSymbolStmt = db.prepare(
    `INSERT INTO symbols (
       workspace, file_path, name, kind, exported, signature_hash, updated_at
     ) VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace, file_path, name, kind) DO UPDATE SET
       exported = 1,
       signature_hash = excluded.signature_hash,
       updated_at = CURRENT_TIMESTAMP`,
  );
  const getSymbolIdsStmt = db.prepare(
    'SELECT id, name FROM symbols WHERE workspace = ? AND file_path = ?',
  );
  const insertRefStmt = db.prepare(
    `INSERT INTO "references" (
       workspace, source_symbol_id, target_symbol_id, edge_type, source_file, target_file,
       usage_count, confidence, provenance, last_verified, updated_at
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );

  const tx = db.transaction((refs: AtlasCrossRefs | null) => {
    deleteStmt.run(workspace, sourceFile);
    if (!refs?.symbols || typeof refs.symbols !== 'object') {
      return;
    }

    // Backward compat: old data may still have pass2_model / pass2_timestamp
    const legacy = refs as AtlasCrossRefs & { pass2_model?: string; pass2_timestamp?: string };
    const model = refs.crossref_model ?? legacy.pass2_model;
    const provenance = model && model !== 'heuristic' ? 'llm' : 'inferred';
    const confidence = provenance === 'llm' ? 0.8 : 0.6;
    const verifiedAt = refs.crossref_timestamp ?? legacy.pass2_timestamp ?? null;

    for (const [symbolName, symbolData] of Object.entries(refs.symbols)) {
      const cleanName = symbolName.trim();
      if (!cleanName) continue;
      const kind = normalizeSymbolKind(String(symbolData.type ?? 'unknown'));
      insertSymbolStmt.run(
        workspace,
        sourceFile,
        cleanName,
        kind,
        buildSignatureHash(sourceFile, cleanName, kind),
      );
    }

    const symbolRows = getSymbolIdsStmt.all(workspace, sourceFile) as Array<{ id: number; name: string }>;
    const symbolIdByName = new Map(symbolRows.map((row) => [row.name, row.id]));

    for (const [symbolName, symbolData] of Object.entries(refs.symbols)) {
      const sourceSymbolId = symbolIdByName.get(symbolName.trim()) ?? null;
      if (sourceSymbolId == null || !Array.isArray(symbolData.call_sites)) {
        continue;
      }

      for (const callSite of symbolData.call_sites) {
        const targetFile = typeof callSite.file === 'string' ? callSite.file.trim() : '';
        if (!targetFile) continue;
        const usageCount = typeof callSite.count === 'number' && Number.isFinite(callSite.count)
          ? Math.max(1, Math.floor(callSite.count))
          : 1;
        const edgeType = mapUsageTypeToEdgeType(typeof callSite.usage_type === 'string' ? callSite.usage_type : '');

        insertRefStmt.run(
          workspace,
          sourceSymbolId,
          edgeType,
          sourceFile,
          targetFile,
          usageCount,
          confidence,
          provenance,
          verifiedAt,
        );
      }
    }
  });

  tx(crossRefs);
}

export function backfillSymbolsAndReferencesFromAtlasFiles(db: AtlasDatabase): void {
  try {
    const symbolCountRow = db.prepare('SELECT COUNT(*) AS total FROM symbols').get() as { total?: number } | undefined;
    const referenceCountRow = db.prepare('SELECT COUNT(*) AS total FROM "references"').get() as { total?: number } | undefined;
    const symbolCount = symbolCountRow?.total ?? 0;
    const referenceCount = referenceCountRow?.total ?? 0;

    // Startup backfill should only bootstrap legacy-empty databases.
    // Avoid repeated full-table rewrites when one table is legitimately sparse.
    if (!(symbolCount === 0 && referenceCount === 0)) {
      return;
    }

    const rows = db.prepare(
      `SELECT workspace, file_path, exports, cross_refs
       FROM atlas_files
       ORDER BY workspace ASC, file_path ASC`,
    ).all() as Array<{
      workspace: string;
      file_path: string;
      exports: string | null;
      cross_refs: string | null;
    }>;

    for (const row of rows) {
      const exportsList = parseJson<Array<{ name?: unknown; type?: unknown }>>(row.exports, []);
      const symbols: AtlasSymbolUpsertInput[] = exportsList
        .filter((entry) => typeof entry?.name === 'string' && typeof entry?.type === 'string')
        .map((entry) => ({
          workspace: row.workspace,
          file_path: row.file_path,
          name: String(entry.name),
          kind: String(entry.type),
          exported: true,
        }));
      upsertSymbolsForFile(db, row.workspace, row.file_path, symbols);

      const crossRefs = parseJson<AtlasCrossRefs | null>(row.cross_refs, null);
      replaceReferencesForFile(db, row.workspace, row.file_path, crossRefs);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[atlas] symbols/references backfill skipped: ${message}`);
  }
}

export function replaceImportEdges(
  db: AtlasDatabase,
  workspace: string,
  edges: AtlasImportEdgeRecord[],
  selectedSourceFiles?: Iterable<string>,
): void {
  const selectedSources = selectedSourceFiles ? [...new Set(selectedSourceFiles)] : null;
  const deleteAllStmt = db.prepare('DELETE FROM import_edges WHERE workspace = ?');
  const deleteSourceStmt = db.prepare('DELETE FROM import_edges WHERE workspace = ? AND source_file = ?');
  const insertStmt = db.prepare(
    'INSERT INTO import_edges (workspace, source_file, target_file) VALUES (?, ?, ?)',
  );

  const tx = db.transaction((batch: AtlasImportEdgeRecord[]) => {
    if (selectedSources) {
      for (const sourceFile of selectedSources) {
        deleteSourceStmt.run(workspace, sourceFile);
      }
    } else {
      deleteAllStmt.run(workspace);
    }
    for (const edge of batch) {
      insertStmt.run(edge.workspace, edge.source_file, edge.target_file);
    }
  });

  tx(edges);
}

export function upsertAtlasMeta(db: AtlasDatabase, input: AtlasMetaUpsertInput): void {
  db.prepare(
    `INSERT INTO atlas_meta (workspace, source_root, brain_version, updated_at)
     VALUES (?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(workspace) DO UPDATE SET
       source_root = excluded.source_root,
       brain_version = COALESCE(excluded.brain_version, atlas_meta.brain_version),
       updated_at = CURRENT_TIMESTAMP`,
  ).run(
    input.workspace,
    input.source_root,
    input.brain_version ?? null,
  );
}

export function listAtlasFiles(db: AtlasDatabase, workspace: string): AtlasFileRecord[] {
  const rows = db.prepare(
    'SELECT * FROM atlas_files WHERE workspace = ? ORDER BY file_path ASC',
  ).all(workspace) as Record<string, unknown>[];
  return rows.map(mapFileRecord);
}

export function getAtlasEmbedding(db: AtlasDatabase, workspace: string, filePath: string): number[] | null {
  const fileId = getAtlasFileId(db, workspace, filePath);
  if (fileId == null) return null;

  try {
    const row = db.prepare(
      `SELECT embedding
       FROM atlas_embeddings
       WHERE file_id = ${fileId}
       LIMIT 1`,
    ).get() as Record<string, unknown> | undefined;
    return row ? parseEmbeddingValue(row.embedding) : null;
  } catch {
    return null;
  }
}

export function listAtlasExportRows(
  db: AtlasDatabase,
  workspace: string,
  filePaths?: string[],
): AtlasExportRow[] {
  const files = listAtlasFiles(db, workspace);
  const selected = filePaths && filePaths.length > 0
    ? new Set(filePaths)
    : null;

  return files
    .filter((file) => !selected || selected.has(file.file_path))
    .map((file) => ({
      file,
      embedding: getAtlasEmbedding(db, workspace, file.file_path),
    }));
}

export function listImportEdges(db: AtlasDatabase, workspace: string): AtlasImportEdgeRecord[] {
  return db.prepare(
    'SELECT workspace, source_file, target_file FROM import_edges WHERE workspace = ?',
  ).all(workspace) as AtlasImportEdgeRecord[];
}

export function listImportedBy(db: AtlasDatabase, workspace: string, targetFile: string): string[] {
  const rows = db.prepare(
    'SELECT source_file FROM import_edges WHERE workspace = ? AND target_file = ?',
  ).all(workspace, targetFile) as Array<{ source_file: string }>;
  return rows.map((row) => row.source_file);
}

export function listImports(db: AtlasDatabase, workspace: string, sourceFile: string): string[] {
  const rows = db.prepare(
    'SELECT target_file FROM import_edges WHERE workspace = ? AND source_file = ?',
  ).all(workspace, sourceFile) as Array<{ target_file: string }>;
  return rows.map((row) => row.target_file);
}

export function getAtlasFileByWorkspacePath(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
): AtlasFileRecord | null {
  return getAtlasFile(db, workspace, filePath);
}

export function getAtlasFileId(db: AtlasDatabase, workspace: string, filePath: string): number | null {
  const row = db.prepare(
    'SELECT id FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as { id?: number } | undefined;
  return row?.id ?? null;
}

function deleteSourceChunksForFile(db: AtlasDatabase, workspace: string, filePath: string): void {
  const rows = db.prepare(
    'SELECT id FROM atlas_source_chunks WHERE workspace = ? AND file_path = ?',
  ).all(workspace, filePath) as Array<{ id: number }>;

  for (const row of rows) {
    try {
      db.prepare(`DELETE FROM atlas_source_chunk_embeddings WHERE chunk_id = ${row.id}`).run();
    } catch {
      // vec0 table may not exist
    }
  }

  db.prepare(
    'DELETE FROM atlas_source_chunks WHERE workspace = ? AND file_path = ?',
  ).run(workspace, filePath);
}

export function replaceSourceChunks(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  chunks: AtlasSourceChunk[],
): AtlasSourceChunkRecord[] {
  const fileId = getAtlasFileId(db, workspace, filePath);
  if (fileId == null) {
    return [];
  }

  const insert = db.prepare(
    `INSERT INTO atlas_source_chunks (
       workspace, file_id, file_path, chunk_kind, label, start_line, end_line, content, text_hash, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  );

  const inserted: AtlasSourceChunkRecord[] = [];
  const tx = db.transaction((input: AtlasSourceChunk[]) => {
    deleteSourceChunksForFile(db, workspace, filePath);
    for (const chunk of input) {
      const result = insert.run(
        workspace,
        fileId,
        filePath,
        chunk.kind,
        chunk.label,
        chunk.startLine,
        chunk.endLine,
        chunk.content,
        chunk.textHash,
      ) as { lastInsertRowid?: number | bigint };
      const insertId = result.lastInsertRowid == null ? null : Number(result.lastInsertRowid);
      if (insertId == null || !Number.isFinite(insertId)) {
        continue;
      }
      inserted.push({
        id: insertId,
        workspace,
        file_id: fileId,
        file_path: filePath,
        kind: chunk.kind,
        label: chunk.label,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        content: chunk.content,
        textHash: chunk.textHash,
      });
    }
  });
  tx(chunks);

  return inserted;
}

/**
 * Resume-safe Pass 0 upsert: updates ONLY structural fields (hash, cluster, loc,
 * imports/exports, language) while PRESERVING AI-generated fields (blurb, purpose,
 * patterns, hazards, conventions, cross_refs, extraction_model, last_extracted).
 *
 * For new files, inserts with empty AI fields. For existing files with AI data,
 * only the structural columns are touched.
 */
export function upsertScanRecord(db: AtlasDatabase, record: {
  workspace: string;
  file_path: string;
  file_hash: string | null;
  cluster: string | null;
  loc: number;
  exports: Array<{ name: string; type: string }>;
  dependencies: Record<string, unknown>;
  language: string;
}): void {
  db.prepare(
    `INSERT INTO atlas_files (
       workspace, file_path, file_hash, cluster, loc, blurb, purpose,
       public_api, exports, patterns, dependencies, data_flows, key_types, hazards,
       conventions, cross_refs, source_highlights, language, extraction_model, last_extracted, updated_at
     ) VALUES (
       @workspace, @file_path, @file_hash, @cluster, @loc, '', '',
       '[]', @exports, '[]', @dependencies, '[]', '[]', '[]',
       '[]', 'null', '[]', @language, NULL, NULL, CURRENT_TIMESTAMP
     )
     ON CONFLICT(workspace, file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       cluster = excluded.cluster,
       loc = excluded.loc,
       exports = excluded.exports,
       dependencies = excluded.dependencies,
       language = excluded.language,
       updated_at = CURRENT_TIMESTAMP`,
  ).run({
    workspace: record.workspace,
    file_path: record.file_path,
    file_hash: record.file_hash ?? null,
    cluster: record.cluster ?? null,
    loc: record.loc,
    exports: JSON.stringify(record.exports),
    dependencies: JSON.stringify(record.dependencies),
    language: record.language,
  });

  const fileId = getAtlasFileId(db, record.workspace, record.file_path);
  if (fileId != null) {
    populateFts(db, fileId);
  }
}

/**
 * Check if a file's atlas record is "complete" — has non-empty AI-generated
 * fields AND the file content hasn't changed since extraction.
 */
export function isFileComplete(db: AtlasDatabase, workspace: string, filePath: string, currentHash: string): boolean {
  const row = db.prepare(
    `SELECT file_hash, blurb, purpose, extraction_model, cross_refs
     FROM atlas_files
     WHERE workspace = ? AND file_path = ? LIMIT 1`,
  ).get(workspace, filePath) as {
    file_hash: string | null;
    blurb: string | null;
    purpose: string | null;
    extraction_model: string | null;
    cross_refs: string | null;
  } | undefined;

  if (!row) return false;
  if (row.file_hash !== currentHash) return false;
  if (!row.blurb || row.blurb.trim() === '') return false;
  if (!row.purpose || row.purpose.trim() === '') return false;
  if (!row.extraction_model || row.extraction_model === 'scaffold') return false;
  if (!row.cross_refs || row.cross_refs === 'null' || row.cross_refs === '{}') return false;
  return true;
}

/**
 * Check which phase a file has reached (for granular resume).
 * Returns the last completed phase: 'none' | 'summarize' | 'extract' | 'embed' | 'crossref'
 *
 * Phase logic:
 *   - 'none':      no data, or file hash changed → needs full run
 *   - 'summarize': has blurb, but no real extraction (purpose empty or scaffold)
 *   - 'extract':   has real extraction (purpose + non-scaffold model), but cross_refs
 *                   are missing or have no actual symbol data → needs embed + crossref
 *   - 'crossref':  cross_refs contain real symbol data → fully complete
 */
function hasEmbedding(db: AtlasDatabase, fileId: number): boolean {
  try {
    const row = db.prepare(
      'SELECT 1 FROM atlas_embeddings_rowids WHERE rowid = ? LIMIT 1',
    ).get(fileId) as Record<string, unknown> | undefined;
    return row !== undefined;
  } catch {
    // vec0 backing table may not exist
    return false;
  }
}

/**
 * Determine how far a file has progressed through the pipeline.
 *
 * The pipeline is: scan → structure → flow → crossref → cluster.
 * Semantic fields (blurb, purpose, etc.) are no longer gating — they start empty and are
 * populated organically via atlas_commit. The phase check now only cares about:
 * - Does the file exist in the DB with a matching hash? ('none' if not)
 * - Does it have structure data? ('structure' if so)
 * - Does it have cross-refs? ('crossref' if so — fully complete)
 */
export function getFilePhase(db: AtlasDatabase, workspace: string, filePath: string, currentHash: string): 'none' | 'structure' | 'crossref' {
  const row = db.prepare(
    `SELECT id, file_hash, cross_refs
     FROM atlas_files
     WHERE workspace = ? AND file_path = ? LIMIT 1`,
  ).get(workspace, filePath) as {
    id: number;
    file_hash: string | null;
    cross_refs: string | null;
  } | undefined;

  if (!row) return 'none';
  // If hash changed, file needs full re-processing
  if (row.file_hash !== currentHash) return 'none';

  // Check cross_refs for actual symbol data (not just empty '{}' or 'null').
  const crossRefs = row.cross_refs;
  if (crossRefs && crossRefs !== 'null' && crossRefs !== '{}') {
    try {
      const parsed = JSON.parse(crossRefs);
      if (parsed && typeof parsed === 'object' && (
        (parsed.symbols && Object.keys(parsed.symbols).length > 0) ||
        (typeof parsed.total_exports_analyzed === 'number' && parsed.total_exports_analyzed >= 0 && (parsed.crossref_timestamp || parsed.pass2_timestamp))
      )) {
        return 'crossref';
      }
    } catch {
      // Invalid JSON — treat as incomplete
    }
  }

  // File exists with matching hash but no cross-refs — structure is done
  return 'structure';
}

export function upsertEmbedding(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
  embedding: number[],
): void {
  const fileId = getAtlasFileId(db, workspace, filePath);
  if (fileId == null) {
    return;
  }

  try {
    // vec0 virtual tables do not support ON CONFLICT / UPSERT,
    // so we delete-then-insert to achieve upsert semantics.
    // IMPORTANT: vec0 v0.1.x cannot handle bound params for the primary key column —
    // the integer must be a SQL literal.  Only the embedding vector is bound.
    db.prepare(`DELETE FROM atlas_embeddings WHERE file_id = ${fileId}`).run();
    db.prepare(
      `INSERT INTO atlas_embeddings (file_id, embedding) VALUES (${fileId}, ?)`,
    ).run(JSON.stringify(embedding));
  } catch (err) {
    // vec0 table may not exist if sqlite-vec extension isn't loaded
    console.warn(`[atlas] embedding write failed for file_id=${fileId}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function listPendingQueue(db: AtlasDatabase, workspace: string): AtlasQueueRecord[] {
  const rows = db.prepare(
    `SELECT * FROM atlas_reextract_queue
     WHERE workspace = ? AND status = 'pending'
     ORDER BY queued_at ASC, id ASC`,
  ).all(workspace) as Record<string, unknown>[];
  return rows.map(mapQueueRecord);
}

export function upsertFileRecord(db: AtlasDatabase, record: AtlasFileUpsertInput): void {
  db.prepare(
    `INSERT INTO atlas_files (
       workspace, file_path, file_hash, cluster, loc, blurb, purpose,
       public_api, exports, patterns, dependencies, data_flows, key_types, hazards,
       conventions, cross_refs, source_highlights, language, extraction_model, last_extracted, updated_at
     ) VALUES (
       @workspace, @file_path, @file_hash, @cluster, @loc, @blurb, @purpose,
       @public_api, @exports, @patterns, @dependencies, @data_flows, @key_types, @hazards,
       @conventions, @cross_refs, @source_highlights, @language, @extraction_model, @last_extracted, CURRENT_TIMESTAMP
     )
     ON CONFLICT(workspace, file_path) DO UPDATE SET
       file_hash = excluded.file_hash,
       cluster = excluded.cluster,
       loc = excluded.loc,
       blurb = excluded.blurb,
       purpose = excluded.purpose,
       public_api = excluded.public_api,
       exports = excluded.exports,
       patterns = excluded.patterns,
       dependencies = excluded.dependencies,
       data_flows = excluded.data_flows,
       key_types = excluded.key_types,
       hazards = excluded.hazards,
       conventions = excluded.conventions,
       cross_refs = excluded.cross_refs,
       source_highlights = excluded.source_highlights,
       language = excluded.language,
       extraction_model = excluded.extraction_model,
       last_extracted = excluded.last_extracted,
       updated_at = CURRENT_TIMESTAMP`,
  ).run({
    workspace: record.workspace,
    file_path: record.file_path,
    file_hash: record.file_hash ?? null,
    cluster: record.cluster ?? null,
    loc: record.loc ?? 0,
    blurb: record.blurb ?? '',
    purpose: record.purpose ?? '',
    public_api: JSON.stringify(record.public_api ?? []),
    exports: JSON.stringify(record.exports ?? []),
    patterns: JSON.stringify(record.patterns ?? []),
    dependencies: JSON.stringify(record.dependencies ?? {}),
    data_flows: JSON.stringify(record.data_flows ?? []),
    key_types: JSON.stringify(record.key_types ?? []),
    hazards: JSON.stringify(record.hazards ?? []),
    conventions: JSON.stringify(record.conventions ?? []),
    cross_refs: JSON.stringify(record.cross_refs ?? {}),
    source_highlights: JSON.stringify(record.source_highlights ?? []),
    language: record.language ?? 'typescript',
    extraction_model: record.extraction_model ?? null,
    last_extracted: record.last_extracted ?? null,
  });

  const fileId = getAtlasFileId(db, record.workspace, record.file_path);
  if (fileId != null) {
    populateFts(db, fileId);
  }
}

/**
 * Delete an atlas file and all related data (FTS, embeddings, edges, symbols).
 * Used to prune orphaned entries for files that no longer exist on disk.
 */
export function deleteAtlasFile(db: AtlasDatabase, workspace: string, filePath: string): boolean {
  const row = db.prepare(
    'SELECT id FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
  ).get(workspace, filePath) as { id: number } | undefined;
  if (!row) return false;

  const fileId = row.id;

  // Clean up FTS entry
  db.prepare('DELETE FROM atlas_fts WHERE rowid = ?').run(fileId);

  // Clean up embedding (vec0 — use literal id, not bound param)
  try {
    db.prepare(`DELETE FROM atlas_embeddings WHERE file_id = ${fileId}`).run();
  } catch {
    // vec0 table may not exist
  }

  deleteSourceChunksForFile(db, workspace, filePath);

  // Clean up import edges
  db.prepare('DELETE FROM import_edges WHERE workspace = ? AND (source_file = ? OR target_file = ?)').run(workspace, filePath, filePath);

  // Clean up symbols
  db.prepare('DELETE FROM symbols WHERE workspace = ? AND file_path = ?').run(workspace, filePath);

  // Clean up the atlas_files row itself
  db.prepare('DELETE FROM atlas_files WHERE id = ?').run(fileId);

  return true;
}
