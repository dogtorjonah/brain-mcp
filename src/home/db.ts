/**
 * Home DB — connection lifecycle + migration runner for ~/.brain/brain.sqlite
 *
 * The home DB holds all identity, transcript, synapse-edge, and SOP data.
 * Atlas data lives in per-repo <repo>/.brain/atlas.sqlite and is ATTACH'd at
 * runtime by the bridge layer (Q3's lane).
 *
 * Design notes:
 * - Single persistent connection held by the daemon process.
 * - WAL mode for concurrent reads during writes.
 * - sqlite-vec loaded at boot for vec0 virtual tables.
 * - Migrations run sequentially from migrations/home/ on first open.
 * - 384-dim embeddings (local ONNX BGE-small, matching relay atlas + rebirth-mcp).
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const EMBED_DIM = 384;
type DatabaseType = InstanceType<typeof Database>;

/** Default location for the brain home database. */
export const DEFAULT_BRAIN_DIR = join(homedir(), '.brain');
export const DEFAULT_BRAIN_DB = join(DEFAULT_BRAIN_DIR, 'brain.sqlite');

export interface HomeDbOptions {
  /** Absolute path to brain.sqlite. Defaults to ~/.brain/brain.sqlite. */
  path?: string;
  /** Absolute path to migration SQL files directory. */
  migrationsDir?: string;
}

export class HomeDb {
  public readonly db: DatabaseType;
  private readonly vectorEnabled: boolean;

  private constructor(db: DatabaseType, vectorEnabled: boolean) {
    this.db = db;
    this.vectorEnabled = vectorEnabled;
  }

  /** Whether vec0 virtual tables are available for vector queries. */
  get hasVector(): boolean {
    return this.vectorEnabled;
  }

  /**
   * Open (or create) the home database.
   *
   * - Creates parent directory if missing.
   * - Loads sqlite-vec extension.
   * - Runs pending migrations.
   * - Returns a ready-to-use HomeDb instance.
   */
  static open(opts: HomeDbOptions = {}): HomeDb {
    const dbPath = opts.path ?? DEFAULT_BRAIN_DB;
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new Database(dbPath);

    // WAL for concurrent reads during writes.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');

    // Load sqlite-vec extension.
    let vectorEnabled = false;
    try {
      sqliteVec.load(db);
      vectorEnabled = true;
    } catch {
      // Graceful degradation — BM25-only fallback.
      console.warn('[brain-mcp] sqlite-vec failed to load; vector search unavailable');
    }

    // Run migrations.
    const migrationsDir = opts.migrationsDir ?? join(DEFAULT_BRAIN_DIR, '..', 'brain-mcp', 'migrations', 'home');
    // In development, migrations live relative to the package:
    // /home/jonah/brain-mcp/migrations/home/
    const devMigrationsDir = opts.migrationsDir ?? join(process.cwd(), 'migrations', 'home');

    let dir = migrationsDir;
    try {
      readdirSync(dir);
    } catch {
      dir = devMigrationsDir;
    }
    HomeDb.runMigrations(db, dir);

    return new HomeDb(db, vectorEnabled);
  }

  /** Run pending SQL migrations from the given directory. */
  private static runMigrations(db: DatabaseType, migrationsDir: string): void {
    // Ensure brain_meta table exists for version tracking.
    db.exec(`
      CREATE TABLE IF NOT EXISTS brain_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    const currentVersion = db.prepare("SELECT value FROM brain_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    const current = currentVersion ? parseInt(currentVersion.value, 10) : 0;

    let files: string[];
    try {
      files = readdirSync(migrationsDir)
        .filter(f => f.endsWith('.sql'))
        .sort();
    } catch {
      // No migrations directory yet — nothing to run.
      return;
    }

    for (const file of files) {
      const match = file.match(/^(\d+)/);
      if (!match) continue;
      const version = parseInt(match[1], 10);
      if (version <= current) continue;

      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      db.exec(sql);
      db.prepare("INSERT OR REPLACE INTO brain_meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      console.log(`[brain-mcp] Migration ${file} applied (schema_version → ${version})`);
    }
  }

  /** Close the database connection gracefully. */
  close(): void {
    try {
      this.db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-fatal.
    }
    this.db.close();
  }

  // ──────────────────────────────────────────
  // Convenience: identity-bound session lookup
  // ──────────────────────────────────────────

  /** Resolve the identity name for a given session, or null. */
  getIdentityForSession(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT identity_name FROM session_identity WHERE session_id = ?'
    ).get(sessionId) as { identity_name: string } | undefined;
    return row?.identity_name ?? null;
  }

  /** Resolve identity from env var $CLAUDE_IDENTITY or session binding. */
  resolveIdentity(sessionId?: string): string {
    const envIdentity = process.env.CLAUDE_IDENTITY;
    if (envIdentity) return envIdentity;
    if (sessionId) {
      const bound = this.getIdentityForSession(sessionId);
      if (bound) return bound;
    }
    return 'unknown';
  }
}
