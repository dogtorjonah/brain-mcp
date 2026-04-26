CREATE TABLE IF NOT EXISTS atlas_source_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  file_path TEXT NOT NULL,
  chunk_kind TEXT NOT NULL,
  label TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  content TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES atlas_files(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_source_chunks_workspace_path
  ON atlas_source_chunks (workspace, file_path, start_line);

CREATE INDEX IF NOT EXISTS idx_atlas_source_chunks_file
  ON atlas_source_chunks (file_id, start_line);

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_source_chunk_embeddings USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1536]
);
