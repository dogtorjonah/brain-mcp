import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, listImportEdges, queryAtlasChangelog } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

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

function normalizeMetric(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return Math.max(0, Math.min(1, value / maxValue));
}

function daysSince(timestamp: string | null): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / (24 * 60 * 60 * 1000));
}

function isTestPath(filePath: string): boolean {
  return /(^|\/)__tests__(\/|$)|(^|\/)test(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath);
}

function atlasContent(format: 'json' | 'text' | undefined, payload: Record<string, unknown>, text: string) {
  return {
    content: [{
      type: 'text' as const,
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export function registerHotspotsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_hotspots',
    'Rank files by risk score combining churn frequency, coupling density, file size, hazard count, and optional stale age weighting. Surfaces the files most likely to cause problems. Best for: identifying refactor targets, stability reviews, and architectural risk assessment. Supports cross-workspace analysis.',
    {
      cluster: z.string().min(1).optional(),
      since: z.string().min(1).optional(),
      include_test_files: coercedOptionalBoolean,
      includeTestFiles: coercedOptionalBoolean,
      limit: z.coerce.number().int().min(1).max(200).optional(),
      top_n: z.coerce.number().int().min(1).max(200).optional(),
      topN: z.coerce.number().int().min(1).max(200).optional(),
      weights: z.record(z.string(), z.coerce.number()).optional().describe('Optional scoring weight overrides'),
      risk_weights: z.record(z.string(), z.coerce.number()).optional(),
      workspace: z.string().min(1).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async ({
      cluster,
      since,
      include_test_files,
      includeTestFiles,
      limit,
      top_n,
      topN,
      weights,
      risk_weights,
      workspace,
      format,
    }: {
      cluster?: string;
      since?: string;
      include_test_files?: boolean;
      includeTestFiles?: boolean;
      limit?: number;
      top_n?: number;
      topN?: number;
      weights?: Record<string, number>;
      risk_weights?: Record<string, number>;
      workspace?: string;
      format?: 'json' | 'text';
    }) => {
      const context = resolveDbContext(runtime, workspace);
      if (!context) {
        return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
      }

      const ws = context.workspace;
      const includeTests = include_test_files ?? includeTestFiles ?? false;
      const maxResults = Math.max(1, Math.min(limit ?? top_n ?? topN ?? 20, 200));
      const mergedWeights = {
        hazards: 0.28,
        fan_in: 0.2,
        fan_out: 0.12,
        churn: 0.18,
        breaking: 0.1,
        loc: 0.07,
        stale_days: 0.05,
        ...(weights ?? {}),
        ...(risk_weights ?? {}),
      };
      const rows = listAtlasFiles(context.db, ws)
        .filter((row) => !cluster || row.cluster === cluster)
        .filter((row) => includeTests || !isTestPath(row.file_path));

      if (rows.length === 0) {
        return { content: [{ type: 'text', text: 'No atlas files matched the current hotspot filters.' }] };
      }

      const fanIn = new Map<string, number>();
      const fanOut = new Map<string, number>();
      for (const edge of listImportEdges(context.db, ws)) {
        fanOut.set(edge.source_file, (fanOut.get(edge.source_file) ?? 0) + 1);
        fanIn.set(edge.target_file, (fanIn.get(edge.target_file) ?? 0) + 1);
      }

      const changelog = queryAtlasChangelog(context.db, {
        workspace: ws,
        cluster,
        since,
        limit: 5000,
      });
      const churnByFile = new Map<string, { churn: number; breaking: number }>();
      for (const entry of changelog) {
        const current = churnByFile.get(entry.file_path) ?? { churn: 0, breaking: 0 };
        current.churn += 1;
        if (entry.breaking_changes) current.breaking += 1;
        churnByFile.set(entry.file_path, current);
      }

      const metrics = rows.map((row) => ({
        file_path: row.file_path,
        cluster: row.cluster ?? null,
        purpose: row.purpose || row.blurb || '',
        metrics: {
          hazards_count: row.hazards.length,
          fan_in: fanIn.get(row.file_path) ?? 0,
          fan_out: fanOut.get(row.file_path) ?? 0,
          churn_count: churnByFile.get(row.file_path)?.churn ?? 0,
          breaking_count: churnByFile.get(row.file_path)?.breaking ?? 0,
          loc: row.loc ?? 0,
          stale_days: daysSince(row.last_extracted),
        },
      }));

      const maxima = metrics.reduce((acc, entry) => ({
        fan_in: Math.max(acc.fan_in, entry.metrics.fan_in),
        fan_out: Math.max(acc.fan_out, entry.metrics.fan_out),
        churn_count: Math.max(acc.churn_count, entry.metrics.churn_count),
      }), {
        fan_in: 0,
        fan_out: 0,
        churn_count: 0,
      });

      const results = metrics.map((entry) => {
        const normalized = {
          hazards: Math.min(entry.metrics.hazards_count / 5, 1),
          fan_in: normalizeMetric(entry.metrics.fan_in, maxima.fan_in),
          fan_out: normalizeMetric(entry.metrics.fan_out, maxima.fan_out),
          churn: normalizeMetric(entry.metrics.churn_count, maxima.churn_count),
          breaking: Math.min(entry.metrics.breaking_count / 3, 1),
          loc: Math.min(entry.metrics.loc / 800, 1),
          stale_days: Math.min(entry.metrics.stale_days / 30, 1),
        };

        const weighted = [
          { label: entry.metrics.hazards_count > 0 ? `${entry.metrics.hazards_count} hazards` : '', score: normalized.hazards * mergedWeights.hazards },
          { label: entry.metrics.fan_in > 0 ? `fan-in ${entry.metrics.fan_in}` : '', score: normalized.fan_in * mergedWeights.fan_in },
          { label: entry.metrics.fan_out > 0 ? `fan-out ${entry.metrics.fan_out}` : '', score: normalized.fan_out * mergedWeights.fan_out },
          { label: entry.metrics.churn_count > 0 ? `churn ${entry.metrics.churn_count}` : '', score: normalized.churn * mergedWeights.churn },
          { label: entry.metrics.breaking_count > 0 ? `breaking ${entry.metrics.breaking_count}` : '', score: normalized.breaking * mergedWeights.breaking },
          { label: entry.metrics.loc > 0 ? `loc ${entry.metrics.loc}` : '', score: normalized.loc * mergedWeights.loc },
          { label: entry.metrics.stale_days > 0 ? `stale ${entry.metrics.stale_days.toFixed(1)}d` : '', score: normalized.stale_days * mergedWeights.stale_days },
        ].filter((item) => item.score > 0 && item.label);

        return {
          file_path: entry.file_path,
          cluster: entry.cluster,
          purpose: entry.purpose,
          risk_score: weighted.reduce((sum, item) => sum + item.score, 0),
          top_reasons: weighted.sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.label),
          metrics: entry.metrics,
        };
      })
        .sort((a, b) => b.risk_score - a.risk_score || b.metrics.fan_in - a.metrics.fan_in || b.metrics.churn_count - a.metrics.churn_count)
        .slice(0, maxResults);

      const lines = [
        '## Atlas Hotspots',
        '',
        ...results.map((entry) => `- ${entry.file_path} | score=${entry.risk_score.toFixed(3)} | ${entry.top_reasons.join(', ') || 'no strong signals'}`),
        '',
        '### Summary',
        `- Workspace: ${ws}`,
        `- Results: ${results.length}`,
      ];

      return atlasContent(format, {
        ok: true,
        workspace: ws,
        filters: {
          cluster: cluster ?? null,
          since: since ?? null,
          include_test_files: includeTests,
          limit: maxResults,
        },
        weights: mergedWeights,
        results,
        summary: {
          result_count: results.length,
          max_risk_score: results[0]?.risk_score ?? 0,
        },
      }, lines.join('\n'));
    },
  );
}
