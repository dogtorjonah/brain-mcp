CREATE TABLE IF NOT EXISTS atlas_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  file_path TEXT NOT NULL,
  summary TEXT NOT NULL,
  patterns_added TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(patterns_added)),
  patterns_removed TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(patterns_removed)),
  hazards_added TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hazards_added)),
  hazards_removed TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(hazards_removed)),
  cluster TEXT,
  breaking_changes INTEGER NOT NULL DEFAULT 0,
  commit_sha TEXT,
  author_instance_id TEXT,
  author_engine TEXT,
  review_entry_id TEXT,
  source TEXT NOT NULL DEFAULT 'agent',
  verification_status TEXT NOT NULL DEFAULT 'pending',
  verification_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_changelog_file
  ON atlas_changelog(workspace, file_path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_changelog_time
  ON atlas_changelog(workspace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_changelog_unverified
  ON atlas_changelog(workspace, verification_status)
  WHERE verification_status != 'confirmed';

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_changelog_fts USING fts5(
  file_path,
  summary,
  cluster,
  patterns_added,
  hazards_added,
  content=atlas_changelog,
  content_rowid=id
);

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_changelog_embeddings USING vec0(
  changelog_id INTEGER PRIMARY KEY,
  embedding float[1536]
);

-- FTS sync triggers — keep atlas_changelog_fts in sync with atlas_changelog
CREATE TRIGGER IF NOT EXISTS atlas_changelog_ai AFTER INSERT ON atlas_changelog BEGIN
  INSERT INTO atlas_changelog_fts(rowid, file_path, summary, cluster, patterns_added, hazards_added)
  VALUES (new.id, new.file_path, new.summary, COALESCE(new.cluster, ''), new.patterns_added, new.hazards_added);
END;

CREATE TRIGGER IF NOT EXISTS atlas_changelog_ad AFTER DELETE ON atlas_changelog BEGIN
  INSERT INTO atlas_changelog_fts(atlas_changelog_fts, rowid, file_path, summary, cluster, patterns_added, hazards_added)
  VALUES ('delete', old.id, old.file_path, old.summary, COALESCE(old.cluster, ''), old.patterns_added, old.hazards_added);
END;

CREATE TRIGGER IF NOT EXISTS atlas_changelog_au AFTER UPDATE ON atlas_changelog BEGIN
  INSERT INTO atlas_changelog_fts(atlas_changelog_fts, rowid, file_path, summary, cluster, patterns_added, hazards_added)
  VALUES ('delete', old.id, old.file_path, old.summary, COALESCE(old.cluster, ''), old.patterns_added, old.hazards_added);
  INSERT INTO atlas_changelog_fts(rowid, file_path, summary, cluster, patterns_added, hazards_added)
  VALUES (new.id, new.file_path, new.summary, COALESCE(new.cluster, ''), new.patterns_added, new.hazards_added);
END;
