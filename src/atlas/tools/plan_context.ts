import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, listImportEdges, searchFts, searchVector } from '../db.js';
import { embedAtlasQueryText } from '../embeddings.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface RankedSeed {
  file: AtlasFileRecord;
  score: number;
}

interface ContextEntry {
  file_path: string;
  context_source: 'seed' | 'neighbor';
  why_included: string;
  cluster: string | null;
  purpose: string;
  hazards: string[];
  patterns: string[];
  loc: number;
  blast_radius: number;
  score: number;
}
type OutputFormat = 'text' | 'json';

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function resolveFormat(format?: string): OutputFormat {
  return format === 'json' ? 'json' : 'text';
}

function formatOutput(format: OutputFormat, payload: Record<string, unknown>, text: string): string {
  return format === 'json' ? JSON.stringify(payload, null, 2) : text;
}

function fuseSeeds(
  ftsHits: Array<{ file: AtlasFileRecord; score: number }>,
  vectorHits: Array<{ file: AtlasFileRecord; score: number }>,
  limit: number,
): RankedSeed[] {
  const scores = new Map<string, { file: AtlasFileRecord; score: number }>();

  ftsHits.forEach((hit, index) => {
    const key = normalizePath(hit.file.file_path);
    const current = scores.get(key);
    const nextScore = (current?.score ?? 0) + (1 / (60 + index + 1));
    scores.set(key, { file: current?.file ?? hit.file, score: nextScore });
  });

  vectorHits.forEach((hit, index) => {
    const key = normalizePath(hit.file.file_path);
    const current = scores.get(key);
    const nextScore = (current?.score ?? 0) + (1 / (60 + index + 1));
    scores.set(key, { file: current?.file ?? hit.file, score: nextScore });
  });

  return [...scores.values()]
    .sort((a, b) => b.score - a.score || a.file.file_path.localeCompare(b.file.file_path))
    .slice(0, limit);
}

function fallbackSeeds(rows: AtlasFileRecord[], task: string, limit: number): RankedSeed[] {
  const q = task.toLowerCase();
  return rows
    .map((row) => {
      const haystack = [row.file_path, row.purpose, row.blurb, ...(row.patterns ?? []), ...(row.hazards ?? [])]
        .join(' ')
        .toLowerCase();
      const hit = haystack.includes(q) ? 0.6 : 0;
      return { file: row, score: hit };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.file.file_path.localeCompare(b.file.file_path))
    .slice(0, limit);
}

export interface AtlasPlanContextArgs {
  task: string;
  workspace?: string;
  limit?: number;
  include_neighbors?: boolean;
  includeNeighbors?: boolean;
  neighbor_depth?: number;
  neighborDepth?: number;
  format?: 'json' | 'text';
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runPlanContextTool(runtime: AtlasRuntime, {
  task,
  workspace,
  limit,
  include_neighbors,
  includeNeighbors,
  neighbor_depth,
  neighborDepth,
  format,
}: AtlasPlanContextArgs): Promise<AtlasToolTextResult> {
  const context = resolveDbContext(runtime, workspace);
  if (!context) {
    return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
  }

  const ws = context.workspace;
  const db = context.db;
  const out = resolveFormat(format);
  const maxSeeds = Math.max(1, Math.min(50, Math.floor(limit ?? 15)));
  const withNeighbors = include_neighbors ?? includeNeighbors ?? true;
  const depth = Math.max(0, Math.min(2, Math.floor(neighbor_depth ?? neighborDepth ?? 1)));

  const rows = listAtlasFiles(db, ws);
  if (rows.length === 0) {
    const text = `No atlas files found for workspace "${ws}".`;
    return { content: [{ type: 'text', text: formatOutput(out, { ok: false, workspace: ws, message: text }, text) }] };
  }

  const candidateLimit = Math.max(maxSeeds * 3, 20);
  const ftsHits = searchFts(db, ws, task, candidateLimit).map((hit) => ({ file: hit.file, score: hit.score }));
  let vectorHits: Array<{ file: AtlasFileRecord; score: number }> = [];
  try {
    const embedding = await embedAtlasQueryText(task, runtime.config);
    vectorHits = searchVector(db, ws, embedding, candidateLimit).map((hit) => ({
      file: hit.file,
      score: hit.score,
    }));
  } catch {
    vectorHits = [];
  }

  let seeds = fuseSeeds(ftsHits, vectorHits, maxSeeds);
  if (seeds.length === 0) {
    seeds = fallbackSeeds(rows, task, maxSeeds);
  }
  if (seeds.length === 0) {
    const text = `No atlas context found for task "${task}" in workspace "${ws}".`;
    return { content: [{ type: 'text', text: formatOutput(out, { ok: false, workspace: ws, task, seeds: [], context_files: [], message: text }, text) }] };
  }

  const rowByPath = new Map(rows.map((row) => [normalizePath(row.file_path), row]));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const filePath of rowByPath.keys()) {
    outgoing.set(filePath, []);
    incoming.set(filePath, []);
  }

  for (const edge of listImportEdges(db, ws)) {
    const src = normalizePath(edge.source_file);
    const dst = normalizePath(edge.target_file);
    if (!rowByPath.has(src) || !rowByPath.has(dst)) continue;
    outgoing.get(src)?.push(dst);
    incoming.get(dst)?.push(src);
  }

  const blastByPath = new Map<string, number>();
  for (const filePath of rowByPath.keys()) {
    blastByPath.set(filePath, (incoming.get(filePath)?.length ?? 0) + (outgoing.get(filePath)?.length ?? 0));
  }

  const contextEntries = new Map<string, ContextEntry>();
  seeds.forEach((seed, index) => {
    const key = normalizePath(seed.file.file_path);
    contextEntries.set(key, {
      file_path: seed.file.file_path,
      context_source: 'seed',
      why_included: `seed rank ${index + 1} from hybrid search`,
      cluster: seed.file.cluster ?? null,
      purpose: seed.file.purpose || seed.file.blurb || '',
      hazards: seed.file.hazards ?? [],
      patterns: seed.file.patterns ?? [],
      loc: seed.file.loc ?? 0,
      blast_radius: blastByPath.get(key) ?? 0,
      score: seed.score,
    });
  });

  if (withNeighbors && depth > 0) {
    const queue = seeds.map((seed) => ({ path: normalizePath(seed.file.file_path), depth: 0, via: seed.file.file_path }));
    const expanded = new Set(queue.map((entry) => entry.path));

    while (queue.length > 0 && contextEntries.size < 60) {
      const current = queue.shift();
      if (!current || current.depth >= depth) continue;

      const neighbors = [
        ...(outgoing.get(current.path) ?? []).map((path) => ({ path, relation: 'imports' as const })),
        ...(incoming.get(current.path) ?? []).map((path) => ({ path, relation: 'importer' as const })),
      ].slice(0, 50);

      for (const neighbor of neighbors) {
        const row = rowByPath.get(neighbor.path);
        if (!row) continue;

        if (!contextEntries.has(neighbor.path)) {
          contextEntries.set(neighbor.path, {
            file_path: row.file_path,
            context_source: 'neighbor',
            why_included: `${neighbor.relation} of ${current.via}`,
            cluster: row.cluster ?? null,
            purpose: row.purpose || row.blurb || '',
            hazards: row.hazards ?? [],
            patterns: row.patterns ?? [],
            loc: row.loc ?? 0,
            blast_radius: blastByPath.get(neighbor.path) ?? 0,
            score: 0.01,
          });
        }

        if (!expanded.has(neighbor.path)) {
          expanded.add(neighbor.path);
          queue.push({ path: neighbor.path, depth: current.depth + 1, via: row.file_path });
        }

        if (contextEntries.size >= 60) break;
      }
    }
  }

  const orderedContext = [...contextEntries.values()]
    .sort((a, b) => {
      if (a.context_source !== b.context_source) return a.context_source === 'seed' ? -1 : 1;
      return b.score - a.score || a.file_path.localeCompare(b.file_path);
    });

  const text = [
    '## Atlas Plan Context',
    '',
    `Task: ${task}`,
    '',
    `Seeds (${seeds.length}):`,
    ...seeds.map((seed, index) => `${index + 1}. ${seed.file.file_path} (${(seed.score * 100).toFixed(1)}%)`),
    '',
    `Expanded context (${orderedContext.length}):`,
    ...orderedContext.map((entry) => `- ${entry.file_path} [${entry.context_source}] blast=${entry.blast_radius} | ${entry.why_included}${entry.purpose ? `\n  ${entry.purpose}` : ''}`),
  ].join('\n');

  const payload = {
    ok: true,
    workspace: ws,
    task,
    limit: maxSeeds,
    include_neighbors: withNeighbors,
    neighbor_depth: depth,
    seeds: seeds.map((seed) => ({
      file_path: seed.file.file_path,
      score: Number(seed.score.toFixed(6)),
      cluster: seed.file.cluster ?? null,
      purpose: seed.file.purpose || seed.file.blurb || '',
    })),
    context_files: orderedContext,
    summary: {
      seed_count: seeds.length,
      context_count: orderedContext.length,
    },
  };
  return { content: [{ type: 'text', text: formatOutput(out, payload, text) }] };
}

export function registerPlanContextTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_plan_context',
    'Given a task description, find the most relevant files and expand them with neighboring imports to build complete implementation context. Returns seeds (directly relevant files) and expanded context (neighbors with blast radius and why they matter). Best for: planning implementations, understanding what files to read before starting work, building mental models of a feature area.',
    {
      task: z.string().min(1),
      workspace: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(50).optional(),
      include_neighbors: coercedOptionalBoolean,
      includeNeighbors: coercedOptionalBoolean,
      neighbor_depth: z.coerce.number().int().min(0).max(2).optional(),
      neighborDepth: z.coerce.number().int().min(0).max(2).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async (args: AtlasPlanContextArgs) => runPlanContextTool(runtime, args),
  );
}
