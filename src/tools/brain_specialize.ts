/**
 * brain_specialize — Compute/update specialty signature for an identity.
 *
 * Aggregates over atlas_identity_edges to produce:
 *   - Top clusters (by file association)
 *   - Top patterns (by frequency)
 *   - Top files (by edge count, recency-weighted)
 *   - Hazard balance (surfaced vs resolved, mean resolve time)
 *
 * Uses the dirty-bit mechanism — only recomputes if dirty or forced.
 *
 * Design doc: §4.4, §7.2
 */

import type { HomeDb } from '../home/db.js';
import type { IdentityStore } from '../identity/store.js';
import type { EdgeEmitter } from '../edges/emitter.js';

type DatabaseType = HomeDb['db'];

export interface BrainSpecializeDeps {
  homeDb: HomeDb;
  identityStore: IdentityStore;
  edgeEmitter: EdgeEmitter;
  getCurrentIdentity: () => string | undefined;
}

export function registerBrainSpecializeTool(server: unknown, deps: BrainSpecializeDeps): void {
  const srv = server as {
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
  };

  srv.tool(
    'brain_specialize',
    'Compute or view the specialty signature for an identity. What is this identity good at? Top clusters, patterns, hazard balance.',
    {
      type: 'object',
      properties: {
        identity: { type: 'string', description: 'Identity name. Default = current identity.' },
        force_recompute: { type: 'boolean', description: 'Force recomputation even if not dirty. Default false.' },
      },
    },
    async (argsRaw: unknown) => handleBrainSpecialize(deps, argsRaw),
  );
}

async function handleBrainSpecialize(deps: BrainSpecializeDeps, argsRaw: unknown): Promise<unknown> {
  const args = argsRaw as Record<string, unknown>;
  const identityName = (args.identity as string) || deps.getCurrentIdentity() || 'unknown';
  const forceRecompute = (args.force_recompute as boolean) ?? false;

  const db: DatabaseType = deps.homeDb.db;

  // Check if recomputation is needed
  const existingSig = deps.identityStore.getSpecialtySignature(identityName);
  const needsCompute = forceRecompute || !existingSig || existingSig.dirty === 1;

  if (!needsCompute && existingSig) {
    // Return cached signature
    return {
      identity: identityName,
      status: 'cached',
      specialty: {
        top_clusters: JSON.parse(existingSig.topClustersJson),
        top_patterns: JSON.parse(existingSig.topPatternsJson),
        top_files: JSON.parse(existingSig.topFilesJson),
        hazards_surfaced: existingSig.hazardsSurfaced,
        hazards_resolved: existingSig.hazardsResolved,
        hazard_balance: existingSig.hazardsSurfaced - existingSig.hazardsResolved,
        mean_resolve_ms: existingSig.meanResolveMs,
        computed_at: existingSig.computedAt,
        age_minutes: Math.round((Date.now() - existingSig.computedAt) / 60_000),
      },
    };
  }

  // ── Recompute ──────────────────────────────

  // 1. Edge counts by kind
  const kindCounts = deps.edgeEmitter.countByKind(identityName);

  // 2. Top files (recency-weighted)
  const topFilesRaw = deps.edgeEmitter.getTopFiles(identityName, 50);

  // Derive "clusters" from workspace+directory grouping
  const clusterMap = new Map<string, { workspace: string; dir: string; count: number }>();
  for (const f of topFilesRaw) {
    const dir = f.filePath.includes('/') ? f.filePath.substring(0, f.filePath.lastIndexOf('/')) : '.';
    const key = `${f.workspace}/${dir}`;
    const existing = clusterMap.get(key);
    if (existing) {
      existing.count += f.edgeCount;
    } else {
      clusterMap.set(key, { workspace: f.workspace, dir, count: f.edgeCount });
    }
  }
  const topClusters = [...clusterMap.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 15)
    .map(c => ({ cluster: `${c.workspace}/${c.dir}`, count: c.count }));

  // 3. Top patterns — aggregate pattern_added edges
  const patternRows = db.prepare(`
    SELECT detail, COUNT(*) AS cnt
    FROM atlas_identity_edges
    WHERE identity_name = ? AND kind IN ('pattern_added', 'pattern_removed')
    GROUP BY detail
    ORDER BY cnt DESC
    LIMIT 20
  `).all(identityName) as Array<{ detail: string; cnt: number }>;

  const topPatterns = patternRows
    .filter(r => r.detail)
    .map(r => ({ pattern: r.detail, count: r.cnt }));

  // 4. Top files (formatted for signature)
  const topFiles = topFilesRaw.slice(0, 20).map(f => ({
    file: `${f.workspace}/${f.filePath}`,
    count: f.edgeCount,
    last_touch_at: f.lastTouchAt,
  }));

  // 5. Hazard resolve timing
  const resolveTimingRows = db.prepare(`
    SELECT
      s.ts AS surfaced_ts,
      MIN(r.ts) AS resolved_ts
    FROM atlas_identity_edges s
    JOIN atlas_identity_edges r ON
      r.identity_name = s.identity_name
      AND r.workspace = s.workspace
      AND r.file_path = s.file_path
      AND r.kind = 'resolved'
      AND r.detail = s.detail
      AND r.ts > s.ts
    WHERE s.identity_name = ? AND s.kind = 'surfaced'
    GROUP BY s.id
    ORDER BY surfaced_ts DESC
    LIMIT 100
  `).all(identityName) as Array<{ surfaced_ts: number; resolved_ts: number }>;

  const resolveTimes = resolveTimingRows.map(r => r.resolved_ts - r.surfaced_ts);
  const meanResolveMs = resolveTimes.length > 0
    ? Math.round(resolveTimes.reduce((a, b) => a + b, 0) / resolveTimes.length)
    : null;

  // 6. Build and persist the signature
  const signature = {
    identityName,
    topClustersJson: JSON.stringify(topClusters),
    topPatternsJson: JSON.stringify(topPatterns),
    topFilesJson: JSON.stringify(topFiles),
    hazardsSurfaced: kindCounts.surfaced,
    hazardsResolved: kindCounts.resolved,
    meanResolveMs,
    computedAt: Date.now(),
    dirty: 0,
  };

  deps.identityStore.updateSpecialtySignature(signature);

  return {
    identity: identityName,
    status: 'computed',
    specialty: {
      top_clusters: topClusters,
      top_patterns: topPatterns,
      top_files: topFiles,
      hazards_surfaced: signature.hazardsSurfaced,
      hazards_resolved: signature.hazardsResolved,
      hazard_balance: signature.hazardsSurfaced - signature.hazardsResolved,
      mean_resolve_ms: meanResolveMs,
      total_commits: kindCounts.commit,
      total_lookups: kindCounts.lookup,
      computed_at: signature.computedAt,
    },
  };
}
