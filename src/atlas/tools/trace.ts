import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase, AtlasReferenceRecord } from '../db.js';
import { listAtlasFiles, listImportEdges, listReferences } from '../db.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

const DEFAULT_MAX_HOPS = 8;
const MAX_HOPS = 20;
type OutputFormat = 'json' | 'text';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface TraceEdge {
  from: string;
  to: string;
  edge_kind: 'import' | 'reference';
  edge_type: string;
  usage_count?: number;
  confidence?: number;
  weight: number;
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

function normalizeGraphPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function toNormalizedEdgeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_') || 'reference';
}

function referenceWeight(edgeType: string): number {
  switch (toNormalizedEdgeType(edgeType)) {
    case 'reexport':
      return 0.75;
    case 'runtime_call':
      return 1;
    case 'type_ref':
      return 1.25;
    case 'config_ref':
      return 1.5;
    default:
      return 1.1;
  }
}

function renderResult(format: OutputFormat | undefined, payload: unknown, text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

function mapReferenceEdge(row: AtlasReferenceRecord, weighted: boolean): TraceEdge {
  const edgeType = toNormalizedEdgeType(row.edge_type);
  return {
    from: normalizeGraphPath(row.source_file),
    to: normalizeGraphPath(row.target_file),
    edge_kind: 'reference',
    edge_type: edgeType,
    usage_count: Number(row.usage_count ?? 0),
    confidence: Number(row.confidence ?? 0),
    weight: weighted ? referenceWeight(edgeType) : 1,
  };
}

export function registerTraceTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_trace',
    'Trace the shortest import path between two files. Uses BFS over the import graph to find how file A reaches file B. Best for: understanding transitive dependencies, finding why a change in A affects B, planning safe refactors.',
    {
      from: z.string().min(1),
      to: z.string().min(1),
      workspace: z.string().optional(),
      from_symbol: z.string().optional(),
      fromSymbol: z.string().optional(),
      to_symbol: z.string().optional(),
      toSymbol: z.string().optional(),
      include_references: coercedOptionalBoolean,
      includeReferences: coercedOptionalBoolean,
      edge_types: z.array(z.string().min(1)).optional(),
      edgeTypes: z.array(z.string().min(1)).optional(),
      max_hops: z.coerce.number().int().min(1).max(MAX_HOPS).optional(),
      maxHops: z.coerce.number().int().min(1).max(MAX_HOPS).optional(),
      weighted: coercedOptionalBoolean,
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      from,
      to,
      workspace,
      from_symbol,
      fromSymbol,
      to_symbol,
      toSymbol,
      include_references,
      includeReferences,
      edge_types,
      edgeTypes,
      max_hops,
      maxHops,
      weighted,
      format,
    }: {
      from: string;
      to: string;
      workspace?: string;
      from_symbol?: string;
      fromSymbol?: string;
      to_symbol?: string;
      toSymbol?: string;
      include_references?: boolean;
      includeReferences?: boolean;
      edge_types?: string[];
      edgeTypes?: string[];
      max_hops?: number;
      maxHops?: number;
      weighted?: boolean;
      format?: OutputFormat;
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return renderResult(format, { ok: false, error: `Workspace "${workspace}" not found.` }, `Workspace "${workspace}" not found.`);
      }

      const ws = context.workspace;
      const db = context.db;
      const fromPath = normalizeGraphPath(from.trim());
      const toPath = normalizeGraphPath(to.trim());
      const useWeighted = Boolean(weighted);
      const includeRefs = include_references ?? includeReferences ?? false;
      const requestedEdgeTypes = new Set((edge_types ?? edgeTypes ?? []).map((value) => toNormalizedEdgeType(value)));
      const hopLimit = Math.max(1, Math.min(max_hops ?? maxHops ?? DEFAULT_MAX_HOPS, MAX_HOPS));
      const nodeSet = new Set(listAtlasFiles(db, ws).map((row) => normalizeGraphPath(row.file_path)));

      if (!nodeSet.has(fromPath) || !nodeSet.has(toPath)) {
        return renderResult(format, {
          ok: false,
          workspace: ws,
          from: fromPath,
          to: toPath,
          error: 'Either "from" or "to" is not present in the current workspace graph.',
        }, 'Either "from" or "to" is not present in the current workspace graph.');
      }

      // Build bidirectional adjacency so trace can find paths through
      // shared dependencies (A→C←B becomes A→C→B via reverse edge).
      const adjacency = new Map<string, TraceEdge[]>();
      for (const node of nodeSet) adjacency.set(node, []);
      for (const edge of listImportEdges(db, ws)) {
        const src = normalizeGraphPath(edge.source_file);
        const dst = normalizeGraphPath(edge.target_file);
        if (!nodeSet.has(src) || !nodeSet.has(dst)) continue;
        // Forward: src imports dst
        adjacency.get(src)?.push({ from: src, to: dst, edge_kind: 'import', edge_type: 'import', weight: 1 });
        // Reverse: dst is imported by src (enables traversal through shared deps)
        adjacency.get(dst)?.push({ from: dst, to: src, edge_kind: 'import', edge_type: 'imported_by', weight: 1.5 });
      }

      if (includeRefs) {
        for (const row of listReferences(db, ws)) {
          const edge = mapReferenceEdge(row, useWeighted);
          if (!nodeSet.has(edge.from) || !nodeSet.has(edge.to)) continue;
          if (requestedEdgeTypes.size > 0 && !requestedEdgeTypes.has(edge.edge_type)) continue;
          adjacency.get(edge.from)?.push(edge);
          // Reverse reference edge
          adjacency.get(edge.to)?.push({
            ...edge,
            from: edge.to,
            to: edge.from,
            edge_type: `reverse_${edge.edge_type}`,
            weight: edge.weight * 1.5,
          });
        }
      }

      const parents = new Map<string, { prev: string; edge: TraceEdge }>();
      const pathEdges: TraceEdge[] = [];
      let totalCost = 0;

      if (!useWeighted) {
        const visited = new Set<string>([fromPath]);
        const queue: Array<{ node: string; hops: number }> = [{ node: fromPath, hops: 0 }];
        while (queue.length > 0) {
          const current = queue.shift();
          if (!current) continue;
          if (current.node === toPath) break;
          if (current.hops >= hopLimit) continue;
          for (const edge of adjacency.get(current.node) ?? []) {
            if (visited.has(edge.to)) continue;
            visited.add(edge.to);
            parents.set(edge.to, { prev: current.node, edge });
            queue.push({ node: edge.to, hops: current.hops + 1 });
          }
        }
      } else {
        const dist = new Map<string, number>([[fromPath, 0]]);
        const hopsByNode = new Map<string, number>([[fromPath, 0]]);
        const frontier: Array<{ node: string; cost: number; hops: number }> = [{ node: fromPath, cost: 0, hops: 0 }];
        while (frontier.length > 0) {
          frontier.sort((a, b) => a.cost - b.cost || a.hops - b.hops);
          const current = frontier.shift();
          if (!current) continue;
          if (current.cost > (dist.get(current.node) ?? Number.POSITIVE_INFINITY)) continue;
          if (current.node === toPath) break;
          if (current.hops >= hopLimit) continue;
          for (const edge of adjacency.get(current.node) ?? []) {
            const nextCost = current.cost + edge.weight;
            const nextHops = current.hops + 1;
            if (nextHops > hopLimit) continue;
            const bestCost = dist.get(edge.to);
            const bestHops = hopsByNode.get(edge.to) ?? Number.POSITIVE_INFINITY;
            if (bestCost === undefined || nextCost < bestCost || (nextCost === bestCost && nextHops < bestHops)) {
              dist.set(edge.to, nextCost);
              hopsByNode.set(edge.to, nextHops);
              parents.set(edge.to, { prev: current.node, edge });
              frontier.push({ node: edge.to, cost: nextCost, hops: nextHops });
            }
          }
        }
        totalCost = dist.get(toPath) ?? 0;
      }

      if (!parents.has(toPath) && fromPath !== toPath) {
        return renderResult(format, {
          ok: false,
          workspace: ws,
          from: fromPath,
          to: toPath,
          max_hops: hopLimit,
          weighted: useWeighted,
          error: `No path found from ${fromPath} to ${toPath} within ${hopLimit} hops.`,
        }, `No path found from ${fromPath} to ${toPath} within ${hopLimit} hops.`);
      }

      if (fromPath !== toPath) {
        let cursor = toPath;
        while (cursor !== fromPath) {
          const parent = parents.get(cursor);
          if (!parent) break;
          pathEdges.push(parent.edge);
          cursor = parent.prev;
        }
        pathEdges.reverse();
      }

      if (!useWeighted) totalCost = pathEdges.reduce((sum, edge) => sum + edge.weight, 0);

      const lines: string[] = [
        '## Atlas Trace',
        '',
        `From: ${fromPath}${from_symbol ?? fromSymbol ? `:${from_symbol ?? fromSymbol}` : ''}`,
        `To: ${toPath}${to_symbol ?? toSymbol ? `:${to_symbol ?? toSymbol}` : ''}`,
        `Mode: ${useWeighted ? 'weighted' : 'unweighted'} | hops=${pathEdges.length} | total_cost=${totalCost.toFixed(2)}`,
        '',
      ];
      if (pathEdges.length === 0) {
        lines.push('1. Source and target are the same file.');
      } else {
        lines.push(...pathEdges.map((edge, index) => {
          const details = edge.edge_kind === 'reference'
            ? ` usage=${edge.usage_count ?? 0} conf=${(edge.confidence ?? 0).toFixed(2)}`
            : '';
          return `${index + 1}. ${edge.from} --${edge.edge_kind}:${edge.edge_type}--> ${edge.to}${details}`;
        }));
      }

      return renderResult(format, {
        ok: true,
        workspace: ws,
        from: { file_path: fromPath, symbol: from_symbol ?? fromSymbol ?? null },
        to: { file_path: toPath, symbol: to_symbol ?? toSymbol ?? null },
        weighted: useWeighted,
        include_references: includeRefs,
        max_hops: hopLimit,
        path: pathEdges,
        summary: {
          hop_count: pathEdges.length,
          total_cost: Number(totalCost.toFixed(4)),
        },
      }, lines.join('\n'));
    },
  );
}
