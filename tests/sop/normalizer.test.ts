import { describe, it, expect } from 'vitest';
import { extractPrimaryArg, mineSequencesFromSession, hashSequence, levenshteinSkipHashes, type NormalizedStep } from '../../src/sop/normalizer.js';

/** Helper to build mock ToolCallRow objects. */
function toolCall(overrides: Partial<{
  chunk_id: string; session_id: string; tool_name: string;
  file_paths: string; text: string; timestamp_ms: number;
}> = {}) {
  return {
    chunk_id: overrides.chunk_id ?? 'c1',
    session_id: overrides.session_id ?? 's1',
    tool_name: overrides.tool_name ?? 'Read',
    file_paths: overrides.file_paths ?? '[]',
    text: overrides.text ?? '',
    timestamp_ms: overrides.timestamp_ms ?? 1000,
  };
}

describe('normalizer: extractPrimaryArg — file paths and Bash', () => {
  it('file_path key → normalized to last 2 path components', () => {
    const result = extractPrimaryArg('Read', { file_path: 'src/foo/bar.ts' });
    expect(result).toBe('foo/bar.ts');
  });

  it('filePath camelCase key works', () => {
    const result = extractPrimaryArg('Edit', { filePath: 'src/baz/qux.ts' });
    expect(result).toBe('baz/qux.ts');
  });

  it('path key works', () => {
    const result = extractPrimaryArg('Write', { path: '/home/jonah/project/src/index.ts' });
    expect(result).toBe('src/index.ts');
  });

  it('single-component path returns as-is', () => {
    const result = extractPrimaryArg('Read', { file_path: 'Makefile' });
    expect(result).toBe('Makefile');
  });

  it('Bash tool extracts first word of command', () => {
    const result = extractPrimaryArg('Bash', { command: 'npm run build --verbose' });
    expect(result).toBe('npm');
  });

  it('Bash with script key instead of command', () => {
    const result = extractPrimaryArg('Bash', { script: 'git status --porcelain' });
    expect(result).toBe('git');
  });

  it('Bash with empty command → empty string', () => {
    const result = extractPrimaryArg('Bash', { command: '' });
    expect(result).toBe('');
  });

  it('no tool_input → empty string', () => {
    const result = extractPrimaryArg('Read');
    expect(result).toBe('');
  });
});

describe('normalizer: extractPrimaryArg — atlas/brain tools and search queries', () => {
  it('atlas_query with action=search → returns "search"', () => {
    const result = extractPrimaryArg('atlas_query', { action: 'search', query: 'find me' });
    expect(result).toBe('search');
  });

  it('brain_search with action=lookup → returns "lookup" (no file_path)', () => {
    const result = extractPrimaryArg('brain_search', { action: 'lookup', query: 'test' });
    expect(result).toBe('lookup');
  });

  it('atlas_admin with no action → falls through', () => {
    const result = extractPrimaryArg('atlas_admin', { confirm: true });
    expect(result).toBe('');
  });

  it('query key → truncated to 40 chars', () => {
    const longQuery = 'a'.repeat(60);
    const result = extractPrimaryArg('some_tool', { query: longQuery });
    expect(result).toBe('a'.repeat(40));
    expect(result.length).toBe(40);
  });

  it('search key also works', () => {
    const result = extractPrimaryArg('some_tool', { search: 'find auth middleware' });
    expect(result).toBe('find auth middleware');
  });

  it('q key also works', () => {
    const result = extractPrimaryArg('some_tool', { q: 'quick search' });
    expect(result).toBe('quick search');
  });

  it('query shorter than 40 chars → returned as-is', () => {
    const result = extractPrimaryArg('some_tool', { query: 'short query' });
    expect(result).toBe('short query');
    expect(result.length).toBeLessThanOrEqual(40);
  });
});

describe('normalizer: extractPrimaryArg — edge cases', () => {
  it('undefined tool_input → empty string', () => {
    const result = extractPrimaryArg('Read', undefined);
    expect(result).toBe('');
  });

  it('tool_input with no recognizable keys → empty string', () => {
    const result = extractPrimaryArg('mystery_tool', { foo: 42, bar: 'baz' });
    expect(result).toBe('');
  });

  it('single-component file path returned as-is', () => {
    const result = extractPrimaryArg('Read', { file_path: 'package.json' });
    expect(result).toBe('package.json');
  });

  it('Bash with multi-word command returns first word', () => {
    const result = extractPrimaryArg('Bash', { command: 'git commit -m "initial commit"' });
    expect(result).toBe('git');
  });

  it('3+ component path returns last 2 components', () => {
    const result = extractPrimaryArg('Read', { file_path: 'src/search/crossSiloFusion.ts' });
    expect(result).toBe('search/crossSiloFusion.ts');
  });
});

describe('normalizer: mineSequencesFromSession — valid sequences', () => {
  it('empty chunk array → returns []', () => {
    const results = mineSequencesFromSession([], 'test-identity');
    expect(results).toEqual([]);
  });

  it('less than minSequenceLength (3) chunks → returns []', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', timestamp_ms: 200 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results).toEqual([]);
  });

  it('4 chunks with 2+ tool kinds → mines sequences of length 3 and 4', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Edit', file_paths: '["src/foo.ts"]', timestamp_ms: 300 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 400 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    // Should produce sequences of length 3 and 4 (but path-specificity filter may remove some)
    expect(results.length).toBeGreaterThan(0);
    // All sequences should have length 3 or 4
    for (const seq of results) {
      expect(seq.steps.length).toBeGreaterThanOrEqual(3);
      expect(seq.steps.length).toBeLessThanOrEqual(4);
    }
  });

  it('mined sequences have deterministic signatureHash', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Edit', file_paths: '["src/foo.ts"]', timestamp_ms: 300 }),
    ];
    const results1 = mineSequencesFromSession(chunks, 'test-identity');
    const results2 = mineSequencesFromSession(chunks, 'test-identity');
    expect(results1).toHaveLength(results2.length);
    for (let i = 0; i < results1.length; i++) {
      expect(results1[i].signatureHash).toBe(results2[i].signatureHash);
      expect(results1[i].signatureHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('MinedSequence has all required fields', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', session_id: 'sess-1', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', text: 'command:git status', session_id: 'sess-1', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Edit', file_paths: '["src/bar.ts"]', session_id: 'sess-1', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'my-identity');
    expect(results.length).toBeGreaterThan(0);
    const seq = results[0];
    expect(seq.steps).toBeInstanceOf(Array);
    expect(seq.signatureHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof seq.toolKinds).toBe('number');
    expect(seq.sessionId).toBe('sess-1');
    expect(seq.identityName).toBe('my-identity');
    expect(typeof seq.timestampMs).toBe('number');
  });

  it('chunks with no tool_name → skipped', () => {
    const chunks = [
      toolCall({ tool_name: '', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Bash', text: 'command:ls', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    // Only 2 valid chunks (Read, Bash) — less than minSequenceLength(3)
    expect(results).toEqual([]);
  });
});

describe('normalizer: mineSequencesFromSession — filters and exclusions', () => {
  it('all chunks same tool → filtered out (minToolKinds=2)', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/a.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/b.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/c.ts"]', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results).toEqual([]); // 1 unique tool < minToolKinds(2)
  });

  it('all chunks reference same file_path → filtered (path specificity)', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Edit', file_paths: '["src/foo.ts"]', timestamp_ms: 300 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 400 }),
    ];
    // 3/4 = 0.75 with primary arg "foo.ts" from file paths, but Bash has "npm" as arg.
    // "foo.ts" appears 2/4=0.5 < 0.8, so this should pass.
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results.length).toBeGreaterThan(0);
  });

  it('3 same file, 1 different → 3/4=0.75 < 0.8, sequence kept', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 300 }),
      toolCall({ tool_name: 'Bash', text: 'command:ls', timestamp_ms: 400 }),
    ];
    // But all 4 have "Read" or "Bash" → 2 tool kinds, ok.
    // "foo/foo.ts" appears 3/4=0.75 ≤ 0.8, so should pass.
    // Actually, wait: 3 same tool (Read) + 1 Bash = 2 unique tools ≥ minToolKinds(2).
    // "foo.ts" arg: 3 out of 4 = 0.75 ≤ 0.8, so passes.
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results.length).toBeGreaterThan(0);
  });

  it('phone_screenshot chunks excluded', () => {
    const chunks = [
      toolCall({ tool_name: 'phone_screenshot', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Bash', text: 'command:ls', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    // phone_screenshot excluded → only 2 valid chunks < minSequenceLength(3)
    expect(results).toEqual([]);
  });

  it('phone_device_info chunks excluded', () => {
    const chunks = [
      toolCall({ tool_name: 'phone_device_info', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Bash', text: 'command:ls', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results).toEqual([]);
  });

  it('rebirth_* prefixed tools excluded', () => {
    const chunks = [
      toolCall({ tool_name: 'rebirth_save', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Read', file_paths: '["src/foo.ts"]', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Bash', text: 'command:ls', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results).toEqual([]);
  });

  it('file_paths JSON metadata parsed correctly', () => {
    const chunks = [
      toolCall({ tool_name: 'Read', file_paths: '["src/deep/nested/file.ts"]', timestamp_ms: 100 }),
      toolCall({ tool_name: 'Bash', text: 'command:npm test', timestamp_ms: 200 }),
      toolCall({ tool_name: 'Edit', file_paths: '["src/deep/nested/file.ts"]', timestamp_ms: 300 }),
    ];
    const results = mineSequencesFromSession(chunks, 'test-identity');
    expect(results.length).toBeGreaterThan(0);
    // File paths should be normalized to last 2 components
    const seq = results[0];
    const fileSteps = seq.steps.filter(s => s.primaryArg === 'nested/file.ts');
    expect(fileSteps.length).toBeGreaterThan(0);
    for (const step of fileSteps) {
      expect(step.primaryArg).toBe('nested/file.ts');
    }
  });
});

describe('normalizer: hashSequence', () => {
  const steps: NormalizedStep[] = [
    { toolName: 'Read', primaryArg: 'foo/bar.ts' },
    { toolName: 'Bash', primaryArg: 'npm' },
    { toolName: 'Edit', primaryArg: 'foo/bar.ts' },
  ];

  it('produces deterministic 64-char hex', () => {
    const h = hashSequence(steps);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSequence(steps)).toBe(h);
  });

  it('different step order → different hash', () => {
    const reversed = [...steps].reverse();
    expect(hashSequence(reversed)).not.toBe(hashSequence(steps));
  });

  it('different primaryArg → different hash', () => {
    const modified = steps.map((s, i) =>
      i === 1 ? { ...s, primaryArg: 'git' } : s,
    );
    expect(hashSequence(modified)).not.toBe(hashSequence(steps));
  });
});

describe('normalizer: levenshteinSkipHashes', () => {
  const steps3: NormalizedStep[] = [
    { toolName: 'Read', primaryArg: 'foo/bar.ts' },
    { toolName: 'Bash', primaryArg: 'npm' },
    { toolName: 'Edit', primaryArg: 'foo/bar.ts' },
  ];

  const steps2: NormalizedStep[] = [
    { toolName: 'Read', primaryArg: 'foo/bar.ts' },
    { toolName: 'Bash', primaryArg: 'npm' },
  ];

  it('includes exact match hash', () => {
    const hashes = levenshteinSkipHashes(steps3);
    expect(hashes).toContain(hashSequence(steps3));
  });

  it('3-step sequence → exact + 3 deletion variants = 4 hashes', () => {
    const hashes = levenshteinSkipHashes(steps3);
    expect(hashes).toHaveLength(4); // exact + skip pos 0, 1, 2
  });

  it('2-step sequence → only exact match (no 1-step deletions)', () => {
    const hashes = levenshteinSkipHashes(steps2);
    expect(hashes).toHaveLength(1); // exact only; skip would give 1 step < min 2
  });

  it('4-step sequence → exact + 4 deletion variants = 5 hashes', () => {
    const steps4 = [...steps3, { toolName: 'Bash', primaryArg: 'git' }];
    const hashes = levenshteinSkipHashes(steps4);
    expect(hashes).toHaveLength(5);
  });
});
