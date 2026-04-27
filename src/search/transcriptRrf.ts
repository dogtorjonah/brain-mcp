/**
 * Reciprocal Rank Fusion for hybrid BM25 + vector retrieval.
 *
 * For each input list (BM25 hits, vector hits), a hit at rank `r` contributes
 * `weight / (k + r)` to its chunk's fused score. Final ranking sorts by
 * descending fused score.
 *
 * Why RRF (over CombSUM, CombMNZ, normalised-weighted-sum etc):
 *   - Rank-based: immune to score-scale mismatch between BM25 (log-TF, unbounded)
 *     and cosine distance (0..2). We'd otherwise need per-retriever score
 *     normalisation, which is fragile when result sets are small.
 *   - Known-good on transcript-shaped data: literal-heavy tool calls dominate
 *     the BM25 side, prose dominates the vector side; RRF fuses both without
 *     either retriever swamping the other.
 *   - k=60 is the paper's default and works across corpus sizes from ~hundreds
 *     to millions of docs. Smaller k = more rank-skew favouring top-1; larger k
 *     = flatter fusion. No reason to tune absent eval data.
 *
 * "First-occurrence-wins per list" means each input list contributes exactly
 * one rank per chunk — so a chunk that shows up twice at different ranks in
 * the same retriever (shouldn't happen with our query shapes but defensive)
 * uses its BEST rank, not an averaged one.
 */

import type { Bm25Hit, VectorHit } from './transcriptStore.js';

export const RRF_K = 60;

export interface RrfWeights {
  bm25: number;
  vector: number;
}

export const DEFAULT_RRF_WEIGHTS: RrfWeights = {
  bm25: 1,
  vector: 1,
};

export interface FusedHit {
  chunkId: string;
  fusedScore: number;
  bm25Rank: number | null;
  vectorRank: number | null;
  /** Best BM25 score seen (lower = more relevant in FTS5 convention). */
  bm25Score: number | null;
  /** Best vector distance seen (lower = closer). */
  vectorDistance: number | null;
}

export interface RrfOptions {
  bm25Hits: Bm25Hit[];
  vectorHits: VectorHit[];
  weights?: RrfWeights;
  k?: number;
  /** Cap the returned list. 0 / undefined returns everything. */
  limit?: number;
}

/**
 * Fuse BM25 + vector hit lists via Reciprocal Rank Fusion.
 *
 * Returns hits sorted by descending fusedScore. Chunks that appear in only
 * one retriever still score via that retriever's contribution alone — this
 * is correct behaviour for hybrid retrieval (a literal-symbol match via BM25
 * should still rank even if the dense embedding missed it).
 */
export function reciprocalRankFuse(opts: RrfOptions): FusedHit[] {
  const weights = opts.weights ?? DEFAULT_RRF_WEIGHTS;
  const k = opts.k ?? RRF_K;

  const accum = new Map<string, FusedHit>();

  for (const h of opts.bm25Hits) {
    const contribution = weights.bm25 / (k + h.rank);
    const existing = accum.get(h.chunkId);
    if (!existing) {
      accum.set(h.chunkId, {
        chunkId: h.chunkId,
        fusedScore: contribution,
        bm25Rank: h.rank,
        vectorRank: null,
        bm25Score: h.score,
        vectorDistance: null,
      });
    } else if (existing.bm25Rank === null || h.rank < existing.bm25Rank) {
      // First-occurrence-wins: the BETTER (lower) rank is the one that
      // actually counts. A chunk can't appear twice in one retriever in
      // our current query shapes, but the defensive path keeps fusion
      // stable if we ever concat multiple BM25 queries.
      existing.fusedScore += contribution;
      existing.bm25Rank = h.rank;
      existing.bm25Score = h.score;
    }
  }

  for (const h of opts.vectorHits) {
    const contribution = weights.vector / (k + h.rank);
    const existing = accum.get(h.chunkId);
    if (!existing) {
      accum.set(h.chunkId, {
        chunkId: h.chunkId,
        fusedScore: contribution,
        bm25Rank: null,
        vectorRank: h.rank,
        bm25Score: null,
        vectorDistance: h.distance,
      });
    } else if (existing.vectorRank === null || h.rank < existing.vectorRank) {
      existing.fusedScore += contribution;
      existing.vectorRank = h.rank;
      existing.vectorDistance = h.distance;
    }
  }

  const fused = Array.from(accum.values()).sort((a, b) => b.fusedScore - a.fusedScore);
  if (opts.limit && opts.limit > 0) return fused.slice(0, opts.limit);
  return fused;
}
