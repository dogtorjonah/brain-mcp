-- brain-mcp Home DB: Initial Schema
-- ~/.brain/brain.sqlite
--
-- This is the central identity + synapse + transcript store.
-- Atlas data lives in per-repo <repo>/.brain/atlas.sqlite (attached via ATTACH).
--
-- Embedding dimension: 384 (local ONNX BGE-small, same as relay atlas + rebirth-mcp)
-- All timestamps are INTEGER (Unix epoch ms) unless noted.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ──────────────────────────────────────────────
-- Identity core
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS identity_profiles (
  name              TEXT PRIMARY KEY,           -- filesystem-safe identity name
  blurb             TEXT NOT NULL DEFAULT '',   -- self-description, agent-authored
  specialty_tags    TEXT NOT NULL DEFAULT '',   -- comma-separated tags
  created_at        INTEGER NOT NULL,           -- Unix epoch ms
  updated_at        INTEGER NOT NULL,           -- Unix epoch ms
  forked_from       TEXT REFERENCES identity_profiles(name),
  retired_at        INTEGER                    -- soft-delete marker; NULL = active
);

CREATE TABLE IF NOT EXISTS identity_chain (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  event_kind        TEXT NOT NULL,              -- spawn, rebirth, swap-in, swap-out, mint, fork
  session_id        TEXT,
  cwd               TEXT,
  wrapper_pid       INTEGER,
  ts                INTEGER NOT NULL,           -- Unix epoch ms
  meta_json         TEXT                        -- arbitrary event payload
);
CREATE INDEX IF NOT EXISTS idx_chain_identity ON identity_chain(identity_name);
CREATE INDEX IF NOT EXISTS idx_chain_session ON identity_chain(session_id);

CREATE TABLE IF NOT EXISTS identity_sops (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  title             TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  promoted_from_candidate INTEGER,              -- FK to sop_candidates.id (set after promotion)
  retired_at        INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sops_identity ON identity_sops(identity_name);

CREATE TABLE IF NOT EXISTS identity_handoff_notes (
  identity_name     TEXT PRIMARY KEY REFERENCES identity_profiles(name),
  note              TEXT NOT NULL DEFAULT '',
  updated_at        INTEGER NOT NULL,
  updated_by_session TEXT
);

-- ──────────────────────────────────────────────
-- Identity vector + specialty signature
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS specialty_signatures (
  identity_name     TEXT PRIMARY KEY REFERENCES identity_profiles(name),
  top_clusters_json TEXT NOT NULL DEFAULT '[]', -- [{cluster, count}, ...]
  top_patterns_json TEXT NOT NULL DEFAULT '[]',
  top_files_json    TEXT NOT NULL DEFAULT '[]',
  hazards_surfaced  INTEGER NOT NULL DEFAULT 0,
  hazards_resolved  INTEGER NOT NULL DEFAULT 0,
  mean_resolve_ms   INTEGER,                    -- mean ms from surfaced→resolved for own hazards
  computed_at       INTEGER NOT NULL,
  dirty             INTEGER NOT NULL DEFAULT 1  -- recompute on next read if 1
);

-- ──────────────────────────────────────────────
-- Session ↔ identity binding
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS session_identity (
  session_id        TEXT PRIMARY KEY,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  bound_at          INTEGER NOT NULL,
  source            TEXT NOT NULL               -- spawn, rebirth, swap, manual
);

-- ──────────────────────────────────────────────
-- Transcripts
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transcript_chunks (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id        TEXT NOT NULL,
  identity_name     TEXT,                       -- null = pre-attribution
  cwd               TEXT,
  turn_index        INTEGER NOT NULL,
  role              TEXT NOT NULL,              -- user, assistant, tool, system
  text              TEXT NOT NULL,
  file_paths_json   TEXT NOT NULL DEFAULT '[]', -- mined paths from content
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chunks_session ON transcript_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_chunks_identity ON transcript_chunks(identity_name);

CREATE VIRTUAL TABLE IF NOT EXISTS transcript_chunks_fts USING fts5(
  text, content=transcript_chunks, content_rowid=id
);

-- ──────────────────────────────────────────────
-- The synapse layer (cross-repo identity↔file edges)
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS atlas_identity_edges (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name     TEXT NOT NULL REFERENCES identity_profiles(name),
  workspace         TEXT NOT NULL,              -- workspace name (repo identifier)
  file_path         TEXT NOT NULL,
  changelog_id      INTEGER,                    -- atlas.atlas_changelog.id when applicable
  kind              TEXT NOT NULL,              -- commit, surfaced, resolved, pattern_added, pattern_removed, source_highlight, lookup
  detail            TEXT,                       -- hazard string, pattern string, etc
  session_id        TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edges_identity ON atlas_identity_edges(identity_name);
CREATE INDEX IF NOT EXISTS idx_edges_workspace_file ON atlas_identity_edges(workspace, file_path);
CREATE INDEX IF NOT EXISTS idx_edges_kind_detail ON atlas_identity_edges(kind, detail);
CREATE INDEX IF NOT EXISTS idx_edges_ts ON atlas_identity_edges(ts);
CREATE INDEX IF NOT EXISTS idx_edges_changelog ON atlas_identity_edges(changelog_id);

-- ──────────────────────────────────────────────
-- Repo registry
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repo_registry (
  workspace         TEXT PRIMARY KEY,
  cwd               TEXT NOT NULL,              -- absolute path to repo root
  atlas_path        TEXT NOT NULL,              -- absolute path to atlas.sqlite
  first_seen_at     INTEGER NOT NULL,
  last_attached_at  INTEGER NOT NULL,
  last_extraction_at INTEGER
);

-- ──────────────────────────────────────────────
-- Schema metadata
-- ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS brain_meta (
  key               TEXT PRIMARY KEY,
  value             TEXT NOT NULL
);

INSERT OR IGNORE INTO brain_meta (key, value) VALUES ('schema_version', '1');
INSERT OR IGNORE INTO brain_meta (key, value) VALUES ('embedding_dim', '384');
INSERT OR IGNORE INTO brain_meta (key, value) VALUES ('created_at', CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER));
