import type { AtlasFileRecord } from '../types.js';
import type { NormalizedAtlasCommitPayload } from './commitPayload.js';

export type AtlasCommitIdentityField = 'purpose' | 'blurb' | 'tags';
export type AtlasCommitRequiredMetadataField = AtlasCommitIdentityField | 'source_highlights';

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasList(value: unknown[] | null | undefined): boolean {
  return Array.isArray(value) && value.some((entry) => hasText(String(entry ?? '')));
}

function hasSourceHighlights(
  value: Pick<NonNullable<NormalizedAtlasCommitPayload['source_highlights']>[number], 'startLine' | 'endLine'>[] | null | undefined,
): boolean {
  return Array.isArray(value) && value.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    return Number.isFinite(entry.startLine) && Number.isFinite(entry.endLine)
      && entry.startLine >= 1 && entry.endLine >= entry.startLine;
  });
}

export function findMissingAtlasCommitIdentityFields(
  payload: Pick<NormalizedAtlasCommitPayload, 'purpose' | 'blurb' | 'tags'>,
  existing: Pick<AtlasFileRecord, 'purpose' | 'blurb' | 'tags'> | null | undefined,
): AtlasCommitIdentityField[] {
  const missing: AtlasCommitIdentityField[] = [];

  if (!hasText(payload.purpose) && !hasText(existing?.purpose)) {
    missing.push('purpose');
  }
  if (!hasText(payload.blurb) && !hasText(existing?.blurb)) {
    missing.push('blurb');
  }
  if (!hasList(payload.tags) && !hasList(existing?.tags)) {
    missing.push('tags');
  }

  return missing;
}

export function findMissingAtlasCommitRequiredMetadataFields(
  payload: Pick<NormalizedAtlasCommitPayload, 'purpose' | 'blurb' | 'tags' | 'source_highlights'>,
  existing: Pick<AtlasFileRecord, 'purpose' | 'blurb' | 'tags' | 'source_highlights'> | null | undefined,
): AtlasCommitRequiredMetadataField[] {
  const missing: AtlasCommitRequiredMetadataField[] = [
    ...findMissingAtlasCommitIdentityFields(payload, existing),
  ];

  if (!hasSourceHighlights(payload.source_highlights) && !hasSourceHighlights(existing?.source_highlights)) {
    missing.push('source_highlights');
  }

  return missing;
}
