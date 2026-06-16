CREATE TABLE IF NOT EXISTS atlas_file_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_path TEXT NOT NULL,
  workspace TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  content_blob TEXT NOT NULL,
  changelog_id INTEGER REFERENCES atlas_changelog(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_file_workspace
  ON atlas_file_snapshots (file_path, workspace);

CREATE INDEX IF NOT EXISTS idx_snapshots_content_hash
  ON atlas_file_snapshots (content_hash);

CREATE INDEX IF NOT EXISTS idx_snapshots_changelog_id
  ON atlas_file_snapshots (changelog_id);
