import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestEdgeEmitter } from '../helpers.js';

describe('EdgeEmitter: emit, emitBatch, emitLookup', () => {
  let emitter: ReturnType<typeof createTestEdgeEmitter>['emitter'];
  let homeDb: ReturnType<typeof createTestEdgeEmitter>['homeDb'];

  beforeAll(() => {
    const setup = createTestEdgeEmitter();
    emitter = setup.emitter;
    homeDb = setup.homeDb;
    // Insert identity profile (required FK for atlas_identity_edges)
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('test-agent', 'test', 1000, 1000)").run();
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('other-agent', 'test', 1000, 1000)").run();
  });

  afterAll(() => {
    homeDb.close();
  });

  it('emit a single commit edge → returns numeric ID', () => {
    const id = emitter.emit({
      identityName: 'test-agent',
      workspace: 'brain-mcp',
      filePath: 'src/foo.ts',
      kind: 'commit',
      ts: Date.now(),
    });
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('emitted edge has correct fields', () => {
    const ts = Date.now();
    emitter.emit({
      identityName: 'test-agent',
      workspace: 'brain-mcp',
      filePath: 'src/bar.ts',
      kind: 'commit',
      detail: 'added purpose field',
      sessionId: 'sess-test',
      ts,
    });

    const edges = emitter.query({ filePath: 'src/bar.ts' });
    expect(edges).toHaveLength(1);
    const edge = edges[0];
    expect(edge.identityName).toBe('test-agent');
    expect(edge.workspace).toBe('brain-mcp');
    expect(edge.filePath).toBe('src/bar.ts');
    expect(edge.kind).toBe('commit');
    expect(edge.detail).toBe('added purpose field');
    expect(edge.sessionId).toBe('sess-test');
    expect(edge.ts).toBe(ts);
  });

  it('emitBatch with 3 edges → returns 3 IDs, all stored', () => {
    const ids = emitter.emitBatch([
      { identityName: 'test-agent', workspace: 'ws-1', filePath: 'a.ts', kind: 'commit', ts: 1 },
      { identityName: 'test-agent', workspace: 'ws-1', filePath: 'b.ts', kind: 'surfaced', detail: 'race condition', ts: 2 },
      { identityName: 'other-agent', workspace: 'ws-2', filePath: 'c.ts', kind: 'lookup', ts: 3 },
    ]);
    expect(ids).toHaveLength(3);
    expect(ids[0]).toBeGreaterThan(0);

    const all = emitter.query({ limit: 100 });
    const batch = all.filter(e => e.filePath === 'a.ts' || e.filePath === 'b.ts' || e.filePath === 'c.ts');
    expect(batch).toHaveLength(3);
  });

  it('emitBatch is atomic (all edges stored)', () => {
    const before = emitter.query({ identityName: 'test-agent', limit: 1000 }).length;
    emitter.emitBatch([
      { identityName: 'test-agent', workspace: 'ws', filePath: 'x.ts', kind: 'commit', ts: 10 },
      { identityName: 'test-agent', workspace: 'ws', filePath: 'y.ts', kind: 'commit', ts: 11 },
    ]);
    const after = emitter.query({ identityName: 'test-agent', limit: 1000 }).length;
    expect(after - before).toBe(2);
  });

  it('emitLookup creates a lookup edge', () => {
    emitter.emitLookup({
      identityName: 'test-agent',
      workspace: 'test-ws',
      filePath: 'src/lookup.ts',
      sessionId: 'sess-lookup',
    });

    const edges = emitter.query({ kind: 'lookup', filePath: 'src/lookup.ts' });
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('lookup');
    expect(edges[0].identityName).toBe('test-agent');
  });

  it('emitLookup ts is approximately Date.now()', () => {
    const before = Date.now();
    emitter.emitLookup({
      identityName: 'test-agent',
      workspace: 'test-ws',
      filePath: 'src/timing.ts',
    });
    const after = Date.now();

    const edges = emitter.query({ kind: 'lookup', filePath: 'src/timing.ts' });
    expect(edges).toHaveLength(1);
    expect(edges[0].ts).toBeGreaterThanOrEqual(before);
    expect(edges[0].ts).toBeLessThanOrEqual(after);
  });
});

describe('EdgeEmitter: emitCommitEdges full lifecycle', () => {
  let emitter: ReturnType<typeof createTestEdgeEmitter>['emitter'];
  let homeDb: ReturnType<typeof createTestEdgeEmitter>['homeDb'];

  beforeAll(() => {
    const setup = createTestEdgeEmitter();
    emitter = setup.emitter;
    homeDb = setup.homeDb;
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('commit-agent', 'test', 1000, 1000)").run();
    // Insert specialty_signatures row
    homeDb.db.prepare("INSERT OR IGNORE INTO specialty_signatures (identity_name, top_clusters_json, top_patterns_json, top_files_json, hazards_surfaced, hazards_resolved, computed_at, dirty) VALUES ('commit-agent', '[]', '[]', '[]', 0, 0, 1000, 0)").run();
  });

  afterAll(() => {
    homeDb.close();
  });

  it('emitCommitEdges with hazards and patterns → correct edge count', () => {
    const ids = emitter.emitCommitEdges({
      identityName: 'commit-agent',
      workspace: 'test-ws',
      filePath: 'src/foo.ts',
      changelogId: 42,
      sessionId: 'sess-commit',
      hazardsAdded: ['race condition', 'null pointer'],
      hazardsRemoved: ['stale cache'],
      patternsAdded: ['observer pattern'],
    });
    // 1 commit + 2 surfaced + 1 resolved + 1 pattern_added = 5
    expect(ids).toHaveLength(5);
  });

  it('commit edge has kind=commit and changelogId', () => {
    const edges = emitter.query({ identityName: 'commit-agent', kind: 'commit', limit: 1 });
    expect(edges).toHaveLength(1);
    expect(edges[0].kind).toBe('commit');
    expect(edges[0].changelogId).toBe(42);
  });

  it('surfaced edges have correct kind and detail', () => {
    const surfaced = emitter.query({ identityName: 'commit-agent', kind: 'surfaced' });
    const details = surfaced.map(e => e.detail).sort();
    expect(details).toEqual(['null pointer', 'race condition']);
  });

  it('resolved edge has kind=resolved', () => {
    const resolved = emitter.query({ identityName: 'commit-agent', kind: 'resolved' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0].detail).toBe('stale cache');
  });

  it('pattern_added edge has kind=pattern_added', () => {
    const patterns = emitter.query({ identityName: 'commit-agent', kind: 'pattern_added' });
    expect(patterns).toHaveLength(1);
    expect(patterns[0].detail).toBe('observer pattern');
  });

  it('pattern_removed edge has kind=pattern_removed', () => {
    // Add a fresh commit with patternsRemoved
    emitter.emitCommitEdges({
      identityName: 'commit-agent',
      workspace: 'test-ws',
      filePath: 'src/baz.ts',
      changelogId: 50,
      patternsRemoved: ['anti-pattern'],
    });
    const removed = emitter.query({ identityName: 'commit-agent', kind: 'pattern_removed' });
    expect(removed).toHaveLength(1);
    expect(removed[0].detail).toBe('anti-pattern');
    expect(removed[0].filePath).toBe('src/baz.ts');
  });

  it('specialty_signatures.dirty set to 1 after emitCommitEdges', () => {
    const row = homeDb.db.prepare("SELECT dirty FROM specialty_signatures WHERE identity_name = 'commit-agent'").get() as { dirty: number };
    expect(row.dirty).toBe(1);
  });

  it('no hazards/patterns → only commit edge', () => {
    const before = emitter.query({ identityName: 'commit-agent', limit: 1000 }).length;
    const ids = emitter.emitCommitEdges({
      identityName: 'commit-agent',
      workspace: 'test-ws',
      filePath: 'src/clean.ts',
      changelogId: 99,
    });
    expect(ids).toHaveLength(1);
    const after = emitter.query({ identityName: 'commit-agent', limit: 1000 }).length;
    expect(after - before).toBe(1);
  });

  it('all edges share same timestamp (within 1ms)', () => {
    const ids = emitter.emitCommitEdges({
      identityName: 'commit-agent',
      workspace: 'test-ws',
      filePath: 'src/sync.ts',
      changelogId: 100,
      hazardsAdded: ['bug'],
    });
    expect(ids.length).toBeGreaterThan(0);
    const edges = emitter.query({ changelogId: 100 });
    expect(edges.length).toBe(ids.length);
    const timestamps = edges.map(e => e.ts);
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    expect(max - min).toBeLessThanOrEqual(1);
  });
});

describe('EdgeEmitter: query with filter combinations', () => {
  let emitter: ReturnType<typeof createTestEdgeEmitter>['emitter'];
  let homeDb: ReturnType<typeof createTestEdgeEmitter>['homeDb'];

  beforeAll(() => {
    const setup = createTestEdgeEmitter();
    emitter = setup.emitter;
    homeDb = setup.homeDb;
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('alice', 'a', 1000, 1000)").run();
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('bob', 'b', 1000, 1000)").run();

    // Seed edges: alice in ws-1, bob in ws-2
    emitter.emit({ identityName: 'alice', workspace: 'ws-1', filePath: 'a.ts', kind: 'commit', ts: 100 });
    emitter.emit({ identityName: 'alice', workspace: 'ws-1', filePath: 'b.ts', kind: 'surfaced', detail: 'bug', ts: 200 });
    emitter.emit({ identityName: 'bob', workspace: 'ws-2', filePath: 'c.ts', kind: 'commit', ts: 300 });
    emitter.emit({ identityName: 'alice', workspace: 'ws-1', filePath: 'a.ts', kind: 'resolved', detail: 'bug', ts: 400 });
    emitter.emit({ identityName: 'bob', workspace: 'ws-2', filePath: 'd.ts', kind: 'lookup', ts: 500 });
  });

  afterAll(() => {
    homeDb.close();
  });

  it('query by identityName → only that identity', () => {
    const alice = emitter.query({ identityName: 'alice' });
    expect(alice.length).toBe(3);
    for (const e of alice) expect(e.identityName).toBe('alice');
  });

  it('query by workspace → only that workspace', () => {
    const ws1 = emitter.query({ workspace: 'ws-1' });
    expect(ws1.length).toBe(3);
    for (const e of ws1) expect(e.workspace).toBe('ws-1');
  });

  it('query by filePath → exact match', () => {
    const a = emitter.query({ filePath: 'a.ts' });
    expect(a.length).toBe(2);
    for (const e of a) expect(e.filePath).toBe('a.ts');
  });

  it('query by kind → only that kind', () => {
    const surfaced = emitter.query({ kind: 'surfaced' });
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0].kind).toBe('surfaced');
  });

  it('query by since/until time range', () => {
    // ts: 100, 200, 300, 400, 500
    // since=150, until=350 → ts 200 and 300 = 2 edges
    const edges = emitter.query({ since: 150, until: 350 });
    expect(edges).toHaveLength(2);
    expect(edges[0].ts).toBe(300); // DESC order
    expect(edges[1].ts).toBe(200);
  });

  it('query with multiple filters → intersection', () => {
    const edges = emitter.query({ identityName: 'alice', kind: 'commit' });
    expect(edges).toHaveLength(1);
    expect(edges[0].filePath).toBe('a.ts');
  });

  it('query with no filters → all edges, ts DESC, limited to default', () => {
    const all = emitter.query({ limit: 100 });
    expect(all.length).toBe(5);
    for (let i = 1; i < all.length; i++) {
      expect(all[i - 1].ts).toBeGreaterThanOrEqual(all[i].ts);
    }
  });

  it('getFileEdges returns edges for specific file', () => {
    const edges = emitter.getFileEdges('ws-1', 'a.ts');
    expect(edges.length).toBe(2);
  });

  it('getIdentityEdges returns edges for identity', () => {
    const edges = emitter.getIdentityEdges('bob');
    expect(edges.length).toBe(2);
  });
});

describe('EdgeEmitter: getOpenHazards', () => {
  let emitter: ReturnType<typeof createTestEdgeEmitter>['emitter'];
  let homeDb: ReturnType<typeof createTestEdgeEmitter>['homeDb'];

  beforeAll(() => {
    const setup = createTestEdgeEmitter();
    emitter = setup.emitter;
    homeDb = setup.homeDb;
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('hazards-agent', 'test', 1000, 1000)").run();

    // Surface 'race-condition' then resolve it
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'a.ts', kind: 'surfaced', detail: 'race-condition', changelogId: 1, ts: 100 });
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'a.ts', kind: 'resolved', detail: 'race-condition', changelogId: 2, ts: 200 });
    // Surface 'mem-leak' — no resolution
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'b.ts', kind: 'surfaced', detail: 'mem-leak', changelogId: 3, ts: 300 });
    // Surface 'dead-code' in ws-b
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-b', filePath: 'c.ts', kind: 'surfaced', detail: 'dead-code', changelogId: 4, ts: 400 });
    // Two hazards on same file: 'null-deref' (open) and 'oom' (open)
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'd.ts', kind: 'surfaced', detail: 'null-deref', changelogId: 5, ts: 500 });
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'd.ts', kind: 'surfaced', detail: 'oom', changelogId: 6, ts: 600 });
  });

  afterAll(() => {
    homeDb.close();
  });

  it('resolved hazard is NOT open', () => {
    const open = emitter.getOpenHazards('hazards-agent');
    const rc = open.find(h => h.hazard === 'race-condition');
    expect(rc).toBeUndefined();
  });

  it('unresolved hazard IS open', () => {
    const open = emitter.getOpenHazards('hazards-agent');
    const ml = open.find(h => h.hazard === 'mem-leak');
    expect(ml).toBeDefined();
    expect(ml!.filePath).toBe('b.ts');
  });

  it('workspace filter scopes results', () => {
    const open = emitter.getOpenHazards('hazards-agent', { workspace: 'ws-b' });
    expect(open).toHaveLength(1);
    expect(open[0].hazard).toBe('dead-code');
  });

  it('re-occurrence: surfaced after resolved → IS open', () => {
    // 'race-condition' was resolved at ts=200. Surface it again.
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'a.ts', kind: 'surfaced', detail: 'race-condition', changelogId: 10, ts: 700 });
    const open = emitter.getOpenHazards('hazards-agent');
    const rc = open.find(h => h.hazard === 'race-condition');
    expect(rc).toBeDefined();
  });

  it('two hazards on same file, one open one resolved → only open returned', () => {
    // Resolve 'oom'
    emitter.emit({ identityName: 'hazards-agent', workspace: 'ws-a', filePath: 'd.ts', kind: 'resolved', detail: 'oom', changelogId: 11, ts: 800 });
    const open = emitter.getOpenHazards('hazards-agent');
    const dOpen = open.filter(h => h.filePath === 'd.ts');
    expect(dOpen).toHaveLength(1);
    expect(dOpen[0].hazard).toBe('null-deref');
  });

  it('open hazard fields populated', () => {
    const open = emitter.getOpenHazards('hazards-agent');
    const ml = open.find(h => h.hazard === 'mem-leak')!;
    expect(ml.workspace).toBe('ws-a');
    expect(ml.filePath).toBe('b.ts');
    expect(ml.hazard).toBe('mem-leak');
    expect(ml.surfacedAt).toBe(300);
    expect(ml.changelogId).toBe(3);
  });

  it('limit parameter restricts results', () => {
    const open = emitter.getOpenHazards('hazards-agent', { limit: 1 });
    expect(open.length).toBeLessThanOrEqual(1);
  });
});

describe('EdgeEmitter: countByKind and getTopFiles', () => {
  let emitter: ReturnType<typeof createTestEdgeEmitter>['emitter'];
  let homeDb: ReturnType<typeof createTestEdgeEmitter>['homeDb'];

  beforeAll(() => {
    const setup = createTestEdgeEmitter();
    emitter = setup.emitter;
    homeDb = setup.homeDb;
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('count-agent', 'test', 1000, 1000)").run();
    homeDb.db.prepare("INSERT OR IGNORE INTO identity_profiles (name, blurb, created_at, updated_at) VALUES ('empty-agent', 'test', 1000, 1000)").run();

    // 4 commits, 2 surfaced, 1 resolved, 2 lookups
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'a.ts', kind: 'commit', ts: 100 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'b.ts', kind: 'commit', ts: 110 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'a.ts', kind: 'commit', ts: 120 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'a.ts', kind: 'commit', ts: 130 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'c.ts', kind: 'surfaced', detail: 'bug1', ts: 200 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'd.ts', kind: 'surfaced', detail: 'bug2', ts: 210 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'c.ts', kind: 'resolved', detail: 'bug1', ts: 300 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'e.ts', kind: 'lookup', ts: 400 });
    emitter.emit({ identityName: 'count-agent', workspace: 'ws', filePath: 'f.ts', kind: 'lookup', ts: 500 });
  });

  afterAll(() => {
    homeDb.close();
  });

  it('countByKind aggregates correctly', () => {
    const counts = emitter.countByKind('count-agent');
    expect(counts.commit).toBe(4);
    expect(counts.surfaced).toBe(2);
    expect(counts.resolved).toBe(1);
    expect(counts.lookup).toBe(2);
    expect(counts.pattern_added).toBe(0);
  });

  it('countByKind for identity with no edges → all zeros', () => {
    const counts = emitter.countByKind('empty-agent');
    expect(counts.commit).toBe(0);
    expect(counts.surfaced).toBe(0);
  });

  it('getTopFiles ranked by edge count DESC', () => {
    const top = emitter.getTopFiles('count-agent');
    // a.ts: 3 commits (non-lookup) = edgeCount 3
    // c.ts: surfaced + resolved (non-lookup) = edgeCount 2
    // b.ts: 1 commit = edgeCount 1
    // d.ts: 1 surfaced = edgeCount 1
    // e.ts, f.ts: lookup only → excluded
    expect(top.length).toBe(4);
    expect(top[0].filePath).toBe('a.ts');
    expect(top[0].edgeCount).toBe(3);
    // Verify full DESC ordering
    for (let i = 1; i < top.length; i++) {
      expect(top[i - 1].edgeCount).toBeGreaterThanOrEqual(top[i].edgeCount);
    }
  });

  it('getTopFiles excludes lookup edges from count', () => {
    const top = emitter.getTopFiles('count-agent');
    // e.ts and f.ts only have lookups → excluded
    const paths = top.map(t => t.filePath);
    expect(paths).not.toContain('e.ts');
    expect(paths).not.toContain('f.ts');
  });

  it('getTopFiles returns lastTouchAt as max(ts)', () => {
    const top = emitter.getTopFiles('count-agent');
    const a = top.find(t => t.filePath === 'a.ts')!;
    // 3 commits at ts 100, 120, 130 → lastTouchAt = 130
    expect(a.lastTouchAt).toBe(130);
  });
});
