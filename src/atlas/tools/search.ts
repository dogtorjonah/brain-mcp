import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase, AtlasSourceChunkRecord } from '../db.js';
import {
  getAtlasFile,
  searchAtlasFiles,
  searchFts,
  searchSourceChunks,
  searchVector,
} from '../db.js';
import {
  embedAtlasQueryText,
  fuseReciprocalRankResults,
} from '../embeddings.js';
import { toolWithDescription } from './helpers.js';
import { trackQuery } from '../queryLog.js';
import { discoverWorkspaces, resolveWorkspaceDb } from './bridge.js';

interface RankedResult {
  file_path: string;
  score: number;
  record: AtlasFileRecord;
  source: 'fts' | 'vector' | 'fallback';
  matchedChunk?: AtlasSourceChunkRecord;
}

function mapHitsToRanked(hits: Array<{ file: AtlasFileRecord; score: number; source: 'fts' | 'vector' }>): RankedResult[] {
  return hits
    .filter((hit) => hit.file.file_path.length > 0)
    .map((hit) => ({
      file_path: hit.file.file_path,
      score: hit.score,
      record: hit.file,
      source: hit.source,
    }));
}

function mapSourceChunkHitsToRanked(
  db: AtlasDatabase,
  workspace: string,
  hits: Array<{ chunk: AtlasSourceChunkRecord; score: number }>,
): RankedResult[] {
  const bestByPath = new Map<string, RankedResult>();

  for (const hit of hits) {
    if (bestByPath.has(hit.chunk.file_path)) {
      continue;
    }
    const record = getAtlasFile(db, workspace, hit.chunk.file_path);
    if (!record || record.file_path.length === 0) {
      continue;
    }
    bestByPath.set(record.file_path, {
      file_path: record.file_path,
      score: hit.score,
      record,
      source: 'vector',
      matchedChunk: hit.chunk,
    });
  }

  return [...bestByPath.values()];
}

function toFusionResults(results: RankedResult[]) {
  return results
    .filter((result): result is RankedResult & { source: 'fts' | 'vector' } => result.source !== 'fallback')
    .map((result) => ({
      id: result.file_path,
      item: result,
      score: result.score,
      source: result.source,
    }));
}

function fuseVectorResults(fileVectors: RankedResult[], sourceChunkVectors: RankedResult[]): RankedResult[] {
  if (fileVectors.length === 0 && sourceChunkVectors.length === 0) {
    return [];
  }

  return fuseReciprocalRankResults(
    toFusionResults(sourceChunkVectors),
    toFusionResults(fileVectors),
  ).map((entry) => entry.item);
}

function attachChunkMatches(
  results: RankedResult[],
  sourceChunkResults: RankedResult[],
): RankedResult[] {
  if (results.length === 0 || sourceChunkResults.length === 0) {
    return results;
  }

  const chunkMatchByPath = new Map<string, AtlasSourceChunkRecord>();
  for (const result of sourceChunkResults) {
    if (result.matchedChunk && !chunkMatchByPath.has(result.file_path)) {
      chunkMatchByPath.set(result.file_path, result.matchedChunk);
    }
  }

  return results.map((result) => {
    const matchedChunk = result.matchedChunk ?? chunkMatchByPath.get(result.file_path);
    if (!matchedChunk) {
      return result;
    }
    return {
      ...result,
      source: 'vector',
      matchedChunk,
    };
  });
}

function summarizeMatchPreview(content: string): string {
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) {
    return '';
  }
  return firstLine.length <= 100 ? firstLine : `${firstLine.slice(0, 97)}...`;
}

function formatResult(result: RankedResult): string {
  const summary = result.record.purpose || result.record.blurb || '(no summary)';
  const lines = [`${result.record.file_path} — ${summary}`];

  if (result.matchedChunk) {
    const label = result.matchedChunk.label?.trim();
    const kind = result.matchedChunk.kind === 'highlight' ? 'highlight' : 'source';
    const preview = summarizeMatchPreview(result.matchedChunk.content);
    lines.push(
      `  match: ${kind}${label ? ` (${label})` : ''} lines ${result.matchedChunk.startLine}-${result.matchedChunk.endLine}`
      + `${preview ? ` — ${preview}` : ''}`,
    );
  }

  return lines.join('\n');
}

function formatResultWithWorkspace(result: RankedResult, ws: string, showWorkspace: boolean): string {
  const text = formatResult(result);
  if (!showWorkspace) {
    return text;
  }

  const [firstLine, ...rest] = text.split('\n');
  return [`[${ws}] ${firstLine}`, ...rest].join('\n');
}

// Primary path: BM25 full-text search via FTS5.
// No API key required — search quality improves organically as agents
// populate metadata via atlas_commit.
async function searchOneWorkspace(
  runtime: AtlasRuntime,
  db: AtlasDatabase,
  ws: string,
  query: string,
  limit: number,
): Promise<RankedResult[]> {
  const candidateLimit = Math.max(limit * 3, 20);
  const bm25Results = mapHitsToRanked(searchFts(db, ws, query, candidateLimit));

  let vectorResults: RankedResult[] = [];
  let sourceChunkResults: RankedResult[] = [];
  try {
    const embedding = await embedAtlasQueryText(query, runtime.config);
    vectorResults = mapHitsToRanked(searchVector(db, ws, embedding, candidateLimit));
    sourceChunkResults = mapSourceChunkHitsToRanked(
      db,
      ws,
      searchSourceChunks(db, ws, embedding, candidateLimit),
    );
  } catch {
    vectorResults = [];
    sourceChunkResults = [];
  }

  const fusedVectorResults = fuseVectorResults(vectorResults, sourceChunkResults);
  const fused = attachChunkMatches(
    fuseReciprocalRankResults(
    toFusionResults(bm25Results),
    toFusionResults(fusedVectorResults),
  ).slice(0, limit).map((result) => result.item),
    sourceChunkResults,
  );

  if (fused.length > 0) {
    return fused;
  }
  // Fallback: LIKE-based search when FTS index has no matches
  return searchAtlasFiles(db, ws, query, limit).map((record, index) => ({
    file_path: record.file_path,
    score: 1 / (index + 1),
    record,
    source: 'fallback' as const,
  }));
}

export interface AtlasSearchArgs {
  query: string;
  limit?: number;
  workspace?: string;
  workspaces?: string[];
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runSearchTool(runtime: AtlasRuntime, { query, limit, workspace, workspaces }: AtlasSearchArgs): Promise<AtlasToolTextResult> {
  const maxResults = limit ?? 5;

  // ── Cross-workspace mode ──
  if (workspaces?.length) {
    const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
    if (allDbs.length === 0) {
      return { content: [{ type: 'text', text: 'No atlas databases found on this machine.' }] };
    }

    const targetDbs = allDbs.filter((d) => workspaces.includes(d.workspace));
    if (targetDbs.length === 0) {
      const available = allDbs.map((d) => d.workspace).join(', ');
      return { content: [{ type: 'text', text: `No matching workspaces. Available: ${available}` }] };
    }

    const perDbLimit = Math.max(maxResults, 10);
    const allResults: Array<RankedResult & { workspace: string }> = [];

    for (const bdb of targetDbs) {
      const results = await searchOneWorkspace(runtime, bdb.db, bdb.workspace, query, perDbLimit);
      for (const r of results) {
        allResults.push({ ...r, workspace: bdb.workspace });
      }
    }

    // Cross-workspace RRF fusion
    const fused = new Map<string, { score: number; result: RankedResult; workspace: string }>();
    allResults.forEach((r, index) => {
      const key = `${r.workspace}:${r.file_path}`;
      const existing = fused.get(key);
      const addedScore = 1 / (60 + index + 1);
      if (existing) {
        existing.score += addedScore;
      } else {
        fused.set(key, { score: r.score + addedScore, result: r, workspace: r.workspace });
      }
    });

    const sorted = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, maxResults);
    if (sorted.length === 0) {
      return { content: [{ type: 'text', text: `No results for "${query}" across workspaces: ${workspaces.join(', ')}` }] };
    }

    const header = `Atlas search: "${query}" (${sorted.length} results across ${targetDbs.length} workspaces)\n`;
    const lines = sorted.map((s) => formatResultWithWorkspace(s.result, s.workspace, true));
    return { content: [{ type: 'text', text: header + '\n' + lines.join('\n\n') }] };
  }

  // ── Single-workspace mode ──
  const resolved = resolveWorkspaceDb(runtime, workspace);
  if ('error' in resolved) {
    return { content: [{ type: 'text' as const, text: resolved.error }] };
  }
  const { db: resolvedDb, workspace: activeWorkspace } = resolved;
  const results = await searchOneWorkspace(runtime, resolvedDb, activeWorkspace, query, maxResults);

  const sliced = results.slice(0, maxResults);
  trackQuery(
    query,
    sliced.map((row) => row.record.id),
    sliced.map((row) => row.record.file_path),
  );
  return {
    content: [{
      type: 'text',
      text: sliced.length === 0
        ? `No atlas results for "${query}".`
        : sliced.map(formatResult).join('\n\n'),
    }],
  };
}

export function registerSearchTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_search',
    'Search the codebase atlas using natural language. Uses BM25 full-text search over file purposes, patterns, and descriptions, plus vector fusion over both file metadata and source-highlight/raw-source chunks when embeddings are available. The index grows organically as agents fill in metadata via atlas_commit. Best for: "where does X happen?", "which files handle Y?", "find code related to Z". Supports cross-workspace search. No API key required.',
    {
      query: z.string().min(1),
      limit: z.coerce.number().int().min(1).max(30).optional(),
      workspace: z.string().optional().describe('Single workspace to search (defaults to current)'),
      workspaces: z.array(z.string()).optional().describe('Search across multiple workspaces. Overrides workspace param. Omit to search current workspace only.'),
    },
    async (args: AtlasSearchArgs) => runSearchTool(runtime, args),
  );
}
