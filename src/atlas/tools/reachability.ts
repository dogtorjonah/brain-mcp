import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listAtlasFiles, listImportEdges } from '../db.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { resolveWorkspaceDb } from './bridge.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

type ReachabilityMode = 'dead_exports' | 'dead_files' | 'path_query' | 'entrypoints';

interface EntryPointBuckets {
  noImporters: string[];
  routeFiles: string[];
  pageFiles: string[];
  layoutFiles: string[];
  rootIndexFiles: string[];
  otherPatternFiles: string[];
}

interface ReachabilityGraph {
  adjacency: Map<string, string[]>;
  reverseAdjacency: Map<string, string[]>;
  nodes: Set<string>;
}

interface ReachabilityContext {
  ws: string;
  graph: ReachabilityGraph;
  filesByPath: Map<string, AtlasFileRecord>;
  entrypointBuckets: EntryPointBuckets;
  entrypoints: string[];
  reachable: Set<string>;
}

const ROUTE_PATTERN = /(?:^|\/)app\/(?:.*\/)?api\/.+\/route\.[jt]sx?$/;
const PAGE_PATTERN = /(?:^|\/)app\/(?:.*\/)?page\.[jt]sx?$/;
const LAYOUT_PATTERN = /(?:^|\/)app\/(?:.*\/)?layout\.[jt]sx?$/;
const APP_ENTRY_PATTERN = /(?:^|\/)(main|server|index|entry|app)\.[cm]?[jt]sx?$/;
const ROOT_INDEX_PATTERN = /^index\.[cm]?[jt]sx?$/;

const CONFIG_BASENAME_PATTERNS = [
  /^next\.config\.[cm]?[jt]s$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^jest\.config\.[cm]?[jt]s$/,
  /^playwright\.config\.[cm]?[jt]s$/,
  /^cypress\.config\.[cm]?[jt]s$/,
  /^eslint\.config\.[cm]?[jt]s$/,
  /^tailwind\.config\.[cm]?[jt]s$/,
  /^postcss\.config\.[cm]?[jt]s$/,
  /^babel\.config\.[cm]?[jt]s$/,
  /^webpack\.config\.[cm]?[jt]s$/,
];

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function isTestOrConfigFile(filePath: string): boolean {
  const normalized = normalizePath(filePath);

  if (
    normalized.includes('/__tests__/')
    || normalized.includes('/__mocks__/')
    || normalized.includes('/test/')
    || normalized.includes('/tests/')
    || normalized.includes('/spec/')
    || normalized.includes('/specs/')
    || normalized.includes('/fixtures/')
  ) {
    return true;
  }

  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(normalized)) {
    return true;
  }

  const base = path.basename(normalized);
  return CONFIG_BASENAME_PATTERNS.some((pattern) => pattern.test(base));
}

function shouldIncludeFile(filePath: string, includeTestFiles: boolean): boolean {
  if (includeTestFiles) {
    return true;
  }
  return !isTestOrConfigFile(filePath);
}

function detectEntrypointBuckets(graph: ReachabilityGraph): EntryPointBuckets {
  const buckets: EntryPointBuckets = {
    noImporters: [],
    routeFiles: [],
    pageFiles: [],
    layoutFiles: [],
    rootIndexFiles: [],
    otherPatternFiles: [],
  };

  for (const file of graph.nodes) {
    const importers = graph.reverseAdjacency.get(file) ?? [];
    if (importers.length === 0) {
      buckets.noImporters.push(file);
    }

    if (ROUTE_PATTERN.test(file)) {
      buckets.routeFiles.push(file);
    } else if (PAGE_PATTERN.test(file)) {
      buckets.pageFiles.push(file);
    } else if (LAYOUT_PATTERN.test(file)) {
      buckets.layoutFiles.push(file);
    } else if (ROOT_INDEX_PATTERN.test(file)) {
      buckets.rootIndexFiles.push(file);
    } else if (APP_ENTRY_PATTERN.test(file)) {
      buckets.otherPatternFiles.push(file);
    }
  }

  for (const values of Object.values(buckets) as string[][]) {
    values.sort((a, b) => a.localeCompare(b));
  }

  return buckets;
}

function combineEntrypoints(buckets: EntryPointBuckets): string[] {
  const entrypoints = new Set<string>();
  for (const values of Object.values(buckets)) {
    for (const file of values) {
      entrypoints.add(file);
    }
  }
  return [...entrypoints].sort((a, b) => a.localeCompare(b));
}

function buildGraph(runtime: AtlasRuntime, workspace: string, includeTestFiles: boolean): ReachabilityGraph {
  const atlasFiles = listAtlasFiles(runtime.db, workspace);
  const importEdges = listImportEdges(runtime.db, workspace);

  const nodes = new Set<string>();
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();

  for (const file of atlasFiles) {
    if (!shouldIncludeFile(file.file_path, includeTestFiles)) {
      continue;
    }
    nodes.add(file.file_path);
    adjacency.set(file.file_path, []);
    reverseAdjacency.set(file.file_path, []);
  }

  for (const edge of importEdges) {
    if (!shouldIncludeFile(edge.source_file, includeTestFiles) || !shouldIncludeFile(edge.target_file, includeTestFiles)) {
      continue;
    }

    if (!nodes.has(edge.source_file)) {
      nodes.add(edge.source_file);
      adjacency.set(edge.source_file, []);
      reverseAdjacency.set(edge.source_file, []);
    }

    if (!nodes.has(edge.target_file)) {
      nodes.add(edge.target_file);
      adjacency.set(edge.target_file, []);
      reverseAdjacency.set(edge.target_file, []);
    }

    adjacency.get(edge.source_file)?.push(edge.target_file);
    reverseAdjacency.get(edge.target_file)?.push(edge.source_file);
  }

  return {
    adjacency,
    reverseAdjacency,
    nodes,
  };
}

function bfsReachable(graph: ReachabilityGraph, roots: string[]): Set<string> {
  const reachable = new Set<string>();
  const queue: string[] = [];

  for (const root of roots) {
    if (!graph.nodes.has(root) || reachable.has(root)) {
      continue;
    }
    reachable.add(root);
    queue.push(root);
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const next of graph.adjacency.get(current) ?? []) {
      if (reachable.has(next)) {
        continue;
      }
      reachable.add(next);
      queue.push(next);
    }
  }

  return reachable;
}

function shortestPath(graph: ReachabilityGraph, from: string, to: string): string[] | null {
  if (from === to) {
    return [from];
  }

  const visited = new Set<string>([from]);
  const queue: string[] = [from];
  const parent = new Map<string, string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const next of graph.adjacency.get(current) ?? []) {
      if (visited.has(next)) {
        continue;
      }

      visited.add(next);
      parent.set(next, current);

      if (next === to) {
        const path: string[] = [to];
        let cursor = to;
        while (parent.has(cursor)) {
          const prev = parent.get(cursor);
          if (!prev) {
            break;
          }
          path.push(prev);
          cursor = prev;
        }
        return path.reverse();
      }

      queue.push(next);
    }
  }

  return null;
}

function formatEntrypointSummary(buckets: EntryPointBuckets): string[] {
  return [
    `- no importers: ${buckets.noImporters.length}`,
    `- route.ts matches: ${buckets.routeFiles.length}`,
    `- page.tsx/ts matches: ${buckets.pageFiles.length}`,
    `- layout.tsx/ts matches: ${buckets.layoutFiles.length}`,
    `- root index files: ${buckets.rootIndexFiles.length}`,
    `- other app entry patterns: ${buckets.otherPatternFiles.length}`,
  ];
}

function formatSampleList(title: string, values: string[], sampleLimit = 20): string[] {
  if (values.length === 0) {
    return [title, '- none'];
  }

  const lines = [title, ...values.slice(0, sampleLimit).map((value) => `- ${value}`)];
  if (values.length > sampleLimit) {
    lines.push(`- ... and ${values.length - sampleLimit} more`);
  }
  return lines;
}

function buildContext(runtime: AtlasRuntime, workspace: string, includeTestFiles: boolean): ReachabilityContext {
  const files = listAtlasFiles(runtime.db, workspace)
    .filter((file) => shouldIncludeFile(file.file_path, includeTestFiles));
  const filesByPath = new Map(files.map((file) => [file.file_path, file]));

  const graph = buildGraph(runtime, workspace, includeTestFiles);
  const entrypointBuckets = detectEntrypointBuckets(graph);
  const entrypoints = combineEntrypoints(entrypointBuckets);
  const reachable = bfsReachable(graph, entrypoints);

  return {
    ws: workspace,
    graph,
    filesByPath,
    entrypointBuckets,
    entrypoints,
    reachable,
  };
}

// Extension groups for dual-artifact detection (TS source + JS compiled output)
const DUAL_ARTIFACT_EXTENSIONS: string[][] = [
  ['.ts', '.js'],
  ['.tsx', '.jsx'],
  ['.mts', '.mjs'],
  ['.cts', '.cjs'],
];

function hasLiveCompanion(filePath: string, ctx: ReachabilityContext): boolean {
  const ext = path.extname(filePath);
  for (const group of DUAL_ARTIFACT_EXTENSIONS) {
    const idx = group.indexOf(ext);
    if (idx === -1) continue;
    const base = filePath.slice(0, -ext.length);
    for (let i = 0; i < group.length; i++) {
      if (i === idx) continue;
      const companion = base + group[i];
      if (!ctx.graph.nodes.has(companion)) continue;
      // Suppress if companion is reachable OR has any importers
      if (ctx.reachable.has(companion)) return true;
      const importers = ctx.graph.reverseAdjacency.get(companion);
      if (importers && importers.length > 0) return true;
    }
  }
  return false;
}

function formatDeadFiles(ctx: ReachabilityContext): string {
  const deadFiles = [...ctx.graph.nodes]
    .filter((file) => !ctx.reachable.has(file))
    // Suppress false positives: if a JS/TS companion is reachable or has importers, this file isn't truly dead
    .filter((file) => !hasLiveCompanion(file, ctx))
    .sort((a, b) => a.localeCompare(b));

  const lines: string[] = [];
  lines.push('## Dead File Analysis');
  lines.push('');
  lines.push(`Workspace: ${ctx.ws}`);
  lines.push(`Entrypoints detected: ${ctx.entrypoints.length}`);
  lines.push(...formatEntrypointSummary(ctx.entrypointBuckets));
  lines.push('');
  lines.push(`Unreachable files: ${deadFiles.length}`);

  for (const filePath of deadFiles.slice(0, 100)) {
    const importerCount = ctx.graph.reverseAdjacency.get(filePath)?.length ?? 0;
    const file = ctx.filesByPath.get(filePath);
    const extracted = file?.last_extracted ?? 'never';
    lines.push(`- ${filePath}`);
    lines.push(`  Confidence: HIGH | Evidence: ${importerCount} import_edges target this file | last_extracted=${extracted}`);
  }

  if (deadFiles.length > 100) {
    lines.push(`- ... and ${deadFiles.length - 100} more unreachable files`);
  }

  lines.push('');
  lines.push('### Summary');
  lines.push(`- total files: ${ctx.graph.nodes.size}`);
  lines.push(`- reachable: ${ctx.reachable.size}`);
  lines.push(`- unreachable: ${deadFiles.length}`);
  const reachablePct = ctx.graph.nodes.size > 0
    ? ((ctx.reachable.size / ctx.graph.nodes.size) * 100).toFixed(1)
    : '0.0';
  lines.push(`- reachability: ${reachablePct}%`);

  return lines.join('\n');
}

function formatDeadExports(ctx: ReachabilityContext): string {
  const deadExports: Array<{ filePath: string; symbol: string; reason: string }> = [];

  const reachableFiles = [...ctx.reachable].sort((a, b) => a.localeCompare(b));
  for (const filePath of reachableFiles) {
    const file = ctx.filesByPath.get(filePath);
    if (!file || !file.exports || file.exports.length === 0) {
      continue;
    }

    const symbols = file.cross_refs?.symbols ?? {};
    for (const exp of file.exports) {
      const symbol = symbols[exp.name];
      const reachableConsumers = symbol?.call_sites?.filter((site) => ctx.reachable.has(site.file)) ?? [];
      const usageCount = reachableConsumers.reduce((sum, site) => sum + site.count, 0);

      if (usageCount > 0) {
        continue;
      }

      let reason = 'no cross_ref consumers';
      if (!symbol) {
        reason = 'symbol missing from cross_refs';
      } else if ((symbol.call_sites?.length ?? 0) > 0) {
        reason = 'consumers exist only in unreachable files';
      }

      deadExports.push({
        filePath,
        symbol: exp.name,
        reason,
      });
    }
  }

  const lines: string[] = [];
  lines.push('## Dead Export Analysis');
  lines.push('');
  lines.push(`Workspace: ${ctx.ws}`);
  lines.push(`Entrypoints detected: ${ctx.entrypoints.length}`);
  lines.push(`Reachable files scanned: ${ctx.reachable.size}`);
  lines.push(`Dead exports: ${deadExports.length}`);
  lines.push('');

  for (const row of deadExports.slice(0, 150)) {
    lines.push(`- ${row.filePath} :: ${row.symbol}`);
    lines.push(`  Confidence: MEDIUM-HIGH | Evidence: ${row.reason}`);
  }

  if (deadExports.length > 150) {
    lines.push(`- ... and ${deadExports.length - 150} more dead exports`);
  }

  lines.push('');
  lines.push('### Notes');
  lines.push('- Dynamic dispatch and framework reflection can create false positives.');
  lines.push('- Treat this output as likely dead exports unless additional runtime wiring proves usage.');

  return lines.join('\n');
}

function formatEntrypoints(ctx: ReachabilityContext): string {
  const lines: string[] = [];
  lines.push('## Entrypoint Detection');
  lines.push('');
  lines.push(`Workspace: ${ctx.ws}`);
  lines.push(`Total entrypoints: ${ctx.entrypoints.length}`);
  lines.push('');

  lines.push(...formatSampleList('### No-importer entrypoints', ctx.entrypointBuckets.noImporters));
  lines.push('');
  lines.push(...formatSampleList('### Next.js API routes', ctx.entrypointBuckets.routeFiles));
  lines.push('');
  lines.push(...formatSampleList('### Next.js pages', ctx.entrypointBuckets.pageFiles));
  lines.push('');
  lines.push(...formatSampleList('### Next.js layouts', ctx.entrypointBuckets.layoutFiles));
  lines.push('');
  lines.push(...formatSampleList('### Root index files', ctx.entrypointBuckets.rootIndexFiles));

  return lines.join('\n');
}

function formatPathQuery(ctx: ReachabilityContext, from: string, to: string): string {
  if (!ctx.graph.nodes.has(from)) {
    return `Source file not found in graph: ${from}`;
  }
  if (!ctx.graph.nodes.has(to)) {
    return `Target file not found in graph: ${to}`;
  }

  const pathResult = shortestPath(ctx.graph, from, to);
  if (!pathResult) {
    return [
      '## Path Query',
      '',
      `Workspace: ${ctx.ws}`,
      `From: ${from}`,
      `To: ${to}`,
      '',
      'No path exists via import_edges.',
    ].join('\n');
  }

  const hops = Math.max(pathResult.length - 1, 0);
  return [
    '## Path Query',
    '',
    `Workspace: ${ctx.ws}`,
    `From: ${from}`,
    `To: ${to}`,
    `Shortest path length: ${hops} hop${hops === 1 ? '' : 's'}`,
    '',
    ...pathResult.map((file, index) => `${index + 1}. ${file}`),
  ].join('\n');
}

export function registerReachabilityTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_reachability',
    'Analyze import graph reachability. Modes: "dead_files" finds unreachable files (deletion candidates), "dead_exports" finds exports with zero consumers, "entrypoints" finds graph roots with no importers, "path_query" finds shortest import path between two files. Best for: "is this dead code?", "how does A reach B?"',
    {
      mode: z.enum(['dead_exports', 'dead_files', 'path_query', 'entrypoints']),
      from: z.string().optional(),
      to: z.string().optional(),
      workspace: z.string().optional(),
      includeTestFiles: coercedOptionalBoolean,
    },
    async ({
      mode,
      from,
      to,
      workspace,
      includeTestFiles,
    }: {
      mode: ReachabilityMode;
      from?: string;
      to?: string;
      workspace?: string;
      includeTestFiles?: boolean;
    }) => {
      const resolved = resolveWorkspaceDb(runtime, workspace);
      if ('error' in resolved) {
        return { content: [{ type: 'text' as const, text: resolved.error }] };
      }
      const ws = resolved.workspace;
      const effectiveRuntime = resolved.db === runtime.db ? runtime : { ...runtime, db: resolved.db };
      const includeTests = includeTestFiles ?? false;
      const ctx = buildContext(effectiveRuntime, ws, includeTests);

      if (mode === 'path_query') {
        if (!from || !to) {
          return {
            content: [{
              type: 'text',
              text: 'atlas_reachability(path_query) requires both "from" and "to".',
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: formatPathQuery(ctx, from, to),
          }],
        };
      }

      if (mode === 'entrypoints') {
        return {
          content: [{
            type: 'text',
            text: formatEntrypoints(ctx),
          }],
        };
      }

      if (mode === 'dead_exports') {
        return {
          content: [{
            type: 'text',
            text: formatDeadExports(ctx),
          }],
        };
      }

      return {
        content: [{
          type: 'text',
          text: formatDeadFiles(ctx),
        }],
      };
    },
  );
}
