ALTER TABLE atlas_changelog ADD COLUMN author_identity TEXT;

ALTER TABLE atlas_meta ADD COLUMN brain_version TEXT;

CREATE INDEX IF NOT EXISTS idx_changelog_author_identity
  ON atlas_changelog(workspace, author_identity, created_at DESC)
  WHERE author_identity IS NOT NULL AND author_identity != '';
