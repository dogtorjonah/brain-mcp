CREATE TABLE IF NOT EXISTS atlas_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  workspace TEXT NOT NULL,
  instance_id TEXT,
  tool_name TEXT NOT NULL,
  phase TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  result_count INTEGER NOT NULL DEFAULT 0,
  input_hash TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  error TEXT,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_metrics_tool
  ON atlas_metrics(tool_name, timestamp);

CREATE INDEX IF NOT EXISTS idx_metrics_instance
  ON atlas_metrics(instance_id, timestamp);
