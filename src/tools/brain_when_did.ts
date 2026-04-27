/**
 * brain_when_did — Time-traveling debug.
 *
 * "When did hazard H first appear on file F? When did pattern P first land?"
 * Returns first appearance, full history, and surrounding context.
 *
 * Design doc: §12.5
 */

import type { HomeDb } from '../home/db.js';

type DatabaseType = HomeDb['db'];

export interface BrainWhenDidDeps {
  homeDb: HomeDb;
}

export function registerBrainWhenDidTool(server: unknown, deps: BrainWhenDidDeps): void {
  const srv = server as {
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
  };

  srv.tool(
    'brain_when_did',
    'Time-traveling debug: when did a hazard first appear? When was a pattern introduced? Full history of a specific detail.',
    {
      type: 'object',
      properties: {
        what: {
          type: 'string',
          enum: ['hazard', 'pattern', 'commit'],
          description: 'What kind of thing to look for.',
        },
        detail: {
          type: 'string',
          description: 'The hazard string, pattern string, or commit summary substring to search for.',
        },
        workspace: { type: 'string', description: 'Optional workspace filter.' },
        file_path: { type: 'string', description: 'Optional file path filter.' },
      },
      required: ['what', 'detail'],
    },
    async (argsRaw: unknown) => handleBrainWhenDid(deps, argsRaw),
  );
}

async function handleBrainWhenDid(deps: BrainWhenDidDeps, argsRaw: unknown): Promise<unknown> {
  const args = argsRaw as Record<string, unknown>;
  const what = args.what as 'hazard' | 'pattern' | 'commit';
  const detail = args.detail as string;
  const workspace = args.workspace as string | undefined;
  const filePath = args.file_path as string | undefined;

  const db: DatabaseType = deps.homeDb.db;

  // Map 'what' to edge kinds
  let kinds: string[];
  if (what === 'hazard') {
    kinds = ['surfaced', 'resolved'];
  } else if (what === 'pattern') {
    kinds = ['pattern_added', 'pattern_removed'];
  } else {
    kinds = ['commit'];
  }

  // Build query
  const clauses: string[] = [`kind IN (${kinds.map(() => '?').join(', ')})`];
  const params: unknown[] = [...kinds];

  if (what === 'commit') {
    // For commits, search the detail field (or match broadly if no detail)
    clauses.push('(detail LIKE ? OR detail IS NULL)');
    params.push(`%${detail}%`);
  } else {
    clauses.push('detail = ?');
    params.push(detail);
  }

  if (workspace) {
    clauses.push('workspace = ?');
    params.push(workspace);
  }
  if (filePath) {
    clauses.push('file_path = ?');
    params.push(filePath);
  }

  const rows = db.prepare(`
    SELECT identity_name, workspace, file_path, kind, detail, ts, session_id, changelog_id
    FROM atlas_identity_edges
    WHERE ${clauses.join(' AND ')}
    ORDER BY ts ASC
    LIMIT 100
  `).all(...params) as Array<{
    identity_name: string;
    workspace: string;
    file_path: string;
    kind: string;
    detail: string | null;
    ts: number;
    session_id: string | null;
    changelog_id: number | null;
  }>;

  // First appearance
  const firstAppearance = rows.length > 0
    ? {
        ts: rows[0].ts,
        identity_name: rows[0].identity_name,
        workspace: rows[0].workspace,
        file_path: rows[0].file_path,
        kind: rows[0].kind,
        changelog_id: rows[0].changelog_id,
        session_id: rows[0].session_id,
      }
    : null;

  // Full history
  const history = rows.map(row => ({
    ts: row.ts,
    kind: row.kind,
    identity_name: row.identity_name,
    workspace: row.workspace,
    file_path: row.file_path,
    changelog_id: row.changelog_id,
    summary: row.detail ?? '(no detail)',
  }));

  // Try to find a surrounding transcript chunk for the first appearance
  let surroundingChunkId: number | null = null;
  if (firstAppearance && firstAppearance.session_id) {
    const chunk = db.prepare(`
      SELECT id FROM transcript_chunks
      WHERE session_id = ? AND ts <= ?
      ORDER BY ts DESC
      LIMIT 1
    `).get(firstAppearance.session_id, firstAppearance.ts) as { id: number } | undefined;
    surroundingChunkId = chunk?.id ?? null;
  }

  return {
    what,
    detail,
    first_appearance: firstAppearance
      ? { ...firstAppearance, surrounding_transcript_chunk_id: surroundingChunkId }
      : null,
    history,
    total_events: rows.length,
  };
}
