import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasCrossRefs, AtlasFileRecord } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, listAtlasFiles } from '../db.js';
import { getRecentFilePaths, getRecentQueries } from '../queryLog.js';

const RESOURCE_URI = 'atlas://context';

function summarizeBlastRadius(crossRefs: AtlasCrossRefs | null): string {
  if (!crossRefs) {
    return 'unknown';
  }

  const radii = Object.values(crossRefs.symbols ?? {})
    .map((symbol) => symbol.blast_radius)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);

  if (radii.length === 0) {
    return 'local';
  }

  if (radii.includes('broad')) return 'broad';
  if (radii.includes('moderate')) return 'moderate';
  if (radii.includes('narrow')) return 'narrow';
  return radii[0] ?? 'local';
}

function summarizeHazards(record: AtlasFileRecord): string {
  if (record.hazards.length === 0) {
    return 'none';
  }
  return record.hazards.slice(0, 2).join('; ');
}

function summarizeCluster(records: AtlasFileRecord[]): string {
  const counts = new Map<string, number>();
  for (const record of records) {
    const cluster = record.cluster ?? 'uncategorized';
    counts.set(cluster, (counts.get(cluster) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 5)
    .map(([cluster, count]) => `${cluster} (${count})`)
    .join(', ');
}

function sortByFreshness(records: AtlasFileRecord[]): AtlasFileRecord[] {
  return [...records].sort((left, right) => {
    const leftStamp = left.last_extracted ?? '';
    const rightStamp = right.last_extracted ?? '';
    return rightStamp.localeCompare(leftStamp) || left.file_path.localeCompare(right.file_path);
  });
}

function truncate(text: string, limit = 220): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit - 1)}…`;
}

function collectRecentRecords(db: AtlasDatabase, workspace: string): AtlasFileRecord[] {
  const recentPaths = getRecentFilePaths().slice(0, 5);
  if (recentPaths.length > 0) {
    return recentPaths
      .map((filePath) => getAtlasFile(db, workspace, filePath))
      .filter((record): record is AtlasFileRecord => Boolean(record));
  }

  return sortByFreshness(listAtlasFiles(db, workspace)).slice(0, 5);
}

export function generateContextResource(db: AtlasDatabase, workspace: string): string {
  const recentQueries = getRecentQueries().slice(0, 5);
  const records = collectRecentRecords(db, workspace);

  const recentLines = records.map((record) => {
    const blastRadius = summarizeBlastRadius(record.cross_refs);
    const hazardSummary = summarizeHazards(record);
    const purpose = record.purpose || record.blurb || 'No summary available.';
    return [
      `- **${record.file_path}**`,
      `  - ${truncate(purpose)}`,
      `  - Hazards: ${truncate(hazardSummary)}`,
      `  - Blast radius: ${blastRadius}`,
    ].join('\n');
  });

  return [
    '# Atlas Codebase Context',
    '',
    `Workspace: \`${workspace}\``,
    '',
    '## Recent Queries',
    recentQueries.length > 0
      ? recentQueries.map((query) => `- ${truncate(query, 120)}`).join('\n')
      : '- No prior atlas queries.',
    '',
    '## Relevant Files',
    recentLines.length > 0 ? recentLines.join('\n') : '- No atlas files indexed yet.',
    '',
    '## Cluster Summary',
    summarizeCluster(records) || 'No clusters available yet.',
    '',
    `Subscribe to \`${RESOURCE_URI}\` for automatic updates.`,
  ].join('\n');
}

export const ATLAS_CONTEXT_RESOURCE_URI = RESOURCE_URI;

export async function notifyAtlasContextUpdated(server?: McpServer | null): Promise<void> {
  if (!server) {
    return;
  }

  await server.server.sendResourceUpdated({ uri: RESOURCE_URI });
}
