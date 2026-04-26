import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase, AtlasReferenceRecord } from '../db.js';
import { getAtlasFile, listAtlasFiles, listImportEdges, listReferences } from '../db.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface GraphNode {
  id: string;
  file_path?: string;
  cluster?: string | null;
  purpose?: string;
  loc?: number;
  center?: boolean;
  distance?: number;
  file_count?: number;
}

interface GraphEdge {
  from: string;
  to: string;
  edge_kind?: 'import' | 'reference';
  edge_type?: string;
  weight?: number;
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

function normalizeEdgeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_') || 'unknown';
}

function resolveFormat(format?: string): OutputFormat {
  return format === 'json' ? 'json' : 'text';
}

function formatOutput(format: OutputFormat, payload: Record<string, unknown>, text: string): string {
  return format === 'json' ? JSON.stringify(payload, null, 2) : text;
}

export function registerGraphTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_graph',
    'Visualize the import graph around a file or show cluster-level connectivity. When given a center file, performs BFS traversal showing nodes and edges at configurable depth. Without a center file, shows a cluster summary with inter-cluster edge counts. Best for: understanding architecture, seeing how modules connect, finding isolated or overly-connected areas.',
    {
      file_path: z.string().optional(),
      filePath: z.string().optional(),
      workspace: z.string().optional(),
      depth: z.coerce.number().int().min(0).max(5).optional(),
      direction: z.enum(['imports', 'importers', 'both']).optional(),
      include_references: coercedOptionalBoolean,
      includeReferences: coercedOptionalBoolean,
      edge_types: z.array(z.string().min(1)).optional(),
      edgeTypes: z.array(z.string().min(1)).optional(),
      max_nodes: z.coerce.number().int().min(1).max(500).optional(),
      maxNodes: z.coerce.number().int().min(1).max(500).optional(),
      max_edges: z.coerce.number().int().min(1).max(1000).optional(),
      maxEdges: z.coerce.number().int().min(1).max(1000).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      file_path,
      filePath,
      workspace,
      depth,
      direction,
      include_references,
      includeReferences,
      edge_types,
      edgeTypes,
      max_nodes,
      maxNodes,
      max_edges,
      maxEdges,
      format,
    }: {
      file_path?: string;
      filePath?: string;
      workspace?: string;
      depth?: number;
      direction?: 'imports' | 'importers' | 'both';
      include_references?: boolean;
      includeReferences?: boolean;
      edge_types?: string[];
      edgeTypes?: string[];
      max_nodes?: number;
      maxNodes?: number;
      max_edges?: number;
      maxEdges?: number;
      format?: 'json' | 'text';
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
      }

      const ws = context.workspace;
      const db = context.db;
      const out = resolveFormat(format);
      const centerFile = file_path ?? filePath;
      const maxDepth = Math.max(0, Math.min(5, Math.floor(depth ?? 2)));
      const dir = direction ?? 'both';
      const withReferences = include_references ?? includeReferences ?? false;
      const edgeTypeFilter = new Set((edge_types ?? edgeTypes ?? []).map(normalizeEdgeType));
      const maxNodeCount = Math.max(50, Math.min(500, Math.floor(max_nodes ?? maxNodes ?? 200)));
      const maxEdgeCount = Math.max(100, Math.min(1000, Math.floor(max_edges ?? maxEdges ?? 400)));

      const rows = listAtlasFiles(db, ws);
      const rowByPath = new Map(rows.map((row) => [normalizePath(row.file_path), row]));

      if (!centerFile) {
        const clusterByPath = new Map<string, string>();
        for (const row of rows) clusterByPath.set(normalizePath(row.file_path), row.cluster ?? 'uncategorized');

        const nodeCounts = new Map<string, number>();
        for (const cluster of clusterByPath.values()) nodeCounts.set(cluster, (nodeCounts.get(cluster) ?? 0) + 1);

        const edgeCounts = new Map<string, number>();
        for (const edge of listImportEdges(db, ws)) {
          const fromCluster = clusterByPath.get(normalizePath(edge.source_file));
          const toCluster = clusterByPath.get(normalizePath(edge.target_file));
          if (!fromCluster || !toCluster) continue;
          const key = `${fromCluster}=>${toCluster}`;
          edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
        }

        const totalFileCount = rows.length;
        const uncategorizedFileCount = nodeCounts.get('uncategorized') ?? 0;
        const totalClusterEdgeWeight = [...edgeCounts.values()].reduce((sum, weight) => sum + weight, 0);

        const clusterEdgeTotals = new Map<string, number>();
        for (const [key, weight] of edgeCounts.entries()) {
          const [from, to] = key.split('=>');
          if (!from || !to) continue;
          clusterEdgeTotals.set(from, (clusterEdgeTotals.get(from) ?? 0) + weight);
          clusterEdgeTotals.set(to, (clusterEdgeTotals.get(to) ?? 0) + weight);
        }

        const nodes: GraphNode[] = [...nodeCounts.entries()].map(([cluster, file_count]) => ({ id: cluster, cluster, file_count }));
        nodes.sort((a, b) => {
          const aUncategorized = (a.id ?? '') === 'uncategorized';
          const bUncategorized = (b.id ?? '') === 'uncategorized';
          if (aUncategorized !== bUncategorized) return aUncategorized ? 1 : -1;

          const aEdgeScore = clusterEdgeTotals.get(a.id) ?? 0;
          const bEdgeScore = clusterEdgeTotals.get(b.id) ?? 0;
          if (bEdgeScore !== aEdgeScore) return bEdgeScore - aEdgeScore;

          const aFileCount = a.file_count ?? 0;
          const bFileCount = b.file_count ?? 0;
          if (bFileCount !== aFileCount) return bFileCount - aFileCount;
          return a.id.localeCompare(b.id);
        });

        const edges: GraphEdge[] = [];
        for (const [key, weight] of edgeCounts.entries()) {
          const [from, to] = key.split('=>');
          if (!from || !to) continue;
          edges.push({ from, to, weight });
        }

        edges.sort((a, b) => {
          const aUncategorized = a.from === 'uncategorized' || a.to === 'uncategorized';
          const bUncategorized = b.from === 'uncategorized' || b.to === 'uncategorized';
          if (aUncategorized !== bUncategorized) return aUncategorized ? 1 : -1;
          return (b.weight ?? 0) - (a.weight ?? 0) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
        });

        const uncategorizedDominates = totalFileCount > 0 && uncategorizedFileCount / totalFileCount >= 0.5;
        if (edges.length > maxEdgeCount) edges.length = maxEdgeCount;

        const clusterLines = nodes.map((node) => {
          const edgeScore = clusterEdgeTotals.get(node.id) ?? 0;
          return `- ${node.id}: ${node.file_count ?? 0} files, ${edgeScore} incident edges`;
        });

        const categorizedEdges = edges.filter((edge) => edge.from !== 'uncategorized' && edge.to !== 'uncategorized');
        const uncategorizedEdges = edges.filter((edge) => edge.from === 'uncategorized' || edge.to === 'uncategorized');

        const text = [
          '## Atlas Graph',
          '',
          `Cluster summary for ${ws}`,
          `${totalFileCount} files, ${nodes.length} clusters, ${totalClusterEdgeWeight} total edges`,
          '',
          'Clusters (sorted by connectivity):',
          ...clusterLines,
          '',
          'Inter-cluster edges:',
          ...categorizedEdges.map((edge) => `- ${edge.from} -> ${edge.to} (${edge.weight} edges)`),
          ...(uncategorizedEdges.length > 0
            ? [
                '',
                `Uncategorized edges (de-emphasized): ${uncategorizedEdges.length}`,
                ...uncategorizedEdges.map((edge) => `- ${edge.from} -> ${edge.to} (${edge.weight} edges)`),
              ]
            : []),
          ...(uncategorizedDominates
            ? [
                '',
                'Most files are uncategorized. Run `atlas_admin action=reindex phase=cluster` to compute community clusters.',
              ]
            : []),
        ].join('\n');

        const payload = {
          ok: true,
          workspace: ws,
          mode: 'cluster_summary',
          nodes,
          edges,
          summary: {
            file_count: totalFileCount,
            cluster_count: nodes.length,
            edge_count: edges.length,
            total_edge_weight: totalClusterEdgeWeight,
            uncategorized_file_count: uncategorizedFileCount,
            uncategorized_edge_count: uncategorizedEdges.length,
            uncategorized_dominates: uncategorizedDominates,
          },
        };
        return { content: [{ type: 'text', text: formatOutput(out, payload, text) }] };
      }

      const root = normalizePath(centerFile);
      if (!getAtlasFile(db, ws, root)) {
        const text = `No atlas entry for "${centerFile}" in workspace "${ws}".`;
        return { content: [{ type: 'text', text: formatOutput(out, { ok: false, workspace: ws, file_path: centerFile, message: text }, text) }] };
      }

      const outgoing = new Map<string, string[]>();
      const incoming = new Map<string, string[]>();
      for (const path of rowByPath.keys()) {
        outgoing.set(path, []);
        incoming.set(path, []);
      }
      for (const edge of listImportEdges(db, ws)) {
        const src = normalizePath(edge.source_file);
        const dst = normalizePath(edge.target_file);
        if (!rowByPath.has(src) || !rowByPath.has(dst)) continue;
        outgoing.get(src)?.push(dst);
        incoming.get(dst)?.push(src);
      }

      const references = withReferences ? listReferences(db, ws) : [];
      const refsByPath = new Map<string, AtlasReferenceRecord[]>();
      if (withReferences) {
        for (const ref of references) {
          const src = normalizePath(ref.source_file);
          const dst = normalizePath(ref.target_file);
          const srcBucket = refsByPath.get(src) ?? [];
          srcBucket.push(ref);
          refsByPath.set(src, srcBucket);
          if (dst !== src) {
            const dstBucket = refsByPath.get(dst) ?? [];
            dstBucket.push(ref);
            refsByPath.set(dst, dstBucket);
          }
        }
      }

      const nodes = new Map<string, GraphNode>();
      const edges: GraphEdge[] = [];
      const seenEdges = new Set<string>();
      let truncated = false;

      const rootRow = rowByPath.get(root);
      nodes.set(root, {
        id: root,
        file_path: root,
        cluster: rootRow?.cluster ?? null,
        purpose: rootRow?.purpose || rootRow?.blurb || '',
        loc: rootRow?.loc ?? 0,
        center: true,
        distance: 0,
      });

      const queue: Array<{ path: string; hops: number }> = [{ path: root, hops: 0 }];

      while (queue.length > 0 && !truncated) {
        const current = queue.shift();
        if (!current) continue;
        if (current.hops >= maxDepth) continue;

        const nextEdges: GraphEdge[] = [];
        if (dir === 'imports' || dir === 'both') {
          for (const target of outgoing.get(current.path) ?? []) {
            nextEdges.push({ from: current.path, to: target, edge_kind: 'import', edge_type: 'import', weight: 1 });
          }
        }
        if (dir === 'importers' || dir === 'both') {
          for (const source of incoming.get(current.path) ?? []) {
            nextEdges.push({ from: source, to: current.path, edge_kind: 'import', edge_type: 'import', weight: 1 });
          }
        }
        if (withReferences) {
          for (const ref of refsByPath.get(current.path) ?? []) {
            const src = normalizePath(ref.source_file);
            const dst = normalizePath(ref.target_file);
            const edgeType = normalizeEdgeType(ref.edge_type);
            if (edgeTypeFilter.size > 0 && !edgeTypeFilter.has(edgeType)) continue;
            nextEdges.push({ from: src, to: dst, edge_kind: 'reference', edge_type: edgeType, weight: Number(ref.usage_count ?? 1) });
          }
        }

        for (const edge of nextEdges) {
          if (!rowByPath.has(edge.from) || !rowByPath.has(edge.to)) continue;
          const key = `${edge.edge_kind}:${edge.edge_type}:${edge.from}=>${edge.to}`;
          if (seenEdges.has(key)) continue;
          seenEdges.add(key);
          edges.push(edge);

          if (edges.length >= maxEdgeCount) {
            truncated = true;
            break;
          }

          for (const candidate of [edge.from, edge.to]) {
            if (!nodes.has(candidate)) {
              if (nodes.size >= maxNodeCount) {
                truncated = true;
                break;
              }
              const row = rowByPath.get(candidate);
              nodes.set(candidate, {
                id: candidate,
                file_path: candidate,
                cluster: row?.cluster ?? null,
                purpose: row?.purpose || row?.blurb || '',
                loc: row?.loc ?? 0,
                center: candidate === root,
                distance: current.hops + 1,
              });
              queue.push({ path: candidate, hops: current.hops + 1 });
            }
          }

          if (truncated) break;
        }
      }

      const text = [
        '## Atlas Graph',
        '',
        `Center: ${root} | depth ${maxDepth} | direction ${dir}`,
        ...edges.map((edge) => `- ${edge.from} --${edge.edge_kind}:${edge.edge_type}--> ${edge.to}`),
        ...(truncated ? [`- Note: graph truncated (max_nodes=${maxNodeCount}, max_edges=${maxEdgeCount})`] : []),
      ].join('\n');

      const payload = {
        ok: true,
        workspace: ws,
        mode: 'graph',
        file_path: root,
        depth: maxDepth,
        direction: dir,
        include_references: withReferences,
        nodes: [...nodes.values()],
        edges,
        summary: {
          node_count: nodes.size,
          edge_count: edges.length,
          truncated,
          max_nodes: maxNodeCount,
          max_edges: maxEdgeCount,
        },
      };
      return { content: [{ type: 'text', text: formatOutput(out, payload, text) }] };
    },
  );
}
