import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase, AtlasReferenceRecord } from '../db.js';
import { listAtlasFiles, listImportEdges, listReferences, queryAtlasChangelog } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
}

interface SmellBreakdown {
  smell: string;
  points: number;
  reason: string;
}

interface SmellResult {
  file_path: string;
  cluster: string | null;
  purpose: string;
  severity: number;
  metrics: {
    loc: number;
    fan_in: number;
    fan_out: number;
    cycle_size: number;
    change_count: number;
    hazards_count: number;
    reference_usage: number;
  };
  breakdown: SmellBreakdown[];
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

function shouldExcludePath(filePath: string, includeTestFiles: boolean): boolean {
  if (includeTestFiles) return false;
  const p = normalizePath(filePath);
  if (p.includes('/__tests__/') || p.includes('/__mocks__/') || p.includes('/test/') || p.includes('/tests/') || p.includes('/spec/') || p.includes('/fixtures/')) {
    return true;
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

function buildAdjacency(edges: Array<{ source_file: string; target_file: string }>, nodeSet: Set<string>): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodeSet) {
    outgoing.set(node, []);
    incoming.set(node, []);
  }

  const seen = new Set<string>();
  for (const edge of edges) {
    const src = normalizePath(edge.source_file);
    const dst = normalizePath(edge.target_file);
    if (!nodeSet.has(src) || !nodeSet.has(dst)) continue;
    const key = `${src}=>${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outgoing.get(src)?.push(dst);
    incoming.get(dst)?.push(src);
  }

  return { outgoing, incoming };
}

function buildSccSizeByNode(outgoing: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccSize = new Map<string, number>();
  let idx = 0;

  const strongConnect = (node: string): void => {
    index.set(node, idx);
    low.set(node, idx);
    idx += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of outgoing.get(node) ?? []) {
      if (!index.has(neighbor)) {
        strongConnect(neighbor);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(neighbor) ?? 0));
      } else if (onStack.has(neighbor)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(neighbor) ?? 0));
      }
    }

    if ((low.get(node) ?? -1) === (index.get(node) ?? -2)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const top = stack.pop();
        if (!top) break;
        onStack.delete(top);
        component.push(top);
        if (top === node) break;
      }
      for (const member of component) sccSize.set(member, component.length);
    }
  };

  for (const node of outgoing.keys()) {
    if (!index.has(node)) strongConnect(node);
  }

  return sccSize;
}

function aggregateReferenceUsage(references: AtlasReferenceRecord[], nodeSet: Set<string>): Map<string, number> {
  const usage = new Map<string, number>();
  for (const ref of references) {
    const src = normalizePath(ref.source_file);
    const dst = normalizePath(ref.target_file);
    const count = Number(ref.usage_count ?? 1);
    if (nodeSet.has(src)) usage.set(src, (usage.get(src) ?? 0) + count);
    if (nodeSet.has(dst)) usage.set(dst, (usage.get(dst) ?? 0) + count);
  }
  return usage;
}

export function registerSmellsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_smells',
    'Detect code smells by combining file size, coupling density, cycle membership, churn frequency, hazard count, and reference usage into a severity score. Surfaces the riskiest files that need attention. Best for: identifying refactor targets, code quality audits, finding files that accumulate too many responsibilities.',
    {
      workspace: z.string().optional(),
      cluster: z.string().optional(),
      min_severity: z.coerce.number().int().min(1).max(10).optional(),
      minSeverity: z.coerce.number().int().min(1).max(10).optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
      include_test_files: coercedOptionalBoolean,
      includeTestFiles: coercedOptionalBoolean,
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      workspace,
      cluster,
      min_severity,
      minSeverity,
      limit,
      include_test_files,
      includeTestFiles,
      format,
    }: {
      workspace?: string;
      cluster?: string;
      min_severity?: number;
      minSeverity?: number;
      limit?: number;
      include_test_files?: boolean;
      includeTestFiles?: boolean;
      format?: 'json' | 'text';
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
      }

      const ws = context.workspace;
      const db = context.db;
      const out = resolveFormat(format);
      const min = Math.max(1, Math.min(10, Math.floor(min_severity ?? minSeverity ?? 3)));
      const maxResults = Math.max(1, Math.min(100, Math.floor(limit ?? 20)));
      const includeTests = include_test_files ?? includeTestFiles ?? false;

      const rows = listAtlasFiles(db, ws)
        .filter((row) => !cluster || row.cluster === cluster)
        .filter((row) => !shouldExcludePath(row.file_path, includeTests));

      if (rows.length === 0) {
        const text = 'No atlas files matched the current smell filters.';
        return { content: [{ type: 'text', text: formatOutput(out, { ok: false, workspace: ws, cluster: cluster ?? null, message: text }, text) }] };
      }

      const nodeSet = new Set(rows.map((row) => normalizePath(row.file_path)));
      const { outgoing, incoming } = buildAdjacency(listImportEdges(db, ws), nodeSet);
      const sccSizeByNode = buildSccSizeByNode(outgoing);

      const changelog = queryAtlasChangelog(db, { workspace: ws, limit: 50000 });
      const churnByPath = new Map<string, number>();
      for (const entry of changelog) {
        const p = normalizePath(entry.file_path);
        if (!nodeSet.has(p)) continue;
        churnByPath.set(p, (churnByPath.get(p) ?? 0) + 1);
      }

      const referenceUsage = aggregateReferenceUsage(listReferences(db, ws), nodeSet);
      const maxReferenceUsage = Math.max(0, ...referenceUsage.values());
      const referenceThreshold = maxReferenceUsage > 0 ? maxReferenceUsage * 0.75 : Number.POSITIVE_INFINITY;

      const results: SmellResult[] = rows
        .map((row) => {
          const path = normalizePath(row.file_path);
          const breakdown: SmellBreakdown[] = [];
          const fanIn = incoming.get(path)?.length ?? 0;
          const fanOut = outgoing.get(path)?.length ?? 0;
          const coupling = fanIn + fanOut;
          const cycleSize = sccSizeByNode.get(path) ?? 1;
          const changeCount = churnByPath.get(path) ?? 0;
          const hazardsCount = row.hazards?.length ?? 0;
          const usage = referenceUsage.get(path) ?? 0;

          if (row.loc > 500) breakdown.push({ smell: 'size', points: 2, reason: `loc ${row.loc}` });
          if (row.loc > 1000) breakdown.push({ smell: 'size', points: 2, reason: `very large file (${row.loc} LOC)` });
          if (coupling > 20) breakdown.push({ smell: 'coupling', points: 3, reason: `fan-in + fan-out = ${coupling}` });
          if (coupling > 40) breakdown.push({ smell: 'coupling', points: 1, reason: `extreme coupling (${coupling})` });
          if (cycleSize > 1) breakdown.push({ smell: 'cycle', points: 3, reason: `in ${cycleSize}-node cycle` });
          if (cycleSize >= 5) breakdown.push({ smell: 'cycle', points: 1, reason: `large cycle (${cycleSize})` });
          if (changeCount > 5) breakdown.push({ smell: 'churn', points: 2, reason: `churn ${changeCount}` });
          if (changeCount > 10) breakdown.push({ smell: 'churn', points: 1, reason: `heavy churn ${changeCount}` });
          if (hazardsCount > 3) breakdown.push({ smell: 'hazards', points: 2, reason: `${hazardsCount} hazards` });
          if (hazardsCount > 6) breakdown.push({ smell: 'hazards', points: 1, reason: `high hazard count ${hazardsCount}` });
          if (usage >= referenceThreshold && Number.isFinite(referenceThreshold)) {
            breakdown.push({ smell: 'reference_usage', points: 1, reason: `reference usage ${usage}` });
          }

          const severity = Math.min(10, breakdown.reduce((sum, item) => sum + item.points, 0));
          return {
            file_path: row.file_path,
            cluster: row.cluster ?? null,
            purpose: row.purpose || row.blurb || '',
            severity,
            metrics: {
              loc: row.loc ?? 0,
              fan_in: fanIn,
              fan_out: fanOut,
              cycle_size: cycleSize,
              change_count: changeCount,
              hazards_count: hazardsCount,
              reference_usage: usage,
            },
            breakdown,
          };
        })
        .filter((entry) => entry.severity >= min)
        .sort((a, b) => b.severity - a.severity || (b.metrics.fan_in + b.metrics.fan_out) - (a.metrics.fan_in + a.metrics.fan_out) || b.metrics.change_count - a.metrics.change_count)
        .slice(0, maxResults);

      if (results.length === 0) {
        const text = `No smells found at severity >= ${min}.`;
        return { content: [{ type: 'text', text: formatOutput(out, { ok: false, workspace: ws, cluster: cluster ?? null, min_severity: min, results: [], message: text }, text) }] };
      }

      const text = [
        `## Atlas Smells (${results.length})`,
        '',
        ...results.map((entry) => `- ${entry.severity}/10 ${entry.file_path} | ${entry.breakdown.map((item) => item.reason).join('; ')}`),
      ].join('\n');

      const payload = {
        ok: true,
        workspace: ws,
        cluster: cluster ?? null,
        min_severity: min,
        results,
        summary: {
          result_count: results.length,
          max_severity: results[0]?.severity ?? 0,
        },
      };
      return { content: [{ type: 'text', text: formatOutput(out, payload, text) }] };
    },
  );
}
