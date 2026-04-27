-- Transcript chunk indexing extensions.
--
-- 0001 creates the core transcript_chunks and FTS table. This migration adds
-- stable chunk metadata plus FTS sync triggers. The vec0 table is created at
-- runtime only when sqlite-vec is loaded, because SQLite migrations cannot
-- safely create vec0 tables on installs where the extension is unavailable.

ALTER TABLE transcript_chunks ADD COLUMN chunk_id TEXT;
ALTER TABLE transcript_chunks ADD COLUMN tool_name TEXT;
ALTER TABLE transcript_chunks ADD COLUMN text_hash TEXT;
ALTER TABLE transcript_chunks ADD COLUMN source_path TEXT;
ALTER TABLE transcript_chunks ADD COLUMN has_vector INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transcript_chunks_chunk_id
  ON transcript_chunks(chunk_id)
  WHERE chunk_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transcript_chunks_source_path
  ON transcript_chunks(source_path);

CREATE TRIGGER IF NOT EXISTS transcript_chunks_ai
AFTER INSERT ON transcript_chunks
BEGIN
  INSERT INTO transcript_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_chunks_ad
AFTER DELETE ON transcript_chunks
BEGIN
  INSERT INTO transcript_chunks_fts(transcript_chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS transcript_chunks_au
AFTER UPDATE OF text ON transcript_chunks
BEGIN
  INSERT INTO transcript_chunks_fts(transcript_chunks_fts, rowid, text)
  VALUES ('delete', old.id, old.text);
  INSERT INTO transcript_chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

INSERT INTO transcript_chunks_fts(transcript_chunks_fts) VALUES ('rebuild');
