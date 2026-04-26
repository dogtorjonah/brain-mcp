-- AI-curated source highlights: agent-selected code snippets stored during atlas_commit.
-- Replaces naive top-N line truncation with intelligent, disjointed segment selection.
-- Each highlight has an id (for "refer to snippet 3"), optional label, line range, and content.

ALTER TABLE atlas_files ADD COLUMN source_highlights TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(source_highlights));
