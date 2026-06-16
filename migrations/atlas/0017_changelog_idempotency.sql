ALTER TABLE atlas_changelog ADD COLUMN idempotency_key TEXT;
ALTER TABLE atlas_changelog ADD COLUMN idempotency_fingerprint TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_changelog_idempotency_key
  ON atlas_changelog(workspace, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND idempotency_key != '';
