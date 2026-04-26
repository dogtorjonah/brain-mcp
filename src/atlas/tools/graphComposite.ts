import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { registerImpactTool } from './impact.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { registerNeighborsTool } from './neighbors.js';
import { registerTraceTool } from './trace.js';
import { registerCyclesTool } from './cycles.js';
import { registerReachabilityTool } from './reachability.js';
import { registerGraphTool } from './graph.js';
import { runClusterTool } from './cluster.js';

type GraphAction = 'impact' | 'neighbors' | 'trace' | 'cycles' | 'reachability' | 'graph' | 'cluster';
type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: 'text'; text: string }> }>;
type RegisterToolFn = (server: McpServer, runtime: AtlasRuntime) => void;

interface CompositeArgs {
  action: GraphAction;
  workspace?: string;
  file_path?: string;
  filePath?: string;
  depth?: number;
  include_references?: boolean;
  includeReferences?: boolean;
  edge_types?: string[];
  edgeTypes?: string[];
  max_nodes?: number;
  maxNodes?: number;
  max_edges?: number;
  maxEdges?: number;
  limit?: number;
  format?: 'json' | 'text';
  include_test_files?: boolean;
  includeTestFiles?: boolean;
  from?: string;
  to?: string;
  from_symbol?: string;
  fromSymbol?: string;
  to_symbol?: string;
  toSymbol?: string;
  max_hops?: number;
  maxHops?: number;
  weighted?: boolean;
  symbol?: string;
  min_size?: number;
  minSize?: number;
  mode?: 'dead_exports' | 'dead_files' | 'path_query' | 'entrypoints';
  direction?: 'imports' | 'importers' | 'both';
  include_symbols?: boolean;
  includeSymbols?: boolean;
  cluster?: string;
}

type AtlasToolTextResult = { content: Array<{ type: 'text'; text: string }> };

function makeCaptureServer(captured: Map<string, ToolHandler>): McpServer {
  const tool = ((name: string, _a: unknown, _b: unknown, _c?: unknown) => {
    // MCP SDK supports both 3-arg and 4-arg overloads. Handler is always the last arg.
    const handler = (_c ?? _b) as ToolHandler;
    captured.set(name, handler);
  }) as unknown;

  return { tool } as McpServer;
}

function captureHandler(runtime: AtlasRuntime, registerFn: RegisterToolFn, toolName: string): ToolHandler {
  const captured = new Map<string, ToolHandler>();
  const server = makeCaptureServer(captured);
  registerFn(server, runtime);
  const handler = captured.get(toolName);
  if (!handler) {
    throw new Error(`Unable to capture handler for ${toolName}`);
  }
  return handler;
}

function appendGuidance(result: AtlasToolTextResult, hint?: string): AtlasToolTextResult {
  if (!hint) return result;
  return {
    content: [...result.content, { type: 'text', text: `💡 ${hint}` }],
  };
}

function firstText(result: AtlasToolTextResult): string {
  return result.content.find((item) => item.type === 'text')?.text ?? '';
}

function buildImpactHint(text: string): string | undefined {
  const totalMatch = text.match(/- Total files affected:\s*(\d+)/i);
  const affected = totalMatch ? Number(totalMatch[1]) : 0;
  if (affected > 15) {
    return '⚠️ Critical blast radius (>15 consumers). Run `atlas_audit action=gaps` to identify removable dead exports before changing this file.';
  }
  return undefined;
}

function buildReachabilityHint(args: CompositeArgs, text: string): string | undefined {
  const mode = args.mode;
  if (mode === 'path_query') {
    return `Use \`atlas_graph action=impact file_path=${args.to ?? '<target-file>'}\` next to estimate downstream risk on the destination file.`;
  }

  const unreachable = Number(text.match(/Unreachable files:\s*(\d+)/i)?.[1] ?? '0');
  const deadExports = Number(text.match(/Dead exports:\s*(\d+)/i)?.[1] ?? '0');
  if (unreachable > 0 || deadExports > 0) {
    return 'Dead-code candidates detected; run `atlas_audit action=gaps` to validate export/import cleanup opportunities.';
  }
  return undefined;
}

export function registerGraphCompositeTool(server: McpServer, runtime: AtlasRuntime): void {
  const handlers = {
    impact: captureHandler(runtime, registerImpactTool, 'atlas_impact'),
    neighbors: captureHandler(runtime, registerNeighborsTool, 'atlas_neighbors'),
    trace: captureHandler(runtime, registerTraceTool, 'atlas_trace'),
    cycles: captureHandler(runtime, registerCyclesTool, 'atlas_cycles'),
    reachability: captureHandler(runtime, registerReachabilityTool, 'atlas_reachability'),
    graph: captureHandler(runtime, registerGraphTool, 'atlas_graph'),
  } as const;

  toolWithDescription(server)(
    'atlas_graph',
    [
      'Use atlas_graph BEFORE any structural change — do not guess at blast radius or dependency chains.',
      'This tool knows the full import graph, AST-verified structural edges, and community clusters. Use it instead of manually tracing imports across files.',
      '',
      'Actions: impact estimates downstream change surface for a file or symbol; neighbors shows the local structural neighborhood around a file; trace follows paths between files or symbols; cycles finds strongly connected regions; reachability answers dead-code, entrypoint, or path-query questions; graph gives a broader topology snapshot with edge filters and graph limits; cluster lists all files in a named community cluster.',
      '',
      'Key rule: run action=impact BEFORE editing any shared module. Use neighbors to orient around one file. Use trace to explain why two areas are connected. Use reachability to confirm dead files.',
    ].join('\n'),
    {
      action: z.enum(['impact', 'neighbors', 'trace', 'cycles', 'reachability', 'graph', 'cluster']),
      workspace: z.string().optional(),
      file_path: z.string().optional(),
      filePath: z.string().optional(),
      depth: z.coerce.number().int().optional(),
      include_references: coercedOptionalBoolean,
      includeReferences: coercedOptionalBoolean,
      edge_types: z.array(z.string()).optional(),
      edgeTypes: z.array(z.string()).optional(),
      max_nodes: z.coerce.number().int().optional(),
      maxNodes: z.coerce.number().int().optional(),
      max_edges: z.coerce.number().int().optional(),
      maxEdges: z.coerce.number().int().optional(),
      limit: z.coerce.number().int().optional(),
      format: z.enum(['json', 'text']).optional(),
      include_test_files: coercedOptionalBoolean,
      includeTestFiles: coercedOptionalBoolean,
      from: z.string().optional(),
      to: z.string().optional(),
      from_symbol: z.string().optional(),
      fromSymbol: z.string().optional(),
      to_symbol: z.string().optional(),
      toSymbol: z.string().optional(),
      max_hops: z.coerce.number().int().optional(),
      maxHops: z.coerce.number().int().optional(),
      weighted: coercedOptionalBoolean,
      symbol: z.string().optional(),
      min_size: z.coerce.number().int().optional(),
      minSize: z.coerce.number().int().optional(),
      mode: z.enum(['dead_exports', 'dead_files', 'path_query', 'entrypoints']).optional(),
      direction: z.enum(['imports', 'importers', 'both']).optional(),
      include_symbols: coercedOptionalBoolean,
      includeSymbols: coercedOptionalBoolean,
      cluster: z.string().optional(),
    },
    async (args: CompositeArgs) => {
      const { action } = args;

      switch (action) {
        case 'impact': {
          const filePath = args.filePath ?? args.file_path;
          if (!filePath) {
            return { content: [{ type: 'text', text: 'atlas_graph(action=impact) requires file_path or filePath.' }] };
          }
          const result = await handlers.impact({
            filePath,
            symbol: args.symbol,
            workspace: args.workspace,
            depth: args.depth,
            edgeTypes: args.edgeTypes ?? args.edge_types,
          });
          return appendGuidance(result, buildImpactHint(firstText(result)));
        }
        case 'neighbors':
          return handlers.neighbors(args as unknown as Record<string, unknown>);
        case 'trace':
          return handlers.trace(args as unknown as Record<string, unknown>);
        case 'cycles':
          return handlers.cycles(args as unknown as Record<string, unknown>);
        case 'reachability': {
          const result = await handlers.reachability(args as unknown as Record<string, unknown>);
          return appendGuidance(result, buildReachabilityHint(args, firstText(result)));
        }
        case 'graph':
          return handlers.graph(args as unknown as Record<string, unknown>);
        case 'cluster': {
          if (!args.cluster) {
            return { content: [{ type: 'text', text: 'atlas_graph(action=cluster) requires the "cluster" parameter with a cluster name. Use atlas_query action=cluster to list available clusters.' }] };
          }
          return runClusterTool(runtime, { cluster: args.cluster, workspace: args.workspace });
        }
        default:
          return { content: [{ type: 'text', text: `Unsupported action: ${String(action)}` }] };
      }
    },
  );
}
