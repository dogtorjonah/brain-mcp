import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, searchAtlasFiles, searchFts, searchVector } from '../db.js';
import {
  embedAtlasQueryText,
  fuseReciprocalRankResults,
} from '../embeddings.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface RankedResult {
  file_path: string;
  score: number;
  record: AtlasFileRecord;
  source: 'fts' | 'vector' | 'fallback';
}

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function buildSearchQuery(file: AtlasFileRecord): string {
  return [
    file.file_path,
    file.purpose,
    file.blurb,
    ...file.patterns,
    ...file.hazards,
  ].filter(Boolean).join('\n').trim();
}

function mapHitsToRanked(hits: Array<{ file: AtlasFileRecord; score: number; source: 'fts' | 'vector' }>): RankedResult[] {
  return hits.map((hit) => ({
    file_path: hit.file.file_path,
    score: hit.score,
    record: hit.file,
    source: hit.source,
  }));
}

function toFusionResults(results: RankedResult[]) {
  return results
    .filter((result): result is RankedResult & { source: 'fts' | 'vector' } => result.source !== 'fallback')
    .map((result) => ({
      id: result.file_path,
      item: result.record,
      score: result.score,
      source: result.source,
    }));
}

function atlasContent(format: 'json' | 'text' | undefined, payload: Record<string, unknown>, text: string) {
  return {
    content: [{
      type: 'text' as const,
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export interface AtlasSimilarArgs {
  file_path?: string;
  filePath?: string;
  workspace?: string;
  limit?: number;
  min_score?: number;
  minScore?: number;
  format?: 'json' | 'text';
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runSimilarTool(runtime: AtlasRuntime, {
  file_path,
  filePath,
  workspace,
  limit,
  min_score,
  minScore,
  format,
}: AtlasSimilarArgs): Promise<AtlasToolTextResult> {
  const context = resolveDbContext(runtime, workspace);
  if (!context) {
    return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
  }

  const ws = context.workspace;
  const targetFile = file_path ?? filePath;
  if (!targetFile) {
    return { content: [{ type: 'text', text: 'atlas_similar requires "file_path".' }] };
  }

  const seedRow = getAtlasFile(context.db, ws, targetFile);
  if (!seedRow) {
    return { content: [{ type: 'text', text: `No atlas row found for ${targetFile} in workspace "${ws}".` }] };
  }

  const maxResults = Math.max(1, Math.min(limit ?? 10, 50));
  const minSimilarity = Math.max(0, Math.min(min_score ?? minScore ?? 0.5, 1));
  const query = buildSearchQuery(seedRow) || `${seedRow.file_path}\n${seedRow.purpose || seedRow.blurb || ''}`;
  const candidateLimit = Math.max(maxResults * 3, 20);
  const ftsResults = mapHitsToRanked(searchFts(context.db, ws, query, candidateLimit));
  let vectorResults: RankedResult[] = [];
  try {
    const embedding = await embedAtlasQueryText(query, runtime.config);
    vectorResults = mapHitsToRanked(searchVector(context.db, ws, embedding, candidateLimit));
  } catch {
    vectorResults = [];
  }

  let results: RankedResult[] = fuseReciprocalRankResults(
    toFusionResults(ftsResults),
    toFusionResults(vectorResults),
  ).map((entry) => ({
    file_path: entry.item.file_path,
    score: entry.score,
    record: entry.item,
    source: entry.source,
  }));

  if (results.length === 0) {
    results = searchAtlasFiles(context.db, ws, query, candidateLimit).map((record, index) => ({
      file_path: record.file_path,
      score: 1 / (index + 1),
      record,
      source: 'fallback' as const,
    }));
  }

  results = results
    .filter((entry) => entry.file_path !== seedRow.file_path)
    .filter((entry) => entry.score >= minSimilarity)
    .slice(0, maxResults);

  const lines = [
    '## Atlas Similar',
    '',
    `Seed: ${seedRow.file_path}`,
  ];

  if (results.length === 0) {
    lines.push(`- No similar files found with min_score=${minSimilarity.toFixed(2)}.`);
  } else {
    lines.push(...results.map((entry) => `- ${entry.record.file_path} (${(entry.score * 100).toFixed(1)}%) — ${entry.record.purpose || entry.record.blurb}`));
  }

  return atlasContent(format, {
    ok: true,
    workspace: ws,
    file_path: seedRow.file_path,
    limit: maxResults,
    min_score: minSimilarity,
    results: results.map((entry) => ({
      file_path: entry.record.file_path,
      score: entry.score,
      source: entry.source,
      cluster: entry.record.cluster ?? null,
      purpose: entry.record.purpose || entry.record.blurb || '',
    })),
    summary: {
      result_count: results.length,
    },
  }, lines.join('\n'));
}

export function registerSimilarTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_similar',
    'Find files similar to a given file. Uses BM25 full-text search over file purpose, patterns, hazards, and descriptions. The index grows organically as agents fill in metadata via atlas_commit. Best for: finding related modules, potential duplicates, parallel implementations, and migration candidates. Supports cross-workspace lookup. No API key required.',
    {
      file_path: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      min_score: z.coerce.number().min(0).max(1).optional(),
      minScore: z.coerce.number().min(0).max(1).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async (args: AtlasSimilarArgs) => runSimilarTool(runtime, args),
  );
}
