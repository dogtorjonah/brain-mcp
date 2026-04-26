PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  line_start INTEGER,
  line_end INTEGER,
  signature_hash TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace, file_path, name, kind)
);

CREATE TABLE IF NOT EXISTS "references" (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  source_symbol_id INTEGER,
  target_symbol_id INTEGER,
  edge_type TEXT NOT NULL,
  source_file TEXT NOT NULL,
  target_file TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 1.0,
  provenance TEXT NOT NULL DEFAULT 'inferred',
  last_verified TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_symbol_id) REFERENCES symbols(id) ON DELETE CASCADE,
  FOREIGN KEY (target_symbol_id) REFERENCES symbols(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_symbols_workspace_file
  ON symbols (workspace, file_path);

CREATE INDEX IF NOT EXISTS idx_symbols_workspace_name
  ON symbols (workspace, name);

CREATE INDEX IF NOT EXISTS idx_references_workspace_target_symbol
  ON "references" (workspace, target_symbol_id);

CREATE INDEX IF NOT EXISTS idx_references_workspace_source_file
  ON "references" (workspace, source_file);

CREATE INDEX IF NOT EXISTS idx_references_workspace_target_file
  ON "references" (workspace, target_file);
