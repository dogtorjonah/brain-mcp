ALTER TABLE atlas_changelog ADD COLUMN recovery_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_changelog_recovery_key
  ON atlas_changelog(workspace, recovery_key)
  WHERE recovery_key IS NOT NULL AND recovery_key != '';
