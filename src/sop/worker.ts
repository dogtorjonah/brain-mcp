/**
 * SOP background discovery worker.
 *
 * Triggered after transcript chunks are indexed. Mines tool-call sequences
 * from the new chunks, hashes them, and upserts into `sop_candidates`.
 *
 * The worker is designed to be called from the transcript indexer's
 * post-insertion hook (not a separate cron). Each invocation processes
 * only the chunks from the session that was just indexed, keeping the
 * work proportional to new data.
 */

import type Database from 'better-sqlite3';
import { mineSequencesFromSession, levenshteinSkipHashes, hashSequence, type NormalizerConfig } from './normalizer.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface WorkerDeps {
  /** The home database connection. */
  db: Database.Database;
  /** Query tool_call chunks for a session. Returns rows with tool_name, file_paths, text, timestamp_ms. */
  querySessionChunks(sessionId: string): Array<{
    chunk_id: string;
    session_id: string;
    tool_name: string;
    file_paths: string;
    text: string;
    timestamp_ms: number;
  }>;
}

export interface WorkerConfig extends NormalizerConfig {
  /** Minimum occurrences across distinct sessions to become a candidate. Default 3. */
  minOccurrences?: number;
  /** Max example session IDs to store. Default 5. */
  maxExampleSessions?: number;
}

const DEFAULT_WORKER_CONFIG: Required<WorkerConfig> = {
  minSequenceLength: 3,
  maxSequenceLength: 8,
  minToolKinds: 2,
  maxPathSpecificity: 0.8,
  minOccurrences: 3,
  maxExampleSessions: 5,
};

// ── Worker ─────────────────────────────────────────────────────────────

/**
 * Run SOP discovery for a session that was just indexed.
 *
 * 1. Fetch all tool_call chunks for the session
 * 2. Mine sequences from them
 * 3. For each sequence, check if a matching candidate exists (exact or Levenshtein-1)
 * 4. If match found, increment occurrences
 * 5. If new, insert as a new candidate
 */
export function runSopDiscovery(
  deps: WorkerDeps,
  sessionId: string,
  identityName: string,
  config?: WorkerConfig,
): { candidatesInserted: number; candidatesUpdated: number } {
  const cfg = { ...DEFAULT_WORKER_CONFIG, ...config };
  const { db } = deps;

  let candidatesInserted = 0;
  let candidatesUpdated = 0;

  // Step 1: Fetch tool_call chunks
  const chunks = deps.querySessionChunks(sessionId);
  if (chunks.length < cfg.minSequenceLength) {
    return { candidatesInserted: 0, candidatesUpdated: 0 };
  }

  // Step 2: Mine sequences
  const sequences = mineSequencesFromSession(chunks, identityName, cfg);

  // Deduplicate by hash within this session (only count each unique sequence once per session)
  const seenHashes = new Set<string>();

  // Step 3: Upsert each sequence
  const upsertStmt = db.prepare(`
    INSERT INTO sop_candidates (identity_name, signature_hash, sequence, tool_kinds, occurrences, first_seen_at, last_seen_at, example_session_ids)
    VALUES (:identityName, :hash, :sequence, :toolKinds, 1, :ts, :ts, :sessions)
    ON CONFLICT(identity_name, signature_hash) DO UPDATE SET
      occurrences = occurrences + 1,
      last_seen_at = :ts,
      example_session_ids = :sessions,
      updated_at = unixepoch() * 1000
  `);

  // Check for Levenshtein-1 matches
  const findStmt = db.prepare(`
    SELECT id, signature_hash FROM sop_candidates
    WHERE identity_name = ? AND signature_hash IN (SELECT value FROM json_each(?))
  `);

  const updateOccStmt = db.prepare(`
    UPDATE sop_candidates
    SET occurrences = occurrences + 1,
        last_seen_at = ?,
        example_session_ids = ?,
        updated_at = unixepoch() * 1000
    WHERE id = ?
  `);

  for (const seq of sequences) {
    if (seenHashes.has(seq.signatureHash)) continue;
    seenHashes.add(seq.signatureHash);

    const sequenceJson = JSON.stringify(seq.steps.map((s) => [s.toolName, s.primaryArg]));
    const sessionsJson = JSON.stringify([sessionId]);
    const ts = seq.timestampMs;

    // Try exact match first
    const exact = db.prepare(
      'SELECT id FROM sop_candidates WHERE identity_name = ? AND signature_hash = ?',
    ).get(identityName, seq.signatureHash) as { id: number } | undefined;

    if (exact) {
      updateOccStmt.run(ts, sessionsJson, exact.id);
      candidatesUpdated++;
      continue;
    }

    // Try Levenshtein-1 match
    const skipHashes = levenshteinSkipHashes(seq.steps);
    const skipHashesJson = JSON.stringify(skipHashes);
    const skipMatch = findStmt.get(identityName, skipHashesJson) as { id: number; signature_hash: string } | undefined;

    if (skipMatch) {
      updateOccStmt.run(ts, sessionsJson, skipMatch.id);
      candidatesUpdated++;
      continue;
    }

    // No match — insert new candidate
    upsertStmt.run({
      identityName,
      hash: seq.signatureHash,
      sequence: sequenceJson,
      toolKinds: seq.toolKinds,
      ts,
      sessions: sessionsJson,
    });
    candidatesInserted++;
  }

  return { candidatesInserted, candidatesUpdated };
}

/**
 * Prune stale candidates: discard candidates where
 * now - last_seen_at > 30 days AND promoted_sop_id IS NULL.
 */
export function pruneStaleCandidates(db: Database.Database, maxAgeMs = 30 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - maxAgeMs;
  const result = db.prepare(
    `DELETE FROM sop_candidates WHERE last_seen_at < ? AND promoted_sop_id IS NULL`,
  ).run(cutoff);
  return result.changes;
}
