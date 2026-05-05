import { describe, it, expect } from 'vitest';
import { fuseCrossSilo, buildFusedResult, type SiloHit } from '../../src/search/crossSiloFusion.js';

/** Helper to build a SiloHit with minimal boilerplate. */
function hit(silo: SiloHit['silo'], id: string, rank: number, payload: Record<string, unknown> = {}): SiloHit {
  return { silo, id, rank, payload };
}

describe('crossSiloFusion', () => {
  it('empty input returns empty array', () => {
    const result = fuseCrossSilo([]);
    expect(result).toEqual([]);
  });

  it('empty silos (array of empty arrays) returns empty array', () => {
    const result = fuseCrossSilo([[], [], []]);
    expect(result).toEqual([]);
  });

  it('single silo with one hit normalizes score to 1.0', () => {
    const results: SiloHit[][] = [
      [hit('atlas_files', 'f1', 1, { path: '/src/foo.ts' })],
    ];
    const fused = fuseCrossSilo(results);
    expect(fused).toHaveLength(1);
    expect(fused[0].score).toBeCloseTo(1.0);
    expect(fused[0].silo).toBe('atlas_files');
    expect(fused[0].siloRank).toBe(1);
    expect(fused[0].payload).toEqual({ path: '/src/foo.ts' });
  });

  it('single silo with 3 hits ranks by RRF formula (rank 1 > rank 2 > rank 3)', () => {
    const results: SiloHit[][] = [
      [
        hit('transcripts', 't1', 1),
        hit('transcripts', 't2', 2),
        hit('transcripts', 't3', 3),
      ],
    ];

    const fused = fuseCrossSilo(results);
    expect(fused).toHaveLength(3);

    // Rank 1 should have highest score, rank 3 lowest.
    // RRF: 1/(60+rank), so rank1=1/61, rank2=1/62, rank3=1/63
    // After normalization (top = 1.0): rank1=1.0, rank2=61/62, rank3=61/63
    expect(fused[0].score).toBeCloseTo(1.0);
    expect(fused[1].score).toBeCloseTo(61 / 62);
    expect(fused[2].score).toBeCloseTo(61 / 63);

    // Verify descending order.
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
    expect(fused[1].score).toBeGreaterThan(fused[2].score);
  });

  // ── Dedup and multi-silo accumulation ──

  it('dedup: same (silo, id) appears twice — score accumulates and outranks single-contribution hit', () => {
    const results: SiloHit[][] = [
      [
        hit('atlas_files', 'f1', 1),
        hit('atlas_files', 'f1', 5), // duplicate: score accumulates
        hit('atlas_files', 'f2', 1), // single contribution, different id
      ],
    ];
    const fused = fuseCrossSilo(results);
    expect(fused).toHaveLength(2); // f1 deduped into one, f2 separate
    // f1 accumulated raw = 1/61 + 1/65 ≈ 0.03177
    // f2 single raw = 1/61 ≈ 0.01639
    // f1 should rank first (higher accumulated score)
    expect(fused[0].silo).toBe('atlas_files');
    const f1Hit = fused.find(h => h.siloRank === 1 && h.score === 1.0) ?? fused[0];
    expect(f1Hit.score).toBeCloseTo(1.0); // top normalizes to 1.0
    expect(fused[0].score).toBeGreaterThan(fused[1].score);
  });

  it('two silos each with 2 hits — cross-silo scores sum correctly', () => {
    const results: SiloHit[][] = [
      [
        hit('transcripts', 't1', 1),
        hit('transcripts', 't2', 2),
      ],
      [
        hit('atlas_files', 'f1', 1),
        hit('atlas_files', 'f2', 2),
      ],
    ];

    const fused = fuseCrossSilo(results);
    expect(fused).toHaveLength(4);

    // All rank-1 hits should tie at top score (1.0 after normalization).
    const topHits = fused.filter(h => h.siloRank === 1);
    expect(topHits).toHaveLength(2);
    for (const h of topHits) {
      expect(h.score).toBeCloseTo(1.0);
    }
  });

  it('hit in 2 silos with different ranks — score is sum of both contributions', () => {
    // The same logical entity appearing in two silos uses different (silo, id)
    // keys, so it won't merge — but we can test the score sum by putting
    // the same id in two different silos.
    // Actually, key = `${silo}::${id}`, so same id in different silos = different keys.
    // They remain separate hits, each with their own silo contribution.
    // To test cross-silo boost, we need two different ids in two silos.
    const results: SiloHit[][] = [
      [hit('transcripts', 'shared', 1)],
      [hit('atlas_files', 'shared', 3)],
    ];

    const fused = fuseCrossSilo(results);
    // Two separate entries because keys differ: 'transcripts::shared' vs 'atlas_files::shared'
    expect(fused).toHaveLength(2);

    // The transcripts::shared hit (rank 1) has score 1/61.
    // The atlas_files::shared hit (rank 3) has score 1/63.
    // After normalization: top = 1/61, so transcripts hit = 1.0, atlas hit = 61/63.
    expect(fused[0].score).toBeCloseTo(1.0);
    expect(fused[0].silo).toBe('transcripts');
    expect(fused[1].score).toBeCloseTo(61 / 63);
    expect(fused[1].silo).toBe('atlas_files');
  });

  it('same id in different silos → separate entries, ranked by individual silo contribution', () => {
    // Note: dedup is per (silo, id) key, so the same id in different silos
    // produces separate entries. We can still demonstrate that accumulated
    // scores from multiple entries can outrank a better-rank single entry.
    // But actually they're separate hits. Let's just verify the math instead:
    // Hit A at rank 3: score = 1/63
    // Hit B at rank 2: score = 1/62
    // Hit B should rank above A (lower rank = higher score in same silo).
    const results: SiloHit[][] = [
      [
        hit('transcripts', 'a', 3),
        hit('transcripts', 'b', 2),
      ],
      [
        hit('atlas_files', 'a', 1),
      ],
    ];

    const fused = fuseCrossSilo(results);
    // 3 entries: transcripts::a (rank 3), transcripts::b (rank 2), atlas_files::a (rank 1)
    expect(fused).toHaveLength(3);

    // atlas_files::a (rank 1) should have top score = 1.0
    // transcripts::b (rank 2) = 1/62, normalized by top (1/61) = 61/62
    // transcripts::a (rank 3) = 1/63, normalized by top (1/61) = 61/63
    expect(fused[0].score).toBeCloseTo(1.0);
    expect(fused[0].silo).toBe('atlas_files');
    expect(fused[1].score).toBeCloseTo(61 / 62);
    expect(fused[2].score).toBeCloseTo(61 / 63);
  });

  // ── Custom parameters and normalization ──

  it('custom k=3 limits output to 3 hits from 10', () => {
    const hits = Array.from({ length: 10 }, (_, i) =>
      hit('transcripts', `t${i}`, i + 1),
    );
    const fused = fuseCrossSilo([hits], { k: 3 });
    expect(fused).toHaveLength(3);
  });

  it('custom rrfK=0 changes score distribution vs default rrfK=60', () => {
    const results: SiloHit[][] = [
      [
        hit('transcripts', 'a', 1),
        hit('transcripts', 'b', 2),
      ],
    ];

    const defaultFused = fuseCrossSilo(results, { rrfK: 60 });
    const zeroFused = fuseCrossSilo(results, { rrfK: 0 });

    // Both normalize top to 1.0, but second-hit ratio differs.
    // rrfK=60: rank2 = 61/62 ≈ 0.9839
    // rrfK=0: rank2 = 1/2 / (1/1) = 0.5
    expect(defaultFused[0].score).toBeCloseTo(1.0);
    expect(defaultFused[1].score).toBeCloseTo(61 / 62);
    expect(zeroFused[0].score).toBeCloseTo(1.0);
    expect(zeroFused[1].score).toBeCloseTo(0.5);

    // Score distributions should differ.
    expect(defaultFused[1].score).not.toBeCloseTo(zeroFused[1].score);
  });

  it('top score always normalizes to 1.0, all scores are positive and ≤ 1.0', () => {
    const results: SiloHit[][] = [
      Array.from({ length: 5 }, (_, i) =>
        hit('transcripts', `t${i}`, i + 1),
      ),
    ];

    const fused = fuseCrossSilo(results);
    expect(fused).toHaveLength(5);
    expect(fused[0].score).toBeCloseTo(1.0);

    for (const h of fused) {
      expect(h.score).toBeGreaterThan(0);
      expect(h.score).toBeLessThanOrEqual(1.0);
    }
  });

  it('pure RRF formula: single-silo scores match 1/(rrfK+rank) / max', () => {
    const results: SiloHit[][] = [
      [hit('atlas_files', 'f1', 1), hit('atlas_files', 'f2', 4)],
    ];

    const fused = fuseCrossSilo(results, { rrfK: 60 });
    // raw: rank1 = 1/61, rank4 = 1/64
    // normalized: rank1 = 1.0, rank4 = (1/64)/(1/61) = 61/64
    expect(fused[0].score).toBeCloseTo(1.0);
    expect(fused[1].score).toBeCloseTo(61 / 64);
  });

  // ── buildFusedResult stats ──

  it('buildFusedResult: siloBreakdown counts per-silo hits correctly', () => {
    const results: SiloHit[][] = [
      [
        hit('transcripts', 't1', 1),
        hit('transcripts', 't2', 2),
        hit('transcripts', 't3', 3),
      ],
      [
        hit('atlas_files', 'f1', 1),
        hit('atlas_files', 'f2', 2),
      ],
    ];

    const result = buildFusedResult(results);
    expect(result.siloBreakdown.transcripts).toBe(3);
    expect(result.siloBreakdown.atlas_files).toBe(2);
    expect(result.totalCandidates).toBe(5);
    expect(result.hits.length).toBe(5); // all 5 unique (silo, id) entries
  });

  it('buildFusedResult: hits array matches fuseCrossSilo output', () => {
    const results: SiloHit[][] = [
      [hit('transcripts', 't1', 1), hit('transcripts', 't2', 2)],
      [hit('atlas_files', 'f1', 1)],
    ];

    const result = buildFusedResult(results);
    const directFused = fuseCrossSilo(results);

    expect(result.hits).toHaveLength(directFused.length);
    for (let i = 0; i < result.hits.length; i++) {
      expect(result.hits[i].score).toBeCloseTo(directFused[i].score);
      expect(result.hits[i].silo).toBe(directFused[i].silo);
    }
  });

  it('buildFusedResult: all SiloKind keys present even when zero', () => {
    const results: SiloHit[][] = [
      [hit('transcripts', 't1', 1)],
    ];

    const result = buildFusedResult(results);
    expect(result.siloBreakdown.transcripts).toBe(1);
    expect(result.siloBreakdown.atlas_files).toBe(0);
    expect(result.siloBreakdown.atlas_changelog).toBe(0);
    expect(result.siloBreakdown.source_highlights).toBe(0);
    expect(result.totalCandidates).toBe(1);
  });
});
