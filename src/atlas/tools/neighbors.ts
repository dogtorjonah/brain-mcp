import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { getAtlasFile, listAtlasFiles, listImportedBy, listImports, listReferences, listSymbols } from '../db.js';
import type { AtlasDatabase } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

const DEFAULT_DEPTH = 1;
const MAX_DEPTH = 2;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_MAX_NODES = 1200;
const MAX_NODES = 5000;
const DEFAULT_MAX_EDGES = 6000;
const MAX_EDGES = 30000;
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

function toNormalizedEdgeType(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_') || 'reference';
}

function renderResult(format: OutputFormat | undefined, payload: unknown, text: string): { content: Array<{ type: 'text'; text: string }> } {
  return {
    content: [{
      type: 'text',
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export function registerNeighborsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_neighbors',
    'Find the immediate import neighbors of a file — what it imports and what imports it. Shows direct coupling relationships. Best for: understanding a file\'s dependencies, finding tightly coupled modules, checking what breaks if you move a file.',
    {
      file_path: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      workspace: z.string().optional(),
      depth: z.coerce.number().int().min(1).max(MAX_DEPTH).optional(),
      include_references: coercedOptionalBoolean,
      includeReferences: coercedOptionalBoolean,
      edge_types: z.array(z.string().min(1)).optional(),
      edgeTypes: z.array(z.string().min(1)).optional(),
      include_symbols: coercedOptionalBoolean,
      includeSymbols: coercedOptionalBoolean,
      limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
      max_nodes: z.coerce.number().int().min(1).max(MAX_NODES).optional(),
      maxNodes: z.coerce.number().int().min(1).max(MAX_NODES).optional(),
      max_edges: z.coerce.number().int().min(1).max(MAX_EDGES).optional(),
      maxEdges: z.coerce.number().int().min(1).max(MAX_EDGES).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      file_path,
      filePath,
      workspace,
      depth,
      include_references,
      includeReferences: includeReferencesArg,
      edge_types,
      edgeTypes,
      include_symbols,
      includeSymbols: includeSymbolsArg,
      limit,
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
      include_references?: boolean;
      includeReferences?: boolean;
      edge_types?: string[];
      edgeTypes?: string[];
      include_symbols?: boolean;
      includeSymbols?: boolean;
      limit?: number;
      max_nodes?: number;
      maxNodes?: number;
      max_edges?: number;
      maxEdges?: number;
      format?: OutputFormat;
    }) => {
      const seedFile = resolveFilePathArg({ file_path, filePath });
      if (!seedFile) {
        return renderResult(format, { ok: false, error: 'atlas_neighbors requires "file_path".' }, 'atlas_neighbors requires "file_path".');
      }

      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return renderResult(format, { ok: false, error: `Workspace "${workspace}" not found.` }, `Workspace "${workspace}" not found.`);
      }

      const ws = context.workspace;
      const db = context.db;
      const graphDepth = Math.max(1, Math.min(depth ?? DEFAULT_DEPTH, MAX_DEPTH));
      const includeReferences = include_references ?? includeReferencesArg ?? false;
      const includeSymbols = include_symbols ?? includeSymbolsArg ?? true;
      const resultLimit = Math.max(1, Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT));
      const nodeCap = Math.max(1, Math.min(max_nodes ?? maxNodes ?? DEFAULT_MAX_NODES, MAX_NODES));
      const edgeCap = Math.max(1, Math.min(max_edges ?? maxEdges ?? DEFAULT_MAX_EDGES, MAX_EDGES));
      const requestedEdgeTypes = new Set((edge_types ?? edgeTypes ?? []).map((value) => toNormalizedEdgeType(value)));

      const rows = listAtlasFiles(db, ws);
      const rowByPath = new Map<string, AtlasFileRecord>();
      for (const row of rows) rowByPath.set(normalizeGraphPath(row.file_path), row);

      const root = normalizeGraphPath(seedFile);
      if (!rowByPath.has(root) && !getAtlasFile(db, ws, seedFile)) {
        return renderResult(format, {
          ok: false,
          workspace: ws,
          file_path: seedFile,
          error: `No atlas entry for "${seedFile}" in workspace "${ws}".`,
        }, `No atlas entry for "${seedFile}" in workspace "${ws}".`);
      }

      const seenNodes = new Set<string>([root]);
      const imports: Array<{ from: string; to: string; depth: number }> = [];
      const importedBy: Array<{ from: string; to: string; depth: number }> = [];
      let frontier: string[] = [root];
      let edgeCount = 0;
      let truncated = false;

      for (let currentDepth = 1; currentDepth <= graphDepth; currentDepth += 1) {
        if (frontier.length === 0 || truncated) break;
        const nextFrontier: string[] = [];
        for (const node of frontier) {
          for (const targetFile of listImports(db, ws, node)) {
            const normalized = normalizeGraphPath(targetFile);
            imports.push({ from: node, to: normalized, depth: currentDepth });
            edgeCount += 1;
            if (!seenNodes.has(normalized) && seenNodes.size < nodeCap) {
              seenNodes.add(normalized);
              nextFrontier.push(normalized);
            } else if (!seenNodes.has(normalized)) {
              truncated = true;
            }
            if (edgeCount >= edgeCap) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
          for (const sourceFile of listImportedBy(db, ws, node)) {
            const normalized = normalizeGraphPath(sourceFile);
            importedBy.push({ from: normalized, to: node, depth: currentDepth });
            edgeCount += 1;
            if (!seenNodes.has(normalized) && seenNodes.size < nodeCap) {
              seenNodes.add(normalized);
              nextFrontier.push(normalized);
            } else if (!seenNodes.has(normalized)) {
              truncated = true;
            }
            if (edgeCount >= edgeCap) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }
        frontier = nextFrontier;
      }

      const referenceRows = includeReferences
        ? listReferences(db, ws, root)
            .map((row) => ({
              file_path: normalizeGraphPath(row.target_file),
              edge_type: toNormalizedEdgeType(row.edge_type),
              usage_count: Number(row.usage_count ?? 0),
              confidence: Number(row.confidence ?? 0),
            }))
            .filter((row) => requestedEdgeTypes.size === 0 || requestedEdgeTypes.has(row.edge_type))
            .sort((a, b) => b.usage_count - a.usage_count || a.file_path.localeCompare(b.file_path))
            .slice(0, resultLimit)
        : [];

      const reverseReferenceRows = includeReferences
        ? listReferences(db, ws)
            .filter((row) => normalizeGraphPath(row.target_file) === root)
            .map((row) => ({
              file_path: normalizeGraphPath(row.source_file),
              edge_type: toNormalizedEdgeType(row.edge_type),
              usage_count: Number(row.usage_count ?? 0),
              confidence: Number(row.confidence ?? 0),
            }))
            .filter((row) => requestedEdgeTypes.size === 0 || requestedEdgeTypes.has(row.edge_type))
            .sort((a, b) => b.usage_count - a.usage_count || a.file_path.localeCompare(b.file_path))
            .slice(0, resultLimit)
        : [];

      const symbols = includeSymbols
        ? listSymbols(db, ws, root).slice(0, resultLimit).map((symbol) => ({
            name: symbol.name,
            kind: symbol.kind,
            exported: symbol.exported,
            line_start: symbol.line_start,
            line_end: symbol.line_end,
          }))
        : [];

      const lines: string[] = [
        `## Atlas Neighbors: ${root}`,
        '',
        `- Imports (${Math.min(imports.length, resultLimit)}): ${imports.slice(0, resultLimit).map((entry) => entry.to).join(', ') || 'none'}`,
        `- Imported by (${Math.min(importedBy.length, resultLimit)}): ${importedBy.slice(0, resultLimit).map((entry) => entry.from).join(', ') || 'none'}`,
      ];
      if (includeReferences) {
        lines.push(`- References out (${referenceRows.length})`);
        lines.push(`- References in (${reverseReferenceRows.length})`);
      }
      if (includeSymbols) lines.push(`- Symbols (${symbols.length})`);
      if (truncated) lines.push(`- Note: graph traversal truncated (max_nodes=${nodeCap}, max_edges=${edgeCap})`);

      return renderResult(format, {
        ok: true,
        workspace: ws,
        file_path: root,
        depth: graphDepth,
        include_references: includeReferences,
        include_symbols: includeSymbols,
        imports: imports.slice(0, resultLimit),
        imported_by: importedBy.slice(0, resultLimit),
        references_out: referenceRows,
        references_in: reverseReferenceRows,
        symbols,
        summary: {
          node_count: seenNodes.size,
          edge_count: edgeCount,
          truncated,
          max_nodes: nodeCap,
          max_edges: edgeCap,
        },
      }, lines.join('\n'));
    },
  );
}
