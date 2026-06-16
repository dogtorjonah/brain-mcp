import type { AtlasHazardWithRange } from '../types.js';

export interface AutoSyncDriftStats {
  legacyOrphansAdded: number;
  structuredOrphansAdded: number;
  duplicatesCollapsed: number;
}

export interface AutoSyncHazardsResult {
  syncedHazards: string[];
  syncedHazardsWithRanges: AtlasHazardWithRange[];
  driftStats: AutoSyncDriftStats;
}

export function autoSyncHazardsColumns(
  legacy: string[],
  structured: AtlasHazardWithRange[],
): AutoSyncHazardsResult {
  const legacyTexts = new Set(
    legacy
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter((trimmed) => trimmed.length > 0),
  );

  const structuredTexts = new Set(
    structured
      .map((entry) => (typeof entry?.text === 'string' ? entry.text.trim() : ''))
      .filter((trimmed) => trimmed.length > 0),
  );

  const orphanLegacyEntries = legacy.filter((entry) => {
    if (typeof entry !== 'string') return false;
    const trimmed = entry.trim();
    return trimmed.length > 0 && !structuredTexts.has(trimmed);
  });

  const orphanStructuredEntries = structured.filter((entry) => {
    const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
    return text.length > 0 && !legacyTexts.has(text);
  });

  const syncedHazardsWithRanges: AtlasHazardWithRange[] = [
    ...structured,
    ...orphanLegacyEntries.map((text) => ({
      text,
      startLine: null,
      endLine: null,
    })),
  ];

  const syncedHazards: string[] = [
    ...legacy,
    ...orphanStructuredEntries.map((entry) => entry.text),
  ];

  let duplicatesCollapsed = 0;
  for (const text of legacyTexts) {
    if (structuredTexts.has(text)) duplicatesCollapsed += 1;
  }

  return {
    syncedHazards,
    syncedHazardsWithRanges,
    driftStats: {
      legacyOrphansAdded: orphanLegacyEntries.length,
      structuredOrphansAdded: orphanStructuredEntries.length,
      duplicatesCollapsed,
    },
  };
}
