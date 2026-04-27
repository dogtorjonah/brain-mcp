/**
 * brain_recommend — "Which identity is best for this task / file / hazard?"
 *
 * Ranks identities by relevance to a query using three signals:
 *   1. Path experience — identities that have touched matching file paths
 *   2. Hazard overlap  — identities that surfaced/resolved similar hazards
 *   3. Pattern overlap — identities with matching patterns
 *
 * Signals are min-max normalized and fused with configurable weights.
 * Identity vectors (cosine similarity) are a future signal — the hook is
 * present but the implementation falls back to pattern-based matching until
 * vec0 identity vectors are available.
 */

import type { ToolRegistry } from '../daemon/toolRegistry.js';
import type { BrainDaemonRuntime } from '../daemon/runtime.js';
import { safeJsonStringify } from '../daemon/protocol.js';

// ── Types ──────────────────────────────────────────────────────────────

interface RecommendArgs {
  /** What to match against: file path, hazard text, pattern, or free-text. */
  query: string;
  /** Optional workspace to scope the search. */
  workspace?: string;
  /** Max identities to return. Default 5. */
  limit?: number;
  /** Signal weights. Default { path: 0.4, hazard: 0.35, pattern: 0.25 }. */
  weights?: { path?: number; hazard?: number; pattern?: number };
}

interface ScoredIdentity {
  name: string;
  blurb: string;
  totalScore: number;
  pathScore: number;
  hazardScore: number;
  patternScore: number;
  topFiles: string[];
  matchingHazards: string[];
  matchingPatterns: string[];
}

// ── Tool registration ──────────────────────────────────────────────────

export function registerBrainRecommendTool(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  registry.register(
    {
      name: 'brain_recommend',
      description:
        'Recommend identities best suited for a given task, file, or hazard. ' +
        'Ranks by path experience, hazard overlap, and pattern similarity.',
    },
    async (args: Record<string, unknown>) => {
      const query = args.query as string | undefined;
      if (!query || typeof query !== 'string' || query.trim().length === 0) {
        return {
          content: [{ type: 'text', text: 'Parameter "query" is required.' }],
          isError: true,
        };
      }

      const opts: RecommendArgs = {
        query: query.trim(),
        workspace: typeof args.workspace === 'string' ? args.workspace : undefined,
        limit: typeof args.limit === 'number' ? args.limit : 5,
        weights: {
          path: (args.weights as any)?.path ?? 0.4,
          hazard: (args.weights as any)?.hazard ?? 0.35,
          pattern: (args.weights as any)?.pattern ?? 0.25,
        },
      };

      const result = recommendIdentities(runtime, opts);

      if (result.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `No identities found matching "${opts.query}".`,
            },
          ],
        };
      }

      const lines: string[] = [
        `# Identity Recommendations for "${opts.query}"`,
        '',
        `Found ${result.length} relevant identit${result.length === 1 ? 'y' : 'ies'}:`,
        '',
      ];

      for (const id of result) {
        lines.push(`## ${id.name} (score: ${id.totalScore.toFixed(3)})`);
        if (id.blurb) lines.push(`  ${id.blurb}`);
        lines.push(`  Path experience: ${id.pathScore.toFixed(3)}`);
        lines.push(`  Hazard overlap: ${id.hazardScore.toFixed(3)}`);
        lines.push(`  Pattern overlap: ${id.patternScore.toFixed(3)}`);
        if (id.topFiles.length > 0) {
          lines.push(`  Top files: ${id.topFiles.slice(0, 5).join(', ')}`);
        }
        if (id.matchingHazards.length > 0) {
          lines.push(`  Matching hazards: ${id.matchingHazards.slice(0, 5).join('; ')}`);
        }
        if (id.matchingPatterns.length > 0) {
          lines.push(`  Matching patterns: ${id.matchingPatterns.slice(0, 5).join('; ')}`);
        }
        lines.push('');
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );
}

// ── Recommendation engine ──────────────────────────────────────────────

function recommendIdentities(runtime: BrainDaemonRuntime, opts: RecommendArgs): ScoredIdentity[] {
  const { query, workspace, limit, weights } = opts;
  const db = runtime.homeDb.db;

  // Get all active identities.
  const identities = db.prepare(
    "SELECT name, blurb FROM identity_profiles WHERE retired_at IS NULL",
  ).all() as Array<{ name: string; blurb: string }>;

  if (identities.length === 0) return [];

  // Compute per-identity scores.
  const scored: ScoredIdentity[] = [];

  for (const identity of identities) {
    const pathResult = scorePathExperience(db, identity.name, query, workspace);
    const hazardResult = scoreHazardOverlap(db, identity.name, query, workspace);
    const patternResult = scorePatternOverlap(db, identity.name, query, workspace);

    scored.push({
      name: identity.name,
      blurb: identity.blurb,
      totalScore: 0, // filled after normalization
      pathScore: pathResult.score,
      hazardScore: hazardResult.score,
      patternScore: patternResult.score,
      topFiles: pathResult.topFiles,
      matchingHazards: hazardResult.matches,
      matchingPatterns: patternResult.matches,
    });
  }

  // Min-max normalize each signal to [0, 1].
  normalizeField(scored, 'pathScore');
  normalizeField(scored, 'hazardScore');
  normalizeField(scored, 'patternScore');

  // Weighted fusion.
  const wp = weights?.path ?? 0.4;
  const wh = weights?.hazard ?? 0.35;
  const wpat = weights?.pattern ?? 0.25;
  for (const id of scored) {
    id.totalScore = wp * id.pathScore + wh * id.hazardScore + wpat * id.patternScore;
  }

  // Sort by total score descending, take top-K.
  scored.sort((a, b) => b.totalScore - a.totalScore);
  return scored.filter((s) => s.totalScore > 0).slice(0, limit);
}

// ── Signal scorers ─────────────────────────────────────────────────────

function scorePathExperience(
  db: any,
  identityName: string,
  query: string,
  workspace?: string,
): { score: number; topFiles: string[] } {
  // Count edges where file_path matches query fragments.
  const queryLower = query.toLowerCase();
  const workspaceFilter = workspace ? 'AND workspace = ?' : '';
  const params: any[] = [identityName, workspaceFilter ? workspace : undefined].filter(
    (p) => p !== undefined,
  );

  // Direct path match: file_path LIKE '%query%'
  const pathLike = `%${queryLower}%`;
  const directParams = workspace
    ? [identityName, pathLike, workspace]
    : [identityName, pathLike];

  const directRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind != 'lookup'
      AND LOWER(file_path) LIKE ?
      ${workspace ? 'AND workspace = ?' : ''}
  `).get(...directParams) as { cnt: number };

  // Component match: basename or directory components match.
  // Split query into tokens and match against path components.
  const tokens = queryLower.split(/[/\\_\-.]+/).filter(Boolean);
  let componentHits = 0;
  if (tokens.length > 0) {
    const likeClauses = tokens.map(() => 'LOWER(file_path) LIKE ?').join(' OR ');
    const likeParams = tokens.map((t) => `%${t}%`);
    const compParams = workspace
      ? [identityName, ...likeParams, workspace]
      : [identityName, ...likeParams];

    const compRow = db.prepare(`
      SELECT COUNT(DISTINCT file_path) AS cnt
      FROM atlas_identity_edges
      WHERE identity_name = ?
        AND kind != 'lookup'
        AND (${likeClauses})
        ${workspace ? 'AND workspace = ?' : ''}
    `).get(...compParams) as { cnt: number };
    componentHits = compRow.cnt;
  }

  // Get top files for this identity matching the query.
  const topFilesParams = workspace
    ? [identityName, pathLike, workspace, 5]
    : [identityName, pathLike, 5];
  const topFilesRows = db.prepare(`
    SELECT DISTINCT file_path
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind != 'lookup'
      AND LOWER(file_path) LIKE ?
      ${workspace ? 'AND workspace = ?' : ''}
    ORDER BY ts DESC
    LIMIT ?
  `).all(...topFilesParams) as Array<{ file_path: string }>;

  const score = directRow.cnt * 2 + componentHits;
  return {
    score,
    topFiles: topFilesRows.map((r) => r.file_path),
  };
}

function scoreHazardOverlap(
  db: any,
  identityName: string,
  query: string,
  workspace?: string,
): { score: number; matches: string[] } {
  const queryLower = query.toLowerCase();
  const likeQuery = `%${queryLower}%`;
  const params = workspace
    ? [identityName, likeQuery, workspace, 10]
    : [identityName, likeQuery, 10];

  // Count hazard edges where detail matches query.
  const hazardRow = db.prepare(`
    SELECT COUNT(*) AS cnt, GROUP_CONCAT(DISTINCT detail) AS details
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind IN ('surfaced', 'resolved')
      AND LOWER(detail) LIKE ?
      ${workspace ? 'AND workspace = ?' : ''}
    LIMIT ?
  `).get(...params) as { cnt: number; details: string | null };

  const matches = hazardRow.details
    ? hazardRow.details.split(',').slice(0, 10)
    : [];

  // Bonus for resolved hazards (shows completion, not just discovery).
  const resolvedParams = workspace
    ? [identityName, likeQuery, workspace]
    : [identityName, likeQuery];
  const resolvedRow = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind = 'resolved'
      AND LOWER(detail) LIKE ?
      ${workspace ? 'AND workspace = ?' : ''}
  `).get(...resolvedParams) as { cnt: number };

  return {
    score: hazardRow.cnt + resolvedRow.cnt * 2,
    matches,
  };
}

function scorePatternOverlap(
  db: any,
  identityName: string,
  query: string,
  workspace?: string,
): { score: number; matches: string[] } {
  const queryLower = query.toLowerCase();
  const likeQuery = `%${queryLower}%`;
  const params = workspace
    ? [identityName, likeQuery, workspace, 10]
    : [identityName, likeQuery, 10];

  const patternRow = db.prepare(`
    SELECT COUNT(*) AS cnt, GROUP_CONCAT(DISTINCT detail) AS details
    FROM atlas_identity_edges
    WHERE identity_name = ?
      AND kind IN ('pattern_added', 'pattern_removed')
      AND LOWER(detail) LIKE ?
      ${workspace ? 'AND workspace = ?' : ''}
    LIMIT ?
  `).get(...params) as { cnt: number; details: string | null };

  const matches = patternRow.details
    ? patternRow.details.split(',').slice(0, 10)
    : [];

  // Also check specialty signature patterns.
  const specRow = db.prepare(
    'SELECT top_patterns_json FROM specialty_signatures WHERE identity_name = ?',
  ).get(identityName) as { top_patterns_json: string } | undefined;

  let specScore = 0;
  if (specRow) {
    try {
      const patterns = JSON.parse(specRow.top_patterns_json) as Array<{ pattern: string; count: number }>;
      for (const p of patterns) {
        if (p.pattern.toLowerCase().includes(queryLower)) {
          specScore += p.count;
        }
      }
    } catch {
      // ignore
    }
  }

  return {
    score: patternRow.cnt + specScore,
    matches,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function normalizeField(arr: ScoredIdentity[], field: 'pathScore' | 'hazardScore' | 'patternScore'): void {
  const values = arr.map((a) => a[field]);
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min;
  if (range === 0) {
    // All same value — set to 0 (no discrimination).
    for (const item of arr) item[field] = 0;
    return;
  }
  for (const item of arr) {
    item[field] = (item[field] - min) / range;
  }
}
