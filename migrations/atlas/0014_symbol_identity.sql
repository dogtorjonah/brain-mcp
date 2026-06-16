-- Symbol-level identity sidecar.
--
-- Reindex-proof by design: keyed by (workspace, file_path, symbol) with no
-- foreign key into atlas_files, so atlas init/reindex rebuilds never drop
-- curated per-symbol purpose/hazards. Rows are upserted via atlas_commit's
-- symbol_identities[] payload field and rendered by atlas_query action=lookup.

CREATE TABLE IF NOT EXISTS atlas_symbol_identity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  symbol TEXT NOT NULL,
  purpose TEXT NOT NULL,
  hazards TEXT NOT NULL DEFAULT '[]',
  updated_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace, file_path, symbol)
);

CREATE INDEX IF NOT EXISTS idx_atlas_symbol_identity_file
  ON atlas_symbol_identity (workspace, file_path);
