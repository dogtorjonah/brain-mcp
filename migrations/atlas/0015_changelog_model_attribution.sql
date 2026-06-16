ALTER TABLE atlas_changelog ADD COLUMN author_model TEXT;

CREATE INDEX IF NOT EXISTS idx_changelog_author_model
  ON atlas_changelog(workspace, author_model, created_at DESC)
  WHERE author_model IS NOT NULL AND author_model != '';
