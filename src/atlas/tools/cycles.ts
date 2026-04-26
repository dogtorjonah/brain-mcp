import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, listImportEdges } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

const DEFAULT_MIN_SIZE = 2;
const MAX_MIN_SIZE = 100;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_MAX_NODES = 3000;
const MAX_NODES = 10000;
const DEFAULT_MAX_EDGES = 15000;
const MAX_EDGES = 50000;
type OutputFormat = 'json' | 'text';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
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

function resolveFilePathArg(value: { file_path?: string; filePath?: string }): string {
  return (value.file_path ?? value.filePath ?? '').trim();
}

function normalizeGraphPath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '');
}

function shouldExcludeTestPath(filePath: string, includeTestFiles: boolean): boolean {
  if (includeTestFiles) return false;
  const normalized = normalizeGraphPath(filePath);
  return normalized.includes('/__tests__/')
    || normalized.includes('/tests/')
    || normalized.includes('/test/')
    || normalized.includes('/spec/')
    || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(normalized);
}

function renderResult(format: OutputFormat | undefined, payload: unknown, text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export function registerCyclesTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_cycles',
    'Detect circular dependency cycles using Tarjan\'s strongly connected components algorithm. Finds groups of files that form import loops. Best for: breaking circular dependencies, understanding tangled modules, refactor planning.',
    {
      workspace: z.string().optional(),
      file_path: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      min_size: z.coerce.number().int().min(2).max(MAX_MIN_SIZE).optional(),
      minSize: z.coerce.number().int().min(2).max(MAX_MIN_SIZE).optional(),
      include_test_files: coercedOptionalBoolean,
      includeTestFiles: coercedOptionalBoolean,
      max_nodes: z.coerce.number().int().min(1).max(MAX_NODES).optional(),
      maxNodes: z.coerce.number().int().min(1).max(MAX_NODES).optional(),
      max_edges: z.coerce.number().int().min(1).max(MAX_EDGES).optional(),
      maxEdges: z.coerce.number().int().min(1).max(MAX_EDGES).optional(),
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      workspace,
      file_path,
      filePath,
      min_size,
      minSize,
      include_test_files,
      includeTestFiles: includeTestFilesArg,
      max_nodes,
      maxNodes,
      max_edges,
      maxEdges,
      limit,
      format,
    }: {
      workspace?: string;
      file_path?: string;
      filePath?: string;
      min_size?: number;
      minSize?: number;
      include_test_files?: boolean;
      includeTestFiles?: boolean;
      max_nodes?: number;
      maxNodes?: number;
      max_edges?: number;
      maxEdges?: number;
      limit?: number;
      format?: OutputFormat;
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return renderResult(format, { ok: false, error: `Workspace "${workspace}" not found.` }, `Workspace "${workspace}" not found.`);
      }

      const ws = context.workspace;
      const db = context.db;
      const includeTestFiles = include_test_files ?? includeTestFilesArg ?? false;
      const scopedFile = resolveFilePathArg({ file_path, filePath });
      const minSizeValue = Math.max(2, Math.min(min_size ?? minSize ?? DEFAULT_MIN_SIZE, MAX_MIN_SIZE));
      const maxResults = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const nodeCap = Math.max(1, Math.min(max_nodes ?? maxNodes ?? DEFAULT_MAX_NODES, MAX_NODES));
      const edgeCap = Math.max(1, Math.min(max_edges ?? maxEdges ?? DEFAULT_MAX_EDGES, MAX_EDGES));

      const rows = listAtlasFiles(db, ws).filter((row) => !shouldExcludeTestPath(row.file_path, includeTestFiles));
      const nodeOrder: string[] = [];
      const seenNodes = new Set<string>();
      for (const row of rows) {
        const normalized = normalizeGraphPath(row.file_path);
        if (seenNodes.has(normalized)) continue;
        seenNodes.add(normalized);
        nodeOrder.push(normalized);
      }

      let truncated = false;
      if (nodeOrder.length > nodeCap) {
        nodeOrder.length = nodeCap;
        truncated = true;
      }
      const nodeSet = new Set(nodeOrder);

      const targetNode = scopedFile ? normalizeGraphPath(scopedFile) : null;
      if (targetNode && !nodeSet.has(targetNode)) {
        return renderResult(format, {
          ok: false,
          workspace: ws,
          file_path: scopedFile,
          error: `No atlas entry for "${scopedFile}" in workspace "${ws}" (after filters).`,
        }, `No atlas entry for "${scopedFile}" in workspace "${ws}" (after filters).`);
      }

      const adjacency = new Map<string, string[]>();
      for (const node of nodeOrder) adjacency.set(node, []);
      const edgeSet = new Set<string>();
      for (const edge of listImportEdges(db, ws)) {
        const src = normalizeGraphPath(edge.source_file);
        const dst = normalizeGraphPath(edge.target_file);
        if (!nodeSet.has(src) || !nodeSet.has(dst)) continue;
        const key = `${src}=>${dst}`;
        if (edgeSet.has(key)) continue;
        edgeSet.add(key);
        adjacency.get(src)?.push(dst);
        if (edgeSet.size >= edgeCap) {
          truncated = true;
          break;
        }
      }

      const index = new Map<string, number>();
      const lowLink = new Map<string, number>();
      const stack: string[] = [];
      const onStack = new Set<string>();
      let currentIndex = 0;
      const sccs: string[][] = [];

      const strongConnect = (node: string): void => {
        index.set(node, currentIndex);
        lowLink.set(node, currentIndex);
        currentIndex += 1;
        stack.push(node);
        onStack.add(node);

        for (const neighbor of adjacency.get(node) ?? []) {
          if (!index.has(neighbor)) {
            strongConnect(neighbor);
            lowLink.set(node, Math.min(lowLink.get(node) ?? 0, lowLink.get(neighbor) ?? 0));
          } else if (onStack.has(neighbor)) {
            lowLink.set(node, Math.min(lowLink.get(node) ?? 0, index.get(neighbor) ?? 0));
          }
        }

        if ((lowLink.get(node) ?? -1) === (index.get(node) ?? -2)) {
          const component: string[] = [];
          while (stack.length > 0) {
            const popped = stack.pop();
            if (!popped) break;
            onStack.delete(popped);
            component.push(popped);
            if (popped === node) break;
          }
          sccs.push(component);
        }
      };

      for (const node of nodeOrder) {
        if (!index.has(node)) strongConnect(node);
      }

      const sizeFiltered = sccs.filter((component) => component.length >= minSizeValue);
      const scoped = targetNode ? sizeFiltered.filter((component) => component.includes(targetNode)) : sizeFiltered;
      const cycles = scoped
        .map((component, i) => {
          const componentSet = new Set(component);
          let internalEdgeCount = 0;
          for (const edgeKey of edgeSet) {
            const [src, dst] = edgeKey.split('=>');
            if (!src || !dst) continue;
            if (componentSet.has(src) && componentSet.has(dst)) internalEdgeCount += 1;
          }
          return {
            component_id: i + 1,
            size: component.length,
            internal_edge_count: internalEdgeCount,
            files: [...component].sort((a, b) => a.localeCompare(b)),
          };
        })
        .sort((a, b) => b.size - a.size || b.internal_edge_count - a.internal_edge_count)
        .slice(0, maxResults);

      if (cycles.length === 0) {
        const message = targetNode
          ? `No cycles found containing "${scopedFile}" (min_size=${minSizeValue}).`
          : `No cycles found (min_size=${minSizeValue}).`;
        return renderResult(format, {
          ok: true,
          workspace: ws,
          file_path: scopedFile || null,
          min_size: minSizeValue,
          cycle_count: 0,
          cycles: [],
          summary: {
            node_count: nodeSet.size,
            edge_count: edgeSet.size,
            truncated,
            max_nodes: nodeCap,
            max_edges: edgeCap,
          },
        }, `## Atlas Cycles\n\n${message}`);
      }

      const lines = [
        `## Atlas Cycles (${cycles.length})`,
        '',
        ...cycles.map((cycle) => `- SCC#${cycle.component_id} size=${cycle.size} edges=${cycle.internal_edge_count}: ${cycle.files.slice(0, 6).join(', ')}${cycle.files.length > 6 ? ` ... +${cycle.files.length - 6}` : ''}`),
      ];
      if (truncated) lines.push('', `Note: graph truncated (max_nodes=${nodeCap}, max_edges=${edgeCap}).`);

      return renderResult(format, {
        ok: true,
        workspace: ws,
        file_path: scopedFile || null,
        min_size: minSizeValue,
        cycle_count: cycles.length,
        cycles,
        summary: {
          node_count: nodeSet.size,
          edge_count: edgeSet.size,
          truncated,
          max_nodes: nodeCap,
          max_edges: edgeCap,
        },
      }, lines.join('\n'));
    },
  );
}
