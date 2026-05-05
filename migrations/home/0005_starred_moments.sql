-- 0005_starred_moments.sql
-- Persistent cognitive waypoints for agent transcripts.
-- Stars are short, categorized snippets an agent pins during work.
-- Categorized stars auto-inject into handoff/rebirth packages so a
-- successor sees a curated highlight reel without any extra tool call.

CREATE TABLE IF NOT EXISTS starred_moments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_name   TEXT NOT NULL REFERENCES identity_profiles(name),
  session_id      TEXT,                           -- session that created the star
  note            TEXT NOT NULL,                  -- max 200 chars for categorized, 120 for ambient
  category        TEXT,                           -- decision | discovery | pivot | handoff | gotcha | result
  ts              INTEGER NOT NULL                -- Unix epoch ms
);

CREATE INDEX IF NOT EXISTS idx_starred_moments_identity
  ON starred_moments(identity_name);

CREATE INDEX IF NOT EXISTS idx_starred_moments_category
  ON starred_moments(identity_name, category);

CREATE INDEX IF NOT EXISTS idx_starred_moments_ts
  ON starred_moments(ts);
