/**
 * Scope resolution for brain_search.
 *
 * Maps a brain_search scope to the set of silos that should be queried
 * and the filtering parameters for each silo. This is the "which silos
 * to hit" decision layer that sits between the tool interface and the
 * per-silo retrieval functions.
 *
 * Scopes:
 *   'self'        — Only the current identity's transcript traces
 *   'session'     — Only the current session's transcript chunks
 *   'workspace'   — Atlas for cwd repo + transcripts for cwd project (default)
 *   'identity'    — All transcript traces for a named identity + atlas for their repos
 *   'atlas'       — Atlas files + changelog + source highlights only
 *   'transcripts' — Transcript chunks only (backward compat with rebirth_search)
 *   'all'         — Everything: all silos, no scoping restrictions
 */

import type { SiloKind } from './crossSiloFusion.js';

// ── Types ──────────────────────────────────────────────────────────────

export type BrainSearchScope =
  | 'self'
  | 'session'
  | 'workspace'
  | 'identity'
  | 'atlas'
  | 'transcripts'
  | 'all';

export interface ScopeConfig {
  /** Which silos to query. */
  silos: SiloKind[];
  /** Whether to filter transcripts to the current identity's sessions. */
  filterByIdentity: boolean;
  /** Whether to filter transcripts to the current session only. */
  filterBySession: boolean;
  /** Whether to filter transcripts to the current project (cwd slug). */
  filterByProject: boolean;
  /** Whether to include atlas results. */
  includeAtlas: boolean;
}

// ── Resolution ─────────────────────────────────────────────────────────

/**
 * Resolve a brain_search scope into concrete silo and filter configuration.
 */
export function resolveScope(scope: BrainSearchScope): ScopeConfig {
  switch (scope) {
    case 'self':
      return {
        silos: ['transcripts'],
        filterByIdentity: true,
        filterBySession: false,
        filterByProject: false,
        includeAtlas: false,
      };

    case 'session':
      return {
        silos: ['transcripts'],
        filterByIdentity: false,
        filterBySession: true,
        filterByProject: false,
        includeAtlas: false,
      };

    case 'workspace':
      return {
        silos: ['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights'],
        filterByIdentity: false,
        filterBySession: false,
        filterByProject: true,
        includeAtlas: true,
      };

    case 'identity':
      return {
        silos: ['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights'],
        filterByIdentity: true,
        filterBySession: false,
        filterByProject: false,
        includeAtlas: true,
      };

    case 'atlas':
      return {
        silos: ['atlas_files', 'atlas_changelog', 'source_highlights'],
        filterByIdentity: false,
        filterBySession: false,
        filterByProject: false,
        includeAtlas: true,
      };

    case 'transcripts':
      return {
        silos: ['transcripts'],
        filterByIdentity: false,
        filterBySession: false,
        filterByProject: false,
        includeAtlas: false,
      };

    case 'all':
      return {
        silos: ['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights'],
        filterByIdentity: false,
        filterBySession: false,
        filterByProject: false,
        includeAtlas: true,
      };
  }
}

/**
 * Filter a silo list to only those requested by the caller.
 * Used when the caller explicitly specifies `silos` parameter.
 */
export function applySiloFilter(
  availableSilos: SiloKind[],
  requestedSilos: SiloKind[],
): SiloKind[] {
  const requested = new Set(requestedSilos);
  return availableSilos.filter((s) => requested.has(s));
}
