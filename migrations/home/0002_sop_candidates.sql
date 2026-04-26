-- 0002: SOP candidates table for auto-discovered Standard Operating Procedures.
--
-- A SOP candidate is a repeated tool-call sequence observed across distinct
-- sessions for the same identity. The background worker normalizes
-- transcript chunks into (tool_name, primary_arg) tuples, hashes the
-- sequence, and upserts candidates here.

-- Core candidates table
CREATE TABLE IF NOT EXISTS sop_candidates (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name   TEXT NOT NULL,
  signature_hash  TEXT NOT NULL,    -- SHA-256 of the normalized sequence
  sequence        TEXT NOT NULL,    -- JSON array of [tool_name, primary_arg] tuples
  tool_kinds      INTEGER NOT NULL DEFAULT 0,  -- count of distinct tool kinds
  occurrences     INTEGER NOT NULL DEFAULT 1,
  first_seen_at   INTEGER NOT NULL,  -- epoch ms
  last_seen_at    INTEGER NOT NULL,  -- epoch ms
  example_session_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of up to 5 session IDs
  promoted_sop_id INTEGER,          -- set when promoted to identity_sops
  created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  updated_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  FOREIGN KEY (identity_name) REFERENCES identity_profiles(name),
  UNIQUE(identity_name, signature_hash)
);

-- Fast lookup: find candidates for an identity ordered by frequency
CREATE INDEX IF NOT EXISTS idx_candidates_identity_freq
  ON sop_candidates(identity_name, occurrences DESC, last_seen_at DESC);

-- Fast lookup: find candidates by hash for upsert
CREATE INDEX IF NOT EXISTS idx_candidates_identity_hash
  ON sop_candidates(identity_name, signature_hash);
