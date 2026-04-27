/**
 * Identity Store — profiles, chain, SOPs, handoff notes
 *
 * Lifted from rebirth-mcp's identity system and consolidated into the home DB.
 * All writes go to ~/.brain/brain.sqlite (not filesystem).
 *
 * Key changes from rebirth-mcp:
 * - meta.json → identity_profiles table
 * - chain.jsonl → identity_chain table
 * - Added forked_from, retired_at, specialty_tags columns
 * - SOPs gain promoted_from_candidate linkage
 */

import type { HomeDb } from '../home/db.js';

type DatabaseType = HomeDb['db'];

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface IdentityProfile {
  name: string;
  blurb: string;
  specialtyTags: string;
  createdAt: number;
  updatedAt: number;
  forkedFrom: string | null;
  retiredAt: number | null;
}

export interface ChainEvent {
  id: number;
  identityName: string;
  eventKind: string;
  sessionId: string | null;
  cwd: string | null;
  wrapperPid: number | null;
  ts: number;
  metaJson: string | null;
}

export interface IdentitySop {
  id: number;
  identityName: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  promotedFromCandidate: number | null;
  retiredAt: number | null;
}

export interface HandoffNote {
  identityName: string;
  note: string;
  updatedAt: number;
  updatedBySession: string | null;
}

export interface SpecialtySignature {
  identityName: string;
  topClustersJson: string;
  topPatternsJson: string;
  topFilesJson: string;
  hazardsSurfaced: number;
  hazardsResolved: number;
  meanResolveMs: number | null;
  computedAt: number;
  dirty: number;
}

// ──────────────────────────────────────────
// IdentityStore
// ──────────────────────────────────────────

export class IdentityStore {
  constructor(private readonly homeDb: HomeDb) {}

  private get db(): DatabaseType {
    return this.homeDb.db;
  }

  // ──────────────────────────────────────────
  // Profiles
  // ──────────────────────────────────────────

  /** Create a new identity profile. Returns the profile. */
  create(name: string, opts: { blurb?: string; specialtyTags?: string; forkedFrom?: string } = {}): IdentityProfile {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO identity_profiles (name, blurb, specialty_tags, created_at, updated_at, forked_from, retired_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL)
    `).run(name, opts.blurb ?? '', opts.specialtyTags ?? '', now, now, opts.forkedFrom ?? null);

    // Ensure specialty signature row exists.
    this.db.prepare(`
      INSERT OR IGNORE INTO specialty_signatures (identity_name, computed_at, dirty)
      VALUES (?, ?, 1)
    `).run(name, now);

    return this.getProfile(name)!;
  }

  /** Get a profile by name, or null if not found. */
  getProfile(name: string): IdentityProfile | null {
    const row = this.db.prepare(
      'SELECT name, blurb, specialty_tags, created_at, updated_at, forked_from, retired_at FROM identity_profiles WHERE name = ?'
    ).get(name) as any;
    if (!row) return null;
    return {
      name: row.name,
      blurb: row.blurb,
      specialtyTags: row.specialty_tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      forkedFrom: row.forked_from,
      retiredAt: row.retired_at,
    };
  }

  /** List all active (non-retired) identity profiles. */
  listActive(): IdentityProfile[] {
    const rows = this.db.prepare(
      "SELECT name, blurb, specialty_tags, created_at, updated_at, forked_from, retired_at FROM identity_profiles WHERE retired_at IS NULL ORDER BY updated_at DESC"
    ).all() as any[];
    return rows.map(row => ({
      name: row.name,
      blurb: row.blurb,
      specialtyTags: row.specialty_tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      forkedFrom: row.forked_from,
      retiredAt: row.retired_at,
    }));
  }

  /** Update blurb for an identity. */
  setBlurb(name: string, blurb: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE identity_profiles SET blurb = ?, updated_at = ? WHERE name = ?
    `).run(blurb, now, name);
    // Blurb change dirties specialty signature.
    this.db.prepare('UPDATE specialty_signatures SET dirty = 1 WHERE identity_name = ?').run(name);
  }

  /** Update specialty tags for an identity. */
  setSpecialtyTags(name: string, tags: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE identity_profiles SET specialty_tags = ?, updated_at = ? WHERE name = ?
    `).run(tags, now, name);
  }

  /** Soft-delete (retire) an identity. */
  retire(name: string): void {
    this.db.prepare(`
      UPDATE identity_profiles SET retired_at = ? WHERE name = ?
    `).run(Date.now(), name);
  }

  /** Check if an identity exists (active or retired). */
  exists(name: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM identity_profiles WHERE name = ?').get(name);
    return row !== undefined;
  }

  // ──────────────────────────────────────────
  // Chain
  // ──────────────────────────────────────────

  /** Append a chain event for an identity. Returns the auto-generated ID. */
  appendChainEvent(event: {
    identityName: string;
    eventKind: string;
    sessionId?: string;
    cwd?: string;
    wrapperPid?: number;
    metaJson?: string;
  }): number {
    const result = this.db.prepare(`
      INSERT INTO identity_chain (identity_name, event_kind, session_id, cwd, wrapper_pid, ts, meta_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.identityName,
      event.eventKind,
      event.sessionId ?? null,
      event.cwd ?? null,
      event.wrapperPid ?? null,
      Date.now(),
      event.metaJson ?? null,
    );
    return result.lastInsertRowid as number;
  }

  /** Get the chain for an identity, ordered by timestamp. */
  getChain(name: string, limit = 100): ChainEvent[] {
    const rows = this.db.prepare(
      'SELECT id, identity_name, event_kind, session_id, cwd, wrapper_pid, ts, meta_json FROM identity_chain WHERE identity_name = ? ORDER BY ts DESC LIMIT ?'
    ).all(name, limit) as any[];
    return rows.map(row => ({
      id: row.id,
      identityName: row.identity_name,
      eventKind: row.event_kind,
      sessionId: row.session_id,
      cwd: row.cwd,
      wrapperPid: row.wrapper_pid,
      ts: row.ts,
      metaJson: row.meta_json,
    }));
  }

  /** Get the last N chain events for an identity across all sessions. */
  getRecentChain(name: string, limit = 20): ChainEvent[] {
    return this.getChain(name, limit);
  }

  // ──────────────────────────────────────────
  // SOPs
  // ──────────────────────────────────────────

  /** Add an SOP for an identity. */
  addSop(identityName: string, title: string, body: string): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO identity_sops (identity_name, title, body, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(identityName, title, body, now, now);
    // SOP change dirties specialty signature.
    this.db.prepare('UPDATE specialty_signatures SET dirty = 1 WHERE identity_name = ?').run(identityName);
    return result.lastInsertRowid as number;
  }

  /** List all active SOPs for an identity. */
  listSops(identityName: string): IdentitySop[] {
    const rows = this.db.prepare(
      'SELECT id, identity_name, title, body, created_at, updated_at, promoted_from_candidate, retired_at FROM identity_sops WHERE identity_name = ? AND retired_at IS NULL ORDER BY updated_at DESC'
    ).all(identityName) as any[];
    return rows.map(row => ({
      id: row.id,
      identityName: row.identity_name,
      title: row.title,
      body: row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      promotedFromCandidate: row.promoted_from_candidate,
      retiredAt: row.retired_at,
    }));
  }

  /** Update an existing SOP. */
  updateSop(id: number, updates: { title?: string; body?: string }): void {
    const now = Date.now();
    const sets: string[] = ['updated_at = ?'];
    const vals: any[] = [now];
    if (updates.title !== undefined) { sets.push('title = ?'); vals.push(updates.title); }
    if (updates.body !== undefined) { sets.push('body = ?'); vals.push(updates.body); }
    vals.push(id);
    this.db.prepare(`UPDATE identity_sops SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  /** Remove (retire) an SOP. */
  removeSop(id: number): void {
    this.db.prepare('UPDATE identity_sops SET retired_at = ? WHERE id = ?').run(Date.now(), id);
  }

  /** Promote an SOP candidate into a real SOP. Links back via promoted_from_candidate. */
  promoteSopCandidate(identityName: string, candidateId: number, title: string, body: string): number {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO identity_sops (identity_name, title, body, created_at, updated_at, promoted_from_candidate)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(identityName, title, body, now, now, candidateId);
    // Mark candidate as promoted.
    this.db.prepare('UPDATE sop_candidates SET promoted_sop_id = ? WHERE id = ?').run(result.lastInsertRowid, candidateId);
    return result.lastInsertRowid as number;
  }

  // ──────────────────────────────────────────
  // Handoff notes
  // ──────────────────────────────────────────

  /** Set (last-write-wins) the handoff note for an identity. */
  setHandoffNote(identityName: string, note: string, sessionId?: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO identity_handoff_notes (identity_name, note, updated_at, updated_by_session)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(identity_name) DO UPDATE SET note = ?, updated_at = ?, updated_by_session = ?
    `).run(identityName, note, now, sessionId ?? null, note, now, sessionId ?? null);
  }

  /** Get the handoff note for an identity. */
  getHandoffNote(identityName: string): HandoffNote | null {
    const row = this.db.prepare(
      'SELECT identity_name, note, updated_at, updated_by_session FROM identity_handoff_notes WHERE identity_name = ?'
    ).get(identityName) as any;
    if (!row) return null;
    return {
      identityName: row.identity_name,
      note: row.note,
      updatedAt: row.updated_at,
      updatedBySession: row.updated_by_session,
    };
  }

  // ──────────────────────────────────────────
  // Session binding
  // ──────────────────────────────────────────

  /** Bind a session to an identity. */
  bindSession(sessionId: string, identityName: string, source: string): void {
    this.db.prepare(`
      INSERT INTO session_identity (session_id, identity_name, bound_at, source)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET identity_name = ?, bound_at = ?, source = ?
    `).run(sessionId, identityName, Date.now(), source, identityName, Date.now(), source);
  }

  /** Get the identity bound to a session. */
  getSessionBinding(sessionId: string): { identityName: string; boundAt: number; source: string } | null {
    const row = this.db.prepare(
      'SELECT identity_name, bound_at, source FROM session_identity WHERE session_id = ?'
    ).get(sessionId) as any;
    if (!row) return null;
    return { identityName: row.identity_name, boundAt: row.bound_at, source: row.source };
  }

  // ──────────────────────────────────────────
  // Specialty signatures
  // ──────────────────────────────────────────

  /** Get the specialty signature for an identity. Returns null if not computed yet. */
  getSpecialtySignature(identityName: string): SpecialtySignature | null {
    const row = this.db.prepare(
      'SELECT identity_name, top_clusters_json, top_patterns_json, top_files_json, hazards_surfaced, hazards_resolved, mean_resolve_ms, computed_at, dirty FROM specialty_signatures WHERE identity_name = ?'
    ).get(identityName) as any;
    if (!row) return null;
    return {
      identityName: row.identity_name,
      topClustersJson: row.top_clusters_json,
      topPatternsJson: row.top_patterns_json,
      topFilesJson: row.top_files_json,
      hazardsSurfaced: row.hazards_surfaced,
      hazardsResolved: row.hazards_resolved,
      meanResolveMs: row.mean_resolve_ms,
      computedAt: row.computed_at,
      dirty: row.dirty,
    };
  }

  /** Mark an identity's specialty signature as dirty (needs recomputation). */
  markSpecialtyDirty(identityName: string): void {
    this.db.prepare(`
      INSERT INTO specialty_signatures (identity_name, computed_at, dirty)
      VALUES (?, ?, 1)
      ON CONFLICT(identity_name) DO UPDATE SET dirty = 1
    `).run(identityName, Date.now());
  }

  /** Update the specialty signature for an identity. */
  updateSpecialtySignature(sig: Omit<SpecialtySignature, 'dirty'> & { dirty?: number }): void {
    this.db.prepare(`
      INSERT INTO specialty_signatures (identity_name, top_clusters_json, top_patterns_json, top_files_json, hazards_surfaced, hazards_resolved, mean_resolve_ms, computed_at, dirty)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(identity_name) DO UPDATE SET
        top_clusters_json = ?, top_patterns_json = ?, top_files_json = ?,
        hazards_surfaced = ?, hazards_resolved = ?, mean_resolve_ms = ?,
        computed_at = ?, dirty = ?
    `).run(
      sig.identityName, sig.topClustersJson, sig.topPatternsJson, sig.topFilesJson,
      sig.hazardsSurfaced, sig.hazardsResolved, sig.meanResolveMs, sig.computedAt, sig.dirty ?? 0,
      sig.topClustersJson, sig.topPatternsJson, sig.topFilesJson,
      sig.hazardsSurfaced, sig.hazardsResolved, sig.meanResolveMs, sig.computedAt, sig.dirty ?? 0,
    );
  }

  // ──────────────────────────────────────────
  // Fork
  // ──────────────────────────────────────────

  /** Fork an identity: create a new profile inheriting from an existing one. */
  fork(sourceName: string, newName: string, opts: { blurb?: string; inheritSops?: boolean; inheritSpecialty?: boolean } = {}): IdentityProfile {
    const source = this.getProfile(sourceName);
    if (!source) throw new Error(`Source identity "${sourceName}" not found`);

    const profile = this.create(newName, {
      blurb: opts.blurb ?? source.blurb,
      specialtyTags: source.specialtyTags,
      forkedFrom: sourceName,
    });

    // Record fork event in source chain.
    this.appendChainEvent({
      identityName: sourceName,
      eventKind: 'fork',
      metaJson: JSON.stringify({ forked_to: newName }),
    });

    // Record mint event in new chain.
    this.appendChainEvent({
      identityName: newName,
      eventKind: 'mint',
      metaJson: JSON.stringify({ forked_from: sourceName }),
    });

    // Optionally inherit SOPs.
    if (opts.inheritSops !== false) {
      const sourceSops = this.listSops(sourceName);
      for (const sop of sourceSops) {
        this.addSop(newName, sop.title, sop.body);
      }
    }

    // Optionally inherit specialty signature.
    if (opts.inheritSpecialty !== false) {
      const sourceSig = this.getSpecialtySignature(sourceName);
      if (sourceSig) {
        this.updateSpecialtySignature({
          identityName: newName,
          topClustersJson: sourceSig.topClustersJson,
          topPatternsJson: sourceSig.topPatternsJson,
          topFilesJson: sourceSig.topFilesJson,
          hazardsSurfaced: sourceSig.hazardsSurfaced,
          hazardsResolved: sourceSig.hazardsResolved,
          meanResolveMs: sourceSig.meanResolveMs,
          computedAt: Date.now(),
          dirty: 1, // Will diverge naturally.
        });
      }
    }

    return profile;
  }
}
