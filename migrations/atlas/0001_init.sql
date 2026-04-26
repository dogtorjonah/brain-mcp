PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS atlas_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_hash TEXT,
  cluster TEXT,
  loc INTEGER NOT NULL DEFAULT 0,
  blurb TEXT NOT NULL DEFAULT '',
  purpose TEXT NOT NULL DEFAULT '',
  public_api TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(public_api)),
  exports TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(exports)),
  patterns TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(patterns)),
  dependencies TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(dependencies)),
  data_flows TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(data_flows)),
  key_types TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(key_types)),
  hazards TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hazards)),
  conventions TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(conventions)),
  cross_refs TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cross_refs)),
  language TEXT NOT NULL DEFAULT 'typescript',
  extraction_model TEXT,
  last_extracted TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace, file_path)
);

CREATE INDEX IF NOT EXISTS idx_atlas_files_workspace_path
  ON atlas_files (workspace, file_path);

CREATE INDEX IF NOT EXISTS idx_atlas_files_workspace_cluster
  ON atlas_files (workspace, cluster);

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_fts USING fts5(
  file_path,
  blurb,
  purpose,
  public_api,
  patterns,
  hazards,
  cross_refs
);

CREATE TABLE IF NOT EXISTS import_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_import_edges_workspace_source
  ON import_edges (workspace, source_file);

CREATE INDEX IF NOT EXISTS idx_import_edges_workspace_target
  ON import_edges (workspace, target_file);

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_embeddings USING vec0(
  file_id INTEGER PRIMARY KEY,
  embedding float[384]
);

CREATE TABLE IF NOT EXISTS atlas_reextract_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  trigger_reason TEXT NOT NULL DEFAULT 'file_release',
  queued_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_message TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_atlas_queue_dedupe
  ON atlas_reextract_queue (workspace, file_path)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_atlas_queue_pending
  ON atlas_reextract_queue (status, queued_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS atlas_meta (
  workspace TEXT PRIMARY KEY,
  source_root TEXT NOT NULL,
  provider TEXT,
  provider_config TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(provider_config)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
