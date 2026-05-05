import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createTestHomeDb } from '../helpers.js';

describe('Home DB: migration creates all tables', () => {
  let db: ReturnType<typeof createTestHomeDb>;
  const tables = [
    'identity_profiles',
    'identity_chain',
    'identity_sops',
    'identity_handoff_notes',
    'specialty_signatures',
    'session_identity',
    'transcript_chunks',
    'atlas_identity_edges',
    'repo_registry',
    'brain_meta',
  ];

  function getTableNames(): string[] {
    return db.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  }

  function getTableNamesWithFts(): string[] {
    return db.db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name").all() as { name: string; type: string }[];
  }

  beforeAll(() => {
    db = createTestHomeDb();
  });

  afterAll(() => {
    db.close();
  });

  for (const table of tables) {
    it(`${table} table exists`, () => {
      const allTables = getTableNames();
      const names = allTables.map(t => t.name);
      expect(names).toContain(table);
    });
  }

  it('transcript_chunks_fts FTS5 virtual table exists', () => {
    const allTables = getTableNamesWithFts();
    const names = allTables.map(t => t.name);
    expect(names).toContain('transcript_chunks_fts');
  });

  it('atlas_identity_edges has expected columns', () => {
    const info = db.db.pragma('table_info(atlas_identity_edges)') as { name: string; type: string }[];
    const colNames = info.map(c => c.name);
    expect(colNames).toContain('identity_name');
    expect(colNames).toContain('workspace');
    expect(colNames).toContain('file_path');
    expect(colNames).toContain('changelog_id');
    expect(colNames).toContain('kind');
    expect(colNames).toContain('detail');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('ts');
  });

  it('brain_meta has schema_version key', () => {
    const row = db.db.prepare("SELECT value FROM brain_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    expect(row).toBeDefined();
    expect(Number(row!.value)).toBeGreaterThanOrEqual(4); // 4 migrations applied
  });

  it('all expected indexes exist', () => {
    const indexes = db.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL ORDER BY name").all() as { name: string }[];
    const names = indexes.map(i => i.name);
    const expected = [
      'idx_chain_identity',
      'idx_chain_session',
      'idx_sops_identity',
      'idx_chunks_session',
      'idx_chunks_identity',
      'idx_edges_identity',
      'idx_edges_workspace_file',
      'idx_edges_kind_detail',
      'idx_edges_ts',
      'idx_edges_changelog',
    ];
    for (const idx of expected) {
      expect(names).toContain(idx);
    }
  });
});

describe('Home DB: migration idempotency and pragmas', () => {
  let db: ReturnType<typeof createTestHomeDb>;

  beforeAll(() => {
    db = createTestHomeDb();
  });

  afterAll(() => {
    db.close();
  });

  it('double-open is safe (idempotent migrations)', () => {
    const tableCount = db.db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number };
    expect(tableCount.c).toBeGreaterThan(0);

    const db2 = createTestHomeDb();
    const tableCount2 = db2.db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number };
    db2.close();

    expect(tableCount.c).toBe(tableCount2.c);
  });

  it('schema_version = 5 after all migrations', () => {
    const row = db.db.prepare("SELECT value FROM brain_meta WHERE key = 'schema_version'").get() as { value: string };
    expect(row.value).toBe('5');
  });

  it('brain_meta has schema_version, embedding_dim, created_at', () => {
    const rows = db.db.prepare("SELECT key FROM brain_meta ORDER BY key").all() as { key: string }[];
    const keys = rows.map(r => r.key);
    expect(keys).toContain('schema_version');
    expect(keys).toContain('embedding_dim');
    expect(keys).toContain('created_at');
  });

  it('embedding_dim = 384', () => {
    const row = db.db.prepare("SELECT value FROM brain_meta WHERE key = 'embedding_dim'").get() as { value: string };
    expect(row.value).toBe('384');
  });

  it('journal_mode is memory for in-memory databases (WAL requires file-backed)', () => {
    const mode = db.db.pragma('journal_mode') as { journal_mode: string }[];
    expect(mode[0].journal_mode).toBe('memory');
  });

  it('foreign_keys = ON', () => {
    const fk = db.db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(fk[0].foreign_keys).toBe(1);
  });
});

describe('Home DB: identity resolution methods', () => {
  let db: ReturnType<typeof createTestHomeDb>;
  let originalEnv: string | undefined;

  beforeAll(() => {
    db = createTestHomeDb();
    // Insert a test identity profile + session binding
    db.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('test-agent', 'test', 1000, 1000)").run();
    db.db.prepare("INSERT INTO session_identity (session_id, identity_name, bound_at, source) VALUES ('sess-1', 'test-agent', 1000, 'spawn')").run();
  });

  afterAll(() => {
    db.close();
  });

  beforeEach(() => {
    originalEnv = process.env.CLAUDE_IDENTITY;
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.CLAUDE_IDENTITY;
    } else {
      process.env.CLAUDE_IDENTITY = originalEnv;
    }
  });

  it('getIdentityForSession resolves bound identity', () => {
    expect(db.getIdentityForSession('sess-1')).toBe('test-agent');
  });

  it('getIdentityForSession returns null for unknown session', () => {
    expect(db.getIdentityForSession('nonexistent')).toBeNull();
  });

  it('resolveIdentity uses CLAUDE_IDENTITY env var', () => {
    process.env.CLAUDE_IDENTITY = 'env-agent';
    expect(db.resolveIdentity()).toBe('env-agent');
  });

  it('resolveIdentity falls back to session binding without env var', () => {
    delete process.env.CLAUDE_IDENTITY;
    expect(db.resolveIdentity('sess-1')).toBe('test-agent');
  });

  it('resolveIdentity returns "unknown" with neither env var nor binding', () => {
    delete process.env.CLAUDE_IDENTITY;
    expect(db.resolveIdentity('nonexistent')).toBe('unknown');
  });
});

describe('Home DB: close() lifecycle', () => {
  it('close() runs without error', () => {
    const db = createTestHomeDb();
    expect(() => db.close()).not.toThrow();
  });

  it('double-close is graceful (no crash)', () => {
    const db = createTestHomeDb();
    db.close();
    // Second close may throw "database is closed" — the code wraps it in try/catch
    // so it should not throw from the caller's perspective
    expect(() => db.close()).not.toThrow();
  });
});
