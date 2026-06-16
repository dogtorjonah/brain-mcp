CREATE TABLE IF NOT EXISTS atlas_file_witnesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  instance_name TEXT,
  engine TEXT,
  interaction_counts TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(interaction_counts)),
  evidence TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(evidence)),
  confidence REAL NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_event_id TEXT,
  last_turn_id TEXT,
  last_tool TEXT,
  last_interaction TEXT NOT NULL DEFAULT 'unknown',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (workspace, file_path, instance_id)
);

CREATE INDEX IF NOT EXISTS idx_atlas_file_witnesses_file
  ON atlas_file_witnesses (workspace, file_path, confidence DESC, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_atlas_file_witnesses_instance
  ON atlas_file_witnesses (workspace, instance_id, last_seen_at DESC);
