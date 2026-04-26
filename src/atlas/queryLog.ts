import type { AtlasRuntime } from './types.js';

export interface QueryEntry {
  query: string;
  fileIds: number[];
  filePaths: string[];
  timestamp: number;
}

export type QueryLogEntry = QueryEntry;

const MAX_QUERY_LOG_ENTRIES = 20;
const entries: QueryEntry[] = [];

export function trackQuery(query: string, fileIds: number[], filePaths: string[]): void {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) {
    return;
  }

  entries.unshift({
    query: normalizedQuery,
    fileIds: [...new Set(fileIds.filter((id) => Number.isFinite(id)))],
    filePaths: [...new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))],
    timestamp: Date.now(),
  });

  if (entries.length > MAX_QUERY_LOG_ENTRIES) {
    entries.length = MAX_QUERY_LOG_ENTRIES;
  }
}

export function listRecentQueries(): QueryEntry[] {
  return [...entries];
}

export function getRecentQueries(): string[] {
  return entries.map((entry) => entry.query);
}

export function getRecentFileIds(): number[] {
  const seen = new Set<number>();
  const ids: number[] = [];

  for (const entry of entries) {
    for (const id of entry.fileIds) {
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
  }

  return ids;
}

export function getRecentFilePaths(): string[] {
  const seen = new Set<string>();
  const filePaths: string[] = [];

  for (const entry of entries) {
    for (const filePath of entry.filePaths) {
      if (seen.has(filePath)) {
        continue;
      }
      seen.add(filePath);
      filePaths.push(filePath);
    }
  }

  return filePaths;
}

export function resetQueryLog(): void {
  entries.length = 0;
}

export function getQueryLogSummary(_runtime?: AtlasRuntime): string {
  if (entries.length === 0) {
    return 'No recent atlas queries yet.';
  }

  return entries
    .slice(0, 10)
    .map((entry) => {
      const targets = entry.filePaths.slice(0, 5).join(', ') || 'no files';
      return `- ${entry.query} -> ${targets}`;
    })
    .join('\n');
}
