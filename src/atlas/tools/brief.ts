import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, listImports, listImportedBy } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface WorkspaceContext {
  db: AtlasDatabase;
  workspace: string;
}

function resolveWorkspace(runtime: AtlasRuntime, workspace?: string): WorkspaceContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }
  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function compactPathList(paths: string[], showCount: number): string {
  if (paths.length === 0) return '(none)';
  const shown = paths.slice(0, showCount).map((p) => {
    // Show just the filename for brevity
    const parts = p.split('/');
    return parts[parts.length - 1];
  });
  const remaining = paths.length - showCount;
  if (remaining > 0) {
    return `${shown.join(', ')}, +${remaining} more`;
  }
  return shown.join(', ');
}

function summarizeExports(row: AtlasFileRecord): string {
  const entries = (row.public_api as Array<{ name?: string; type?: string }>).slice(0, 6);
  if (entries.length === 0) {
    // Fall back to exports field
    const exports = row.exports?.slice(0, 6) ?? [];
    if (exports.length === 0) return '(none)';
    const shown = exports.map((e) => `${e.name} (${e.type})`);
    const remaining = (row.exports?.length ?? 0) - 6;
    return remaining > 0 ? `${shown.join(', ')}, +${remaining} more` : shown.join(', ');
  }
  const shown = entries.map((e) => `${e.name ?? '?'} (${e.type ?? '?'})`);
  const remaining = (row.public_api?.length ?? 0) - 6;
  return remaining > 0 ? `${shown.join(', ')}, +${remaining} more` : shown.join(', ');
}

function computeCoverage(row: AtlasFileRecord): { filled: number; total: number; empty: string[] } {
  const total = 9;
  const empty: string[] = [];
  if (!row.purpose?.trim()) empty.push('purpose');
  if (!row.blurb?.trim()) empty.push('blurb');
  if (!Array.isArray(row.patterns) || row.patterns.length === 0) empty.push('patterns');
  if (!Array.isArray(row.hazards) || row.hazards.length === 0) empty.push('hazards');
  if (!Array.isArray(row.conventions) || row.conventions.length === 0) empty.push('conventions');
  if (!Array.isArray(row.key_types) || row.key_types.length === 0) empty.push('key_types');
  if (!Array.isArray(row.data_flows) || row.data_flows.length === 0) empty.push('data_flows');
  if (!Array.isArray(row.public_api) || row.public_api.length === 0) empty.push('public_api');
  if (!Array.isArray(row.source_highlights) || row.source_highlights.length === 0) empty.push('source_highlights');
  return { filled: total - empty.length, total, empty };
}

export interface AtlasBriefArgs {
  filePath: string;
  workspace?: string;
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runBriefTool(runtime: AtlasRuntime, { filePath, workspace }: AtlasBriefArgs): Promise<AtlasToolTextResult> {
  const context = resolveWorkspace(runtime, workspace);
  if (!context) {
    return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
  }

  const row = getAtlasFile(context.db, context.workspace, filePath);
  if (!row) {
    return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
  }

  const imports = listImports(context.db, context.workspace, filePath);
  const callers = listImportedBy(context.db, context.workspace, filePath);
  const coverage = computeCoverage(row);

  const lines: string[] = [];

  // Header line with cluster, LOC, language
  lines.push(`# ${row.file_path}`);
  const meta = [row.cluster ?? 'unclustered', `${row.loc} LOC`, row.language ?? 'unknown'].join(' | ');
  lines.push(meta);

  // Purpose (full, not truncated)
  lines.push(`Purpose: ${row.purpose?.trim() || '(empty)'}`);

  // Blurb
  if (row.blurb?.trim()) {
    lines.push(`Blurb: ${row.blurb.trim()}`);
  }

  // Patterns
  if (Array.isArray(row.patterns) && row.patterns.length > 0) {
    lines.push(`Patterns: ${row.patterns.join(', ')}`);
  }

  // Hazards
  if (Array.isArray(row.hazards) && row.hazards.length > 0) {
    lines.push(`Hazards: ${row.hazards.join(', ')}`);
  }

  // Key exports
  lines.push(`Exports: ${summarizeExports(row)}`);

  // Compact neighbor lists
  lines.push(`Imports (${imports.length}): ${compactPathList(imports, 5)}`);
  lines.push(`Callers (${callers.length}): ${compactPathList(callers, 5)}`);

  // Coverage line
  const coverageLine = coverage.empty.length > 0
    ? `Coverage: ${coverage.filled}/${coverage.total} fields | Empty: ${coverage.empty.join(', ')}`
    : `Coverage: ${coverage.filled}/${coverage.total} fields ✅`;
  lines.push(coverageLine);

  return { content: [{ type: 'text', text: lines.join('\n') }] };
}

export function registerBriefTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_brief',
    'Rich card summary of a file: purpose, blurb, patterns, hazards, key exports, compact neighbor lists, and coverage status. ~200-300 tokens — much lighter than lookup (which includes full source). Use for triage, scanning many files, or deciding if you need a full lookup.',
    {
      filePath: z.string().min(1),
      workspace: z.string().optional(),
    },
    async (args: AtlasBriefArgs) => runBriefTool(runtime, args),
  );
}
