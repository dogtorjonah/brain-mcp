ALTER TABLE atlas_files
  ADD COLUMN tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags));

DROP TABLE IF EXISTS atlas_fts;

CREATE VIRTUAL TABLE IF NOT EXISTS atlas_fts USING fts5(
  file_path,
  blurb,
  purpose,
  public_api,
  tags,
  patterns,
  hazards,
  cross_refs
);

INSERT INTO atlas_fts (
  rowid,
  file_path,
  blurb,
  purpose,
  public_api,
  tags,
  patterns,
  hazards,
  cross_refs
)
SELECT
  id,
  file_path,
  blurb,
  purpose,
  public_api,
  tags,
  patterns,
  hazards,
  cross_refs
FROM atlas_files;
