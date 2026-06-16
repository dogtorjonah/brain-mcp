-- Operator candidate memory inbox for atlas_commit.
--
-- This table is deliberately adjacent to Atlas changelog rows rather than
-- folded into atlas_files. Notes here default to review_status='candidate':
-- they capture repeated, evidence-backed observations about the operator's
-- preferences, workflow instincts, boundaries, corrections, and project taste
-- without treating one agent's inference as canon.
--
-- dedupe_key is indexed but not unique. Repetition is useful signal for later
-- consolidation/ranking, while raw evidence stays available for review.

CREATE TABLE IF NOT EXISTS atlas_operator_memory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace TEXT NOT NULL,
  changelog_id INTEGER REFERENCES atlas_changelog(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  note TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'context',
  confidence TEXT NOT NULL DEFAULT 'medium',
  evidence TEXT,
  author_instance_id TEXT,
  author_engine TEXT,
  author_name TEXT,
  source TEXT NOT NULL DEFAULT 'atlas_commit',
  review_status TEXT NOT NULL DEFAULT 'candidate',
  dedupe_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (length(trim(note)) > 0),
  CHECK (category IN ('preference', 'workflow', 'boundary', 'taste', 'context', 'correction')),
  CHECK (confidence IN ('low', 'medium', 'high')),
  CHECK (review_status IN ('candidate', 'accepted', 'rejected', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_operator_memory_workspace_created
  ON atlas_operator_memory(workspace, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_memory_category
  ON atlas_operator_memory(workspace, category, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_operator_memory_changelog
  ON atlas_operator_memory(workspace, changelog_id);

CREATE INDEX IF NOT EXISTS idx_operator_memory_dedupe
  ON atlas_operator_memory(workspace, dedupe_key);
