-- Wave 44 structured hazard foundation.
--
-- Adds a parallel hazards_with_ranges TEXT column to atlas_files for storing
-- structured hazard entries with optional line ranges alongside the legacy
-- hazards text array. Phase 1 remains behavior-neutral: the new column is
-- populated only when atlas_commit callers opt in through the matching input.
--
-- Default '[]' lets pre-existing rows read as having no structured hazards
-- while existing readers continue to use the legacy hazards column.

ALTER TABLE atlas_files
  ADD COLUMN hazards_with_ranges TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(hazards_with_ranges));
