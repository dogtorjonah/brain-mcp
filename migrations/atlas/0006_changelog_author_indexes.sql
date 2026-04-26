ALTER TABLE atlas_changelog ADD COLUMN author_name TEXT;

CREATE INDEX IF NOT EXISTS idx_changelog_author_instance
  ON atlas_changelog(workspace, author_instance_id, created_at DESC)
  WHERE author_instance_id IS NOT NULL AND author_instance_id != '';

CREATE INDEX IF NOT EXISTS idx_changelog_author_engine
  ON atlas_changelog(workspace, author_engine, created_at DESC)
  WHERE author_engine IS NOT NULL AND author_engine != '';

CREATE INDEX IF NOT EXISTS idx_changelog_author_name
  ON atlas_changelog(workspace, author_name, created_at DESC)
  WHERE author_name IS NOT NULL AND author_name != '';
