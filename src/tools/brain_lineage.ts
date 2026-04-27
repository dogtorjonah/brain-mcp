/**
 * brain_lineage — Per-file identity timeline.
 *
 * "Who has touched this file, what did each contribute, who introduced
 * each hazard?" Identity-level blame.
 *
 * Design doc: §12.6
 */

import type { HomeDb } from '../home/db.js';

type DatabaseType = HomeDb['db'];

export interface BrainLineageDeps {
  homeDb: HomeDb;
}

export function registerBrainLineageTool(server: unknown, deps: BrainLineageDeps): void {
  const srv = server as {
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
  };

  srv.tool(
    'brain_lineage',
    'Per-file identity timeline: who touched this file, who introduced each hazard, pattern history.',
    {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace name.' },
        file_path: { type: 'string', description: 'File path within the workspace.' },
        limit: { type: 'number', description: 'Max timeline events. Default 50.' },
      },
      required: ['workspace', 'file_path'],
    },
    async (argsRaw: unknown) => handleBrainLineage(deps, argsRaw),
  );
}

async function handleBrainLineage(deps: BrainLineageDeps, argsRaw: unknown): Promise<unknown> {
  const args = argsRaw as Record<string, unknown>;
  const workspace = args.workspace as string;
  const filePath = args.file_path as string;
  const limit = (args.limit as number) ?? 50;

  const db: DatabaseType = deps.homeDb.db;

  // 1. Get all edges for this file, grouped by identity
  const identityRows = db.prepare(`
    SELECT
      identity_name,
      COUNT(*) AS edge_count,
      MIN(ts) AS first_touch_at,
      MAX(ts) AS last_touch_at,
      SUM(CASE WHEN kind = 'commit' THEN 1 ELSE 0 END) AS commits_here
    FROM atlas_identity_edges
    WHERE workspace = ? AND file_path = ?
    GROUP BY identity_name
    ORDER BY edge_count DESC
  `).all(workspace, filePath) as Array<{
    identity_name: string;
    edge_count: number;
    first_touch_at: number;
    last_touch_at: number;
    commits_here: number;
  }>;

  // 2. For each identity, get their hazards surfaced/resolved on this file
  const identities = identityRows.map(row => {
    const surfaced = db.prepare(`
      SELECT detail AS hazard, ts FROM atlas_identity_edges
      WHERE workspace = ? AND file_path = ? AND identity_name = ? AND kind = 'surfaced'
      ORDER BY ts ASC
    `).all(workspace, filePath, row.identity_name) as Array<{ hazard: string; ts: number }>;

    const resolved = db.prepare(`
      SELECT detail AS hazard, ts FROM atlas_identity_edges
      WHERE workspace = ? AND file_path = ? AND identity_name = ? AND kind = 'resolved'
      ORDER BY ts ASC
    `).all(workspace, filePath, row.identity_name) as Array<{ hazard: string; ts: number }>;

    const patternsAdded = db.prepare(`
      SELECT detail AS pattern, ts FROM atlas_identity_edges
      WHERE workspace = ? AND file_path = ? AND identity_name = ? AND kind = 'pattern_added'
      ORDER BY ts ASC
    `).all(workspace, filePath, row.identity_name) as Array<{ pattern: string; ts: number }>;

    return {
      identity_name: row.identity_name,
      edge_count: row.edge_count,
      first_touch_at: row.first_touch_at,
      last_touch_at: row.last_touch_at,
      commits_here: row.commits_here,
      hazards_surfaced_here: surfaced.map(s => s.hazard),
      hazards_resolved_here: resolved.map(r => r.hazard),
      patterns_added_here: patternsAdded.map(p => p.pattern),
    };
  });

  // 3. Full timeline (chronological edge stream for this file)
  const timelineRows = db.prepare(`
    SELECT identity_name, kind, detail, ts, session_id, changelog_id
    FROM atlas_identity_edges
    WHERE workspace = ? AND file_path = ?
    ORDER BY ts ASC
    LIMIT ?
  `).all(workspace, filePath, limit) as Array<{
    identity_name: string;
    kind: string;
    detail: string | null;
    ts: number;
    session_id: string | null;
    changelog_id: number | null;
  }>;

  const timeline = timelineRows.map(row => ({
    ts: row.ts,
    identity_name: row.identity_name,
    kind: row.kind,
    detail: row.detail,
    session_id: row.session_id,
    changelog_id: row.changelog_id,
  }));

  return {
    workspace,
    file_path: filePath,
    identities,
    timeline,
    total_edges: timelineRows.length,
  };
}
