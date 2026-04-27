import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { getAtlasFile } from '../db.js';
import { toolWithDescription } from './helpers.js';
import { resolveWorkspaceDb } from './bridge.js';
import { runSearchTool } from './search.js';
import { runLookupTool } from './lookup.js';
import { runBriefTool } from './brief.js';
import { runSnippetTool } from './snippet.js';
import { runSimilarTool } from './similar.js';
import { runPlanContextTool } from './plan_context.js';
import { runClusterTool, runClusterCatalog } from './cluster.js';
import { runPatternsTool } from './patterns.js';
import { runHistoryTool } from './history.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

// NOTE: numeric fields use `z.coerce.number()` rather than `z.number()` because
// LLM tool-call serializers frequently emit numeric arguments as JSON strings
// (e.g. `"limit": "100"` instead of `"limit": 100`). Strict Zod rejects those
// with "expected number, received string", which caused silent failures where
// the caller saw an error and the tool appeared broken. Coercion accepts both
// shapes and normalizes to a number. Booleans use `coercedOptionalBoolean`
// from ../../zodHelpers — it explicitly maps "true"/"false" strings to real
// booleans while rejecting other values (the `z.coerce.boolean()` alternative
// is a footgun because `Boolean("false") === true`).
export const atlasQuerySchema = {
  action: z.enum(['search', 'lookup', 'brief', 'snippet', 'similar', 'plan_context', 'cluster', 'patterns', 'history']),
  workspace: z.string().optional(),
  file_path: z.string().optional(),
  filePath: z.string().optional(),
  query: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  offset: z.coerce.number().int().min(0).optional(),
  format: z.enum(['json', 'text']).optional(),
  symbol: z.string().optional(),
  start_line: z.coerce.number().int().optional(),
  end_line: z.coerce.number().int().optional(),
  include_source: coercedOptionalBoolean,
  workspaces: z.array(z.string()).optional(),
  min_score: z.coerce.number().optional(),
  include_neighbors: coercedOptionalBoolean,
  include_cross_refs: coercedOptionalBoolean,
  neighbor_depth: z.coerce.number().int().optional(),
  cluster: z.string().optional(),
  pattern: z.string().optional(),
  author_engine: z.string().optional(),
  authorEngine: z.string().optional(),
  author_instance_id: z.string().optional(),
  authorInstanceId: z.string().optional(),
  author_name: z.string().optional(),
  authorName: z.string().optional(),
  author_identity: z.string().optional(),
  authorIdentity: z.string().optional(),
  verification_status: z.string().optional(),
  verificationStatus: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  breaking_changes: coercedOptionalBoolean,
};

function missing(param: string) {
  return {
    content: [{
      type: 'text' as const,
      text: `atlas_query action requires "${param}".`,
    }],
  };
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

function appendGuidance(result: AtlasToolTextResult, hint?: string): AtlasToolTextResult {
  if (!hint) return result;
  return {
    content: [...result.content, { type: 'text', text: `💡 ${hint}` }],
  };
}

function firstText(result: AtlasToolTextResult): string {
  return result.content.find((item) => item.type === 'text')?.text ?? '';
}

function extractSearchPaths(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line.includes(' — '))
    .map((line) => {
      const withoutWorkspace = line.startsWith('[') && line.includes('] ')
        ? line.slice(line.indexOf('] ') + 2)
        : line;
      const head = withoutWorkspace.split(' — ').shift();
      return (head ?? '').trim();
    })
    .filter((value) => value.length > 0);
}

function inferDominantDirectory(paths: string[]): string | null {
  const counts = new Map<string, number>();
  for (const filePath of paths) {
    const parts = filePath.split('/').filter(Boolean);
    const directory = parts.length > 1 ? parts.slice(0, Math.min(parts.length - 1, 2)).join('/') : '(root)';
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!top) return null;
  const [dir, count] = top;
  return count >= Math.max(2, Math.ceil(paths.length * 0.6)) ? dir : null;
}

function buildSearchHint(runtime: AtlasRuntime, workspace: string, text: string): string | undefined {
  const paths = extractSearchPaths(text);
  if (paths.length === 0) return undefined;

  const resolved = resolveWorkspaceDb(runtime, workspace);
  const db = 'error' in resolved ? runtime.db : resolved.db;

  const clusterCounts = new Map<string, number>();
  let hazardCount = 0;
  for (const filePath of paths) {
    const row = getAtlasFile(db, workspace, filePath);
    const cluster = row?.cluster?.trim();
    if (cluster) clusterCounts.set(cluster, (clusterCounts.get(cluster) ?? 0) + 1);
    if (Array.isArray(row?.hazards) && row.hazards.length > 0) hazardCount += 1;
  }

  const topCluster = [...clusterCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const clustered = topCluster && topCluster[1] >= Math.max(2, Math.ceil(paths.length * 0.6))
    ? `Results concentrate in cluster "${topCluster[0]}"; run \`atlas_query action=cluster cluster=${topCluster[0]}\` for full domain scope.`
    : null;
  const dominantDir = clustered ? null : inferDominantDirectory(paths);
  const directoryHint = dominantDir
    ? `Results cluster under \`${dominantDir}\`; use \`atlas_query action=cluster\` to inspect the broader domain grouping.`
    : null;
  const hazardHint = hazardCount > 0
    ? `${hazardCount} result${hazardCount === 1 ? '' : 's'} include documented hazards; prioritize safe-edit review before touching them.`
    : null;

  return [clustered ?? directoryHint, hazardHint].filter(Boolean).join(' ') || undefined;
}

function buildLookupHint(text: string): string | undefined {
  if (/blast_radius=(high|critical)/i.test(text)) {
    return '⚠️ This file has high blast radius symbols. Run `atlas_graph action=impact` before modifying.';
  }
  if (!/## Cross-References/i.test(text)) {
    return 'Cross-references not yet computed. Run `atlas_admin action=reindex phase=crossref` to populate.';
  }
  return undefined;
}

function buildBriefHint(text: string): string | undefined {
  const match = text.match(/^Top consumers:\s+(.+)$/m);
  if (!match) return undefined;
  const consumerText = match[1] ?? '';
  const counts = [...consumerText.matchAll(/\((\d+)\)/g)].map((entry) => Number(entry[1] ?? '0'));
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total >= 10 || counts.some((value) => value >= 5)) {
    return 'This file has many consumers; run `atlas_graph action=impact` before editing.';
  }
  return undefined;
}

function buildSnippetHint(runtime: AtlasRuntime, workspace: string, filePath?: string): string | undefined {
  if (!filePath) return undefined;
  const resolved = resolveWorkspaceDb(runtime, workspace);
  const db = 'error' in resolved ? runtime.db : resolved.db;
  const row = getAtlasFile(db, workspace, filePath);
  if (!row || !Array.isArray(row.hazards) || row.hazards.length === 0) return undefined;
  return `Hazard note for \`${filePath}\`: ${row.hazards[0]}.`;
}

export function registerQueryTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_query',
    [
      'YOUR PRIMARY TOOL — use atlas_query BEFORE grep, rg, Read, or any raw file exploration.',
      'The atlas already knows what every file does, what it exports, what depends on it, and what patterns it uses. Raw code reads should only happen AFTER atlas_query tells you which files and lines matter.',
      '',
      'Actions: search finds likely files for a concept or task; lookup gives the full structured atlas record for one file; brief is the fastest orientation screen; snippet extracts exact code by symbol or line range; similar finds semantically related files; plan_context builds a compact execution context for a task; cluster lists every file in a domain; patterns finds files using a named implementation pattern; history shows changelog and verification history for a file or cluster.',
      '',
      'Instead of grep → use search. Instead of Read → use lookup or brief. Instead of reading multiple files → use plan_context. Instead of git log → use history. Instead of find/glob → use similar.',
      '',
      'Workflow: search when you do not know where to look; lookup or brief before editing a file; snippet when reviewing or quoting exact source; plan_context before a multi-file change; history before risky edits to see recent churn and prior review state.',
    ].join('\n'),
    atlasQuerySchema,
    async ({
      action,
      workspace,
      file_path,
      filePath,
      query,
      limit,
      offset,
      format,
      symbol,
      start_line,
      end_line,
      include_source,
      workspaces,
      min_score,
      include_neighbors,
      include_cross_refs,
      neighbor_depth,
      cluster,
      pattern,
      author_engine,
      authorEngine,
      author_instance_id,
      authorInstanceId,
      author_name,
      authorName,
      author_identity,
      authorIdentity,
      verification_status,
      verificationStatus,
      since,
      until,
      breaking_changes,
    }: {
      action: 'search' | 'lookup' | 'brief' | 'snippet' | 'similar' | 'plan_context' | 'cluster' | 'patterns' | 'history';
      workspace?: string;
      file_path?: string;
      filePath?: string;
      query?: string;
      limit?: number;
      offset?: number;
      format?: 'json' | 'text';
      symbol?: string;
      start_line?: number;
      end_line?: number;
      include_source?: boolean;
      workspaces?: string[];
      min_score?: number;
      include_neighbors?: boolean;
      include_cross_refs?: boolean;
      neighbor_depth?: number;
      cluster?: string;
      pattern?: string;
      author_engine?: string;
      authorEngine?: string;
      author_instance_id?: string;
      authorInstanceId?: string;
      author_name?: string;
      authorName?: string;
      author_identity?: string;
      authorIdentity?: string;
      verification_status?: string;
      verificationStatus?: string;
      since?: string;
      until?: string;
      breaking_changes?: boolean;
    }) => {
      const ws = workspace ?? runtime.config.workspace;
      const resolvedFilePath = file_path ?? filePath;
      switch (action) {
        case 'search':
          if (!query) return missing('query');
          {
            const result = await runSearchTool(runtime, { query, limit, workspace, workspaces });
            return appendGuidance(result, workspaces?.length ? undefined : buildSearchHint(runtime, ws, firstText(result)));
          }
        case 'lookup':
          if (!resolvedFilePath) return missing('file_path');
          {
            const result = await runLookupTool(runtime, {
              filePath: resolvedFilePath,
              workspace,
              includeSource: include_source,
              includeNeighbors: include_neighbors,
              includeCrossRefs: include_cross_refs,
              offset,
              limit,
            });
            return appendGuidance(result, buildLookupHint(firstText(result)));
          }
        case 'brief':
          if (!resolvedFilePath) return {
            content: [{
              type: 'text' as const,
              text: 'atlas_query action=brief requires "file_path" — it provides a concise summary of a specific file.\n\n💡 For workspace-level orientation, try:\n  • `atlas_query action=search query="<broad topic>"` to find relevant files\n  • `atlas_query action=cluster` to explore files grouped by domain\n  • `atlas_query action=patterns` to discover common code patterns',
            }],
          };
          {
            const result = await runBriefTool(runtime, { filePath: resolvedFilePath, workspace });
            return appendGuidance(result, buildBriefHint(firstText(result)));
          }
        case 'snippet':
          if (!resolvedFilePath) return missing('file_path');
          {
            const result = await runSnippetTool(runtime, {
              filePath: resolvedFilePath,
              symbol,
              startLine: start_line,
              endLine: end_line,
              workspace,
            });
            return appendGuidance(result, buildSnippetHint(runtime, ws, resolvedFilePath));
          }
        case 'similar':
          if (!resolvedFilePath) return missing('file_path');
          return runSimilarTool(runtime, { file_path: resolvedFilePath, workspace, limit, min_score, format });
        case 'plan_context':
          if (!query) return missing('query');
          return runPlanContextTool(runtime, {
            task: query,
            workspace,
            limit,
            include_neighbors,
            neighbor_depth,
            format,
          });
        case 'cluster':
          if (!cluster) return appendGuidance(
            await runClusterCatalog(runtime, workspace),
            'Use `atlas_query action=cluster cluster=<name>` to inspect a specific cluster.',
          );
          return appendGuidance(
            await runClusterTool(runtime, { cluster, workspace }),
            'Use `atlas_graph action=reachability` next to map dependency entrypoints and dead-code opportunities in this cluster.',
          );
        case 'patterns':
          return runPatternsTool(runtime, { pattern: pattern || undefined, workspace, limit });
        case 'history':
          return runHistoryTool(runtime, {
            file_path: resolvedFilePath,
            cluster,
            author_engine,
            authorEngine,
            author_instance_id,
            authorInstanceId,
            author_name,
            authorName,
            author_identity,
            authorIdentity,
            verification_status,
            verificationStatus,
            since,
            until,
            breaking_changes,
            workspace,
            limit,
            format,
          });
      }
    },
  );
}
