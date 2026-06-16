ALTER TABLE atlas_changelog ADD COLUMN author_engine_type TEXT;

CREATE INDEX IF NOT EXISTS idx_changelog_author_engine_type
  ON atlas_changelog(workspace, author_engine_type, created_at DESC)
  WHERE author_engine_type IS NOT NULL AND author_engine_type != '';
