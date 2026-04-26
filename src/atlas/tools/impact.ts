import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, listAtlasFiles, listImportedBy } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 8;
const MAX_RESULTS = 50;
const MAX_VISITED_FILES = 2000;

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface TraversalNode {
  filePath: string;
  depth: number;
}

interface ImpactEdge {
  from: string;
  to: string;
  depth: number;
  edgeType: string;
  symbolName: string | null;
  usageCount: number;
}

interface ImpactAggregate {
  filePath: string;
  minDepth: number;
  totalUsages: number;
  impactScore: number;
  edges: ImpactEdge[];
  confidence: number;
  freshness: string;
}

function normalizeEdgeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_') || 'unknown';
}

function clampDepth(depth: number | undefined): number {
  if (!depth || Number.isNaN(depth)) return DEFAULT_DEPTH;
  return Math.max(1, Math.min(depth, MAX_DEPTH));
}

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) {
    return null;
  }
  return { db: target.db, workspace: target.workspace };
}

function computeFreshness(lastExtracted: string | null): string {
  if (!lastExtracted) return 'unknown';
  const parsed = Date.parse(lastExtracted);
  if (Number.isNaN(parsed)) return 'unknown';

  const ageDays = (Date.now() - parsed) / (24 * 60 * 60 * 1000);
  if (ageDays <= 14) return 'fresh';
  if (ageDays <= 45) return 'recent';
  return 'stale';
}

function computeConfidence(file: AtlasFileRecord | undefined): number {
  if (!file) return 0.4;

  let confidence = file.extraction_model && file.extraction_model !== 'scaffold' ? 0.75 : 0.4;
  const freshness = computeFreshness(file.last_extracted);
  if (freshness === 'fresh') confidence += 0.15;
  if (freshness === 'recent') confidence += 0.05;
  if (freshness === 'stale') confidence -= 0.05;

  return Math.max(0.2, Math.min(0.95, confidence));
}

function addImpactEdge(
  aggregate: Map<string, ImpactAggregate>,
  startFilePath: string,
  fileMap: Map<string, AtlasFileRecord>,
  edge: ImpactEdge,
): void {
  if (edge.to === startFilePath) {
    return;
  }

  const scoreWeight = 1 / Math.max(1, edge.depth);
  const current = aggregate.get(edge.to);
  if (!current) {
    const row = fileMap.get(edge.to);
    aggregate.set(edge.to, {
      filePath: edge.to,
      minDepth: edge.depth,
      totalUsages: Math.max(1, edge.usageCount),
      impactScore: Math.max(1, edge.usageCount) * scoreWeight,
      edges: [edge],
      confidence: computeConfidence(row),
      freshness: computeFreshness(row?.last_extracted ?? null),
    });
    return;
  }

  current.minDepth = Math.min(current.minDepth, edge.depth);
  current.totalUsages += Math.max(1, edge.usageCount);
  current.impactScore += Math.max(1, edge.usageCount) * scoreWeight;
  if (current.edges.length < 8) {
    current.edges.push(edge);
  }
}

function listSymbolEdges(
  row: AtlasFileRecord,
  symbolFilter: string | undefined,
  depth: number,
  allowedEdgeTypes: Set<string> | null,
): ImpactEdge[] {
  const symbols = row.cross_refs?.symbols ?? {};
  const entries = Object.entries(symbols);
  const selected = symbolFilter
    ? entries.filter(([name]) => name === symbolFilter)
    : entries;

  const edges: ImpactEdge[] = [];
  for (const [symbolName, info] of selected) {
    for (const site of info.call_sites ?? []) {
      const edgeType = normalizeEdgeType(site.usage_type || 'reference');
      if (allowedEdgeTypes && !allowedEdgeTypes.has(edgeType)) continue;
      edges.push({
        from: row.file_path,
        to: site.file,
        depth,
        edgeType,
        symbolName,
        usageCount: Math.max(1, Number(site.count) || 1),
      });
    }
  }

  return edges;
}

function buildOutput(
  sourceFile: string,
  symbol: string | undefined,
  aggregates: ImpactAggregate[],
  depthLimit: number,
  wasTruncated: boolean,
): string {
  const title = symbol
    ? `## Impact Analysis: ${sourceFile} -> ${symbol}`
    : `## Impact Analysis: ${sourceFile}`;

  const direct = aggregates.filter((entry) => entry.minDepth === 1);
  const transitive = aggregates.filter((entry) => entry.minDepth > 1);

  const formatLine = (entry: ImpactAggregate): string => {
    const topEdge = entry.edges[0];
    const edgeType = topEdge?.edgeType ?? 'import';
    const symbolSegment = topEdge?.symbolName ? `, symbol=${topEdge.symbolName}` : '';
    return `- ${entry.filePath} (${edgeType}${symbolSegment}, ${entry.totalUsages} usages, score=${entry.impactScore.toFixed(2)}, confidence=${entry.confidence.toFixed(2)}, freshness=${entry.freshness})`;
  };

  const lines: string[] = [title, ''];
  lines.push(`### Direct consumers (depth 1) - ${direct.length} files`);
  if (direct.length === 0) {
    lines.push('- None');
  } else {
    lines.push(...direct.map(formatLine));
  }

  if (depthLimit > 1) {
    lines.push('');
    lines.push(`### Transitive consumers (depth 2-${depthLimit}) - ${transitive.length} files`);
    if (transitive.length === 0) {
      lines.push('- None');
    } else {
      lines.push(...transitive.map(formatLine));
    }
  }

  const highRisk = aggregates.filter((entry) => entry.totalUsages > 3).length;
  const testFiles = aggregates.filter((entry) => /(^|\/)__tests__(\/|$)|(^|\/)test(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(entry.filePath)).length;

  lines.push('');
  lines.push('### Summary');
  lines.push(`- Total files affected: ${aggregates.length}`);
  lines.push(`- High-risk files (>3 usages): ${highRisk}`);
  lines.push(`- Test files affected: ${testFiles}`);
  lines.push(`- Depth limit: ${depthLimit}`);
  if (wasTruncated) {
    lines.push(`- Output capped at ${MAX_RESULTS} files (additional affected files omitted).`);
  }

  return lines.join('\n');
}

export function registerImpactTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_impact',
    'Analyze the blast radius of a file or symbol — find all downstream consumers. Uses the import graph and cross-reference data to walk dependents at configurable depth. Returns direct consumers (depth 1) and transitive consumers (depth 2+) with usage scores. Best for: "what breaks if I change X?"',
    {
      filePath: z.string().min(1),
      symbol: z.string().min(1).optional(),
      workspace: z.string().optional(),
      depth: z.coerce.number().int().min(1).max(MAX_DEPTH).optional(),
      edgeTypes: z.array(z.string().min(1)).optional(),
    },
    async ({
      filePath,
      symbol,
      workspace,
      depth,
      edgeTypes,
    }: {
      filePath: string;
      symbol?: string;
      workspace?: string;
      depth?: number;
      edgeTypes?: string[];
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return {
          content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }],
        };
      }

      const ws = context.workspace;
      const db = context.db;
      const maxDepth = clampDepth(depth);
      const allowedEdgeTypes = edgeTypes && edgeTypes.length > 0
        ? new Set(edgeTypes.map(normalizeEdgeType))
        : null;

      const sourceRow = getAtlasFile(db, ws, filePath);
      if (!sourceRow) {
        return {
          content: [{ type: 'text', text: `No atlas row found for ${filePath} in workspace "${ws}".` }],
        };
      }

      if (symbol && !sourceRow.cross_refs?.symbols?.[symbol]) {
        return {
          content: [{ type: 'text', text: `Symbol "${symbol}" was not found in cross_refs for ${filePath}.` }],
        };
      }

      const allRows = listAtlasFiles(db, ws);
      const fileMap = new Map(allRows.map((row) => [row.file_path, row]));

      const queue: TraversalNode[] = [{ filePath, depth: 0 }];
      const seenDepth = new Map<string, number>([[filePath, 0]]);
      const seenEdge = new Set<string>();
      const aggregate = new Map<string, ImpactAggregate>();

      let processed = 0;
      while (queue.length > 0 && processed < MAX_VISITED_FILES) {
        const node = queue.shift();
        if (!node) break;
        processed += 1;

        if (node.depth >= maxDepth) {
          continue;
        }

        const nextDepth = node.depth + 1;
        const currentRow = fileMap.get(node.filePath);

        const edges: ImpactEdge[] = [];

        if (node.filePath === filePath && currentRow) {
          edges.push(...listSymbolEdges(currentRow, symbol, nextDepth, allowedEdgeTypes));
        }

        const importEdgeType = 'import';
        if (!allowedEdgeTypes || allowedEdgeTypes.has(importEdgeType)) {
          const importConsumers = listImportedBy(db, ws, node.filePath);
          for (const consumer of importConsumers) {
            edges.push({
              from: node.filePath,
              to: consumer,
              depth: nextDepth,
              edgeType: importEdgeType,
              symbolName: null,
              usageCount: 1,
            });
          }
        }

        for (const edge of edges) {
          const edgeKey = `${edge.from}|${edge.to}|${edge.depth}|${edge.edgeType}|${edge.symbolName ?? ''}`;
          if (seenEdge.has(edgeKey)) continue;
          seenEdge.add(edgeKey);

          addImpactEdge(aggregate, filePath, fileMap, edge);

          const knownDepth = seenDepth.get(edge.to);
          if (knownDepth !== undefined && knownDepth <= nextDepth) {
            continue;
          }

          seenDepth.set(edge.to, nextDepth);
          if (nextDepth < maxDepth) {
            queue.push({ filePath: edge.to, depth: nextDepth });
          }
        }
      }

      const sorted = [...aggregate.values()]
        .sort((left, right) => {
          if (right.impactScore !== left.impactScore) {
            return right.impactScore - left.impactScore;
          }
          if (right.totalUsages !== left.totalUsages) {
            return right.totalUsages - left.totalUsages;
          }
          return left.filePath.localeCompare(right.filePath);
        });

      const truncated = sorted.length > MAX_RESULTS;
      const displayed = sorted.slice(0, MAX_RESULTS);

      return {
        content: [{
          type: 'text',
          text: buildOutput(filePath, symbol, displayed, maxDepth, truncated),
        }],
      };
    },
  );
}
