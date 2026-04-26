/**
 * Synapse Edge Emitter — writes identity↔file edges into atlas_identity_edges
 *
 * Every atlas_commit, hazard change, pattern change, and lookup can emit edges.
 * Edges are the core learning mechanism — they record WHO touched WHAT, WHEN, and WHY.
 *
 * Edge kinds:
 *   commit          — identity committed atlas metadata for a file
 *   surfaced        — identity added a hazard to a file
 *   resolved        — identity removed a hazard from a file
 *   pattern_added   — identity added a pattern to a file
 *   pattern_removed — identity removed a pattern from a file
 *   source_highlight — identity added a source highlight
 *   lookup          — identity looked up a file (lightweight usage signal)
 */

import type { Database as DatabaseType } from 'better-sqlite3';
import type { HomeDb } from '../home/db.js';
import type { IdentityStore } from '../identity/store.js';

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export type EdgeKind =
  | 'commit'
  | 'surfaced'
  | 'resolved'
  | 'pattern_added'
  | 'pattern_removed'
  | 'source_highlight'
  | 'lookup';

export interface Edge {
  id?: number;
  identityName: string;
  workspace: string;
  filePath: string;
  changelogId?: number | null;
  kind: EdgeKind;
  detail?: string | null;
  sessionId?: string | null;
  ts: number;
}

export interface EdgeQuery {
  identityName?: string;
  workspace?: string;
  filePath?: string;
  kind?: EdgeKind;
  changelogId?: number;
  since?: number;
  until?: number;
  limit?: number;
}

// ──────────────────────────────────────────
// EdgeEmitter
// ──────────────────────────────────────────

export class EdgeEmitter {
  constructor(private readonly homeDb: HomeDb) {}

  private get db(): DatabaseType {
    return this.homeDb.db;
  }

  // ──────────────────────────────────────────
  // Write operations
  // ──────────────────────────────────────────

  /** Emit a single edge. Returns the auto-generated ID. */
  emit(edge: Omit<Edge, 'id'>): number {
    const result = this.db.prepare(`
      INSERT INTO atlas_identity_edges (identity_name, workspace, file_path, changelog_id, kind, detail, session_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      edge.identityName,
      edge.workspace,
      edge.filePath,
      edge.changelogId ?? null,
      edge.kind,
      edge.detail ?? null,
      edge.sessionId ?? null,
      edge.ts,
    );
    return result.lastInsertRowid as number;
  }

  /** Emit multiple edges in a single transaction. Useful for atlas_commit which writes several at once. */
  emitBatch(edges: Array<Omit<Edge, 'id'>>): number[] {
    const insert = this.db.prepare(`
      INSERT INTO atlas_identity_edges (identity_name, workspace, file_path, changelog_id, kind, detail, session_id, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const ids: number[] = [];
    const tx = this.db.transaction(() => {
      for (const edge of edges) {
        const result = insert.run(
          edge.identityName,
          edge.workspace,
          edge.filePath,
          edge.changelogId ?? null,
          edge.kind,
          edge.detail ?? null,
          edge.sessionId ?? null,
          edge.ts,
        );
        ids.push(result.lastInsertRowid as number);
      }
    });
    tx();
    return ids;
  }

  /**
   * Emit edges for a full atlas_commit operation.
   *
   * This is the primary entry point called after every atlas_commit.
   * It emits:
   *   1. One 'commit' edge
   *   2. One 'surfaced' edge per hazard in hazardsAdded
   *   3. One 'resolved' edge per hazard in hazardsRemoved
   *   4. One 'pattern_added' edge per pattern in patternsAdded
   *   5. One 'pattern_removed' edge per pattern in patternsRemoved
   *
   * Also marks the identity's specialty signature as dirty.
   */
  emitCommitEdges(opts: {
    identityName: string;
    workspace: string;
    filePath: string;
    changelogId: number;
    sessionId?: string;
    hazardsAdded?: string[];
    hazardsRemoved?: string[];
    patternsAdded?: string[];
    patternsRemoved?: string[];
  }): number[] {
    const now = Date.now();
    const edges: Array<Omit<Edge, 'id'>> = [];

    // Core commit edge.
    edges.push({
      identityName: opts.identityName,
      workspace: opts.workspace,
      filePath: opts.filePath,
      changelogId: opts.changelogId,
      kind: 'commit',
      detail: null,
      sessionId: opts.sessionId,
      ts: now,
    });

    // Hazard edges.
    for (const hazard of (opts.hazardsAdded ?? [])) {
      edges.push({
        identityName: opts.identityName,
        workspace: opts.workspace,
        filePath: opts.filePath,
        changelogId: opts.changelogId,
        kind: 'surfaced',
        detail: hazard,
        sessionId: opts.sessionId,
        ts: now,
      });
    }
    for (const hazard of (opts.hazardsRemoved ?? [])) {
      edges.push({
        identityName: opts.identityName,
        workspace: opts.workspace,
        filePath: opts.filePath,
        changelogId: opts.changelogId,
        kind: 'resolved',
        detail: hazard,
        sessionId: opts.sessionId,
        ts: now,
      });
    }

    // Pattern edges.
    for (const pattern of (opts.patternsAdded ?? [])) {
      edges.push({
        identityName: opts.identityName,
        workspace: opts.workspace,
        filePath: opts.filePath,
        changelogId: opts.changelogId,
        kind: 'pattern_added',
        detail: pattern,
        sessionId: opts.sessionId,
        ts: now,
      });
    }
    for (const pattern of (opts.patternsRemoved ?? [])) {
      edges.push({
        identityName: opts.identityName,
        workspace: opts.workspace,
        filePath: opts.filePath,
        changelogId: opts.changelogId,
        kind: 'pattern_removed',
        detail: pattern,
        sessionId: opts.sessionId,
        ts: now,
      });
    }

    const ids = this.emitBatch(edges);

    // Mark specialty dirty.
    this.db.prepare(
      'UPDATE specialty_signatures SET dirty = 1 WHERE identity_name = ?'
    ).run(opts.identityName);

    return ids;
  }

  /** Emit a lookup edge (lightweight usage signal). */
  emitLookup(opts: {
    identityName: string;
    workspace: string;
    filePath: string;
    sessionId?: string;
  }): number {
    return this.emit({
      identityName: opts.identityName,
      workspace: opts.workspace,
      filePath: opts.filePath,
      kind: 'lookup',
      sessionId: opts.sessionId,
      ts: Date.now(),
    });
  }

  // ──────────────────────────────────────────
  // Read operations
  // ──────────────────────────────────────────

  /** Query edges with flexible filters. */
  query(query: EdgeQuery): Edge[] {
    const clauses: string[] = [];
    const params: any[] = [];

    if (query.identityName) {
      clauses.push('identity_name = ?');
      params.push(query.identityName);
    }
    if (query.workspace) {
      clauses.push('workspace = ?');
      params.push(query.workspace);
    }
    if (query.filePath) {
      clauses.push('file_path = ?');
      params.push(query.filePath);
    }
    if (query.kind) {
      clauses.push('kind = ?');
      params.push(query.kind);
    }
    if (query.changelogId !== undefined) {
      clauses.push('changelog_id = ?');
      params.push(query.changelogId);
    }
    if (query.since !== undefined) {
      clauses.push('ts >= ?');
      params.push(query.since);
    }
    if (query.until !== undefined) {
      clauses.push('ts <= ?');
      params.push(query.until);
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = query.limit ?? 100;

    const rows = this.db.prepare(
      `SELECT id, identity_name, workspace, file_path, changelog_id, kind, detail, session_id, ts FROM atlas_identity_edges ${where} ORDER BY ts DESC LIMIT ?`
    ).all(...params, limit) as any[];

    return rows.map(row => ({
      id: row.id,
      identityName: row.identity_name,
      workspace: row.workspace,
      filePath: row.file_path,
      changelogId: row.changelog_id,
      kind: row.kind as EdgeKind,
      detail: row.detail,
      sessionId: row.session_id,
      ts: row.ts,
    }));
  }

  /** Get all edges for a specific file, optionally filtered by workspace. */
  getFileEdges(workspace: string, filePath: string, limit = 100): Edge[] {
    return this.query({ workspace, filePath, limit });
  }

  /** Get all edges for an identity. */
  getIdentityEdges(identityName: string, limit = 200): Edge[] {
    return this.query({ identityName, limit });
  }

  /** Get open (unresolved) hazards for an identity. */
  getOpenHazards(identityName: string, opts: { workspace?: string; limit?: number } = {}): Array<{
    workspace: string;
    filePath: string;
    hazard: string;
    surfacedAt: number;
    changelogId: number;
  }> {
    // Find surfaced hazards that don't have a corresponding resolved edge.
    const workspaceFilter = opts.workspace ? 'AND s.workspace = ?' : '';
    const params: any[] = [identityName, ...(opts.workspace ? [opts.workspace] : [])];

    const rows = this.db.prepare(`
      SELECT s.workspace, s.file_path, s.detail AS hazard, s.ts AS surfaced_at, s.changelog_id
      FROM atlas_identity_edges s
      WHERE s.identity_name = ?
        AND s.kind = 'surfaced'
        ${workspaceFilter}
        AND NOT EXISTS (
          SELECT 1 FROM atlas_identity_edges r
          WHERE r.identity_name = s.identity_name
            AND r.workspace = s.workspace
            AND r.file_path = s.file_path
            AND r.kind = 'resolved'
            AND r.detail = s.detail
            AND r.ts > s.ts
        )
      ORDER BY s.ts ASC
      LIMIT ?
    `).all(...params, opts.limit ?? 50) as any[];

    return rows.map(row => ({
      workspace: row.workspace,
      filePath: row.file_path,
      hazard: row.hazard,
      surfacedAt: row.surfaced_at,
      changelogId: row.changelog_id,
    }));
  }

  /** Count edges by kind for an identity. */
  countByKind(identityName: string): Record<EdgeKind, number> {
    const rows = this.db.prepare(`
      SELECT kind, COUNT(*) AS cnt
      FROM atlas_identity_edges
      WHERE identity_name = ?
      GROUP BY kind
    `).all(identityName) as any[];

    const result: Record<string, number> = {
      commit: 0, surfaced: 0, resolved: 0,
      pattern_added: 0, pattern_removed: 0,
      source_highlight: 0, lookup: 0,
    };
    for (const row of rows) {
      result[row.kind] = row.cnt;
    }
    return result as Record<EdgeKind, number>;
  }

  /** Get files most touched by an identity (by edge count, recency-weighted). */
  getTopFiles(identityName: string, limit = 20): Array<{
    workspace: string;
    filePath: string;
    edgeCount: number;
    lastTouchAt: number;
  }> {
    const rows = this.db.prepare(`
      SELECT workspace, file_path, COUNT(*) AS edge_count, MAX(ts) AS last_touch_at
      FROM atlas_identity_edges
      WHERE identity_name = ? AND kind != 'lookup'
      GROUP BY workspace, file_path
      ORDER BY edge_count DESC, last_touch_at DESC
      LIMIT ?
    `).all(identityName, limit) as any[];

    return rows.map(row => ({
      workspace: row.workspace,
      filePath: row.file_path,
      edgeCount: row.edge_count,
      lastTouchAt: row.last_touch_at,
    }));
  }
}
