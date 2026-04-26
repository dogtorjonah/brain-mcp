/**
 * Cross-silo Reciprocal Rank Fusion for brain_search.
 *
 * brain_search queries up to four silos (transcripts, atlas_files,
 * atlas_changelog, source_highlights) in parallel, each producing a ranked
 * hit list via its own BM25+vector RRF fusion. This module performs one
 * final RRF pass across silo results, producing a unified ranked list where
 * each hit knows which silo it came from.
 *
 * The math is identical to the per-silo RRF (1/(k+rank), k=60) but applied
 * across silos instead of across retrievers. A hit that appears in multiple
 * silos (e.g., a transcript chunk about a file that also matches in atlas)
 * accumulates score from both, naturally boosting cross-cutting results.
 */

// ── Types ──────────────────────────────────────────────────────────────

/** Which knowledge silo a hit came from. */
export type SiloKind =
  | 'transcripts'
  | 'atlas_files'
  | 'atlas_changelog'
  | 'source_highlights';

/** A hit from any silo, tagged with its origin. */
export interface CrossSiloHit {
  /** Origin silo. */
  silo: SiloKind;
  /** Fused RRF score (higher = more relevant). */
  score: number;
  /** Rank within the silo's own result list (1-based). */
  siloRank: number;
  /** Silo-specific payload. Structure depends on `silo`. */
  payload: Record<string, unknown>;
}

/** A hit from a single silo, before cross-silo fusion. */
export interface SiloHit<T = Record<string, unknown>> {
  /** The silo this hit came from. */
  silo: SiloKind;
  /** An opaque identifier unique within this silo (used for dedup). */
  id: string;
  /** Rank within the silo's own results (1-based, lower = more relevant). */
  rank: number;
  /** Silo-specific payload. */
  payload: T;
}

/** Result of cross-silo fusion. */
export interface FusedSearchResult {
  hits: CrossSiloHit[];
  /** How many hits came from each silo (before final top-K cut). */
  siloBreakdown: Record<SiloKind, number>;
  /** Total candidates before fusion. */
  totalCandidates: number;
}

// ── Constants ──────────────────────────────────────────────────────────

/** RRF k parameter — same as per-silo RRF (standard paper default). */
const DEFAULT_RRF_K = 60;

/** Default max results after fusion. */
const DEFAULT_K = 20;

// ── Fusion ─────────────────────────────────────────────────────────────

/**
 * Fuse hits from multiple silos into a single ranked list.
 *
 * Each silo contributes at most one rank per unique (silo, id) pair.
 * The final score for a hit is the sum of 1/(k + rank) contributions from
 * every silo where it appeared. Hits that only appear in one silo still
 * score via that silo's contribution alone.
 */
export function fuseCrossSilo<T = Record<string, unknown>>(
  siloResults: SiloHit<T>[][],
  opts?: { k?: number; rrfK?: number },
): CrossSiloHit[] {
  const maxK = opts?.k ?? DEFAULT_K;
  const rrfK = opts?.rrfK ?? DEFAULT_RRF_K;

  // Accumulate scores keyed by (silo + id) for dedup within a silo,
  // but allow the same logical entity to score from different silos.
  const accum = new Map<string, CrossSiloHit>();

  for (const hits of siloResults) {
    for (const hit of hits) {
      const key = `${hit.silo}::${hit.id}`;
      const contribution = 1 / (rrfK + hit.rank);

      const existing = accum.get(key);
      if (!existing) {
        accum.set(key, {
          silo: hit.silo,
          score: contribution,
          siloRank: hit.rank,
          payload: hit.payload as Record<string, unknown>,
        });
      } else {
        // First-occurrence-wins for rank; accumulate score
        // (shouldn't happen with well-formed input, but defensive)
        existing.score += contribution;
      }
    }
  }

  const ranked = [...accum.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxK);

  // Normalize scores so top hit = 1.0
  const topScore = ranked[0]?.score ?? 0;
  if (topScore > 0) {
    for (const hit of ranked) {
      hit.score = hit.score / topScore;
    }
  }

  return ranked;
}

/**
 * Build a FusedSearchResult from per-silo results with breakdown stats.
 */
export function buildFusedResult<T = Record<string, unknown>>(
  siloResults: SiloHit<T>[][],
  opts?: { k?: number; rrfK?: number },
): FusedSearchResult {
  const hits = fuseCrossSilo(siloResults, opts);

  const siloBreakdown: Record<SiloKind, number> = {
    transcripts: 0,
    atlas_files: 0,
    atlas_changelog: 0,
    source_highlights: 0,
  };

  let totalCandidates = 0;
  for (const results of siloResults) {
    for (const hit of results) {
      siloBreakdown[hit.silo] = (siloBreakdown[hit.silo] ?? 0) + 1;
      totalCandidates++;
    }
  }

  return { hits, siloBreakdown, totalCandidates };
}
