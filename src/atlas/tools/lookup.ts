import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import type { AtlasDatabase } from '../db.js';
import { getAtlasFile, listImports, listImportedBy } from '../db.js';
import { trackQuery } from '../queryLog.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { discoverWorkspaces } from './bridge.js';

interface ChangelogRow {
  id: number;
  summary: string;
  patterns_added: string;
  hazards_added: string;
  author_instance_id: string | null;
  author_engine: string | null;
  verification_status: string;
  created_at: string;
}

function parseSqliteUtcTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalTimestamp(value: string | null | undefined): string {
  const parsed = parseSqliteUtcTimestamp(value);
  return parsed ? parsed.toLocaleString() : 'unknown';
}

function getRecentChangelog(db: AtlasDatabase, workspace: string, filePath: string, limit = 5): ChangelogRow[] {
  try {
    const rows = db.prepare(
      `SELECT id, summary, patterns_added, hazards_added, author_instance_id, author_engine,
              verification_status, created_at
       FROM atlas_changelog
       WHERE workspace = ? AND file_path = ?
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(workspace, filePath, limit) as ChangelogRow[];
    return rows;
  } catch {
    return [];
  }
}

function formatChangelogRow(row: ChangelogRow, index: number): string {
  const ts = formatLocalTimestamp(row.created_at);
  const verified = row.verification_status === 'confirmed' ? '✅' : row.verification_status === 'pending' ? '⏳' : '❌';
  let lines = `  ${index + 1}. ${row.summary} ${verified}`;
  lines += `\n     Author: ${row.author_instance_id ?? 'unknown'} | ${row.author_engine ?? '?'} | ${ts}`;

  try {
    const patterns = JSON.parse(row.patterns_added) as string[];
    if (patterns.length > 0) {
      lines += `\n     Patterns added: ${patterns.join(', ')}`;
    }
    const hazards = JSON.parse(row.hazards_added) as string[];
    if (hazards.length > 0) {
      lines += `\n     Hazards added: ${hazards.join(', ')}`;
    }
  } catch { /* ignore parse errors */ }

  return lines;
}

function toTrimmedText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return null;
}

function formatKeyTypeEntry(entry: unknown): string | null {
  const direct = toTrimmedText(entry);
  if (direct) return direct;
  if (!entry || typeof entry !== 'object') return null;

  const record = entry as Record<string, unknown>;
  const name = toTrimmedText(record.name ?? record.symbol ?? record.id ?? record.title);
  const kind = toTrimmedText(record.kind ?? record.type ?? record.category);
  const description = toTrimmedText(record.description ?? record.summary);
  const exported = record.exported === true ? 'exported' : null;

  if (name && kind) {
    const modifiers = [exported].filter(Boolean).join(', ');
    return `\`${name}\` (${[kind, modifiers].filter(Boolean).join(', ')})${description ? ` — ${description}` : ''}`;
  }
  if (name) {
    return description ? `\`${name}\` — ${description}` : `\`${name}\``;
  }
  if (kind) {
    return description ? `${kind} — ${description}` : kind;
  }
  return description;
}

async function readSourceFile(sourceRoot: string, filePath: string): Promise<{ hash: string; content: string } | null> {
  try {
    const content = await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
    const hash = createHash('sha1').update(content).digest('hex');
    return { hash, content };
  } catch {
    return null;
  }
}

function formatNeighborBlurb(filePath: string, blurb: string | undefined | null, keyTypes?: unknown[]): string {
  const b = blurb?.trim() || '(no blurb)';
  const types = Array.isArray(keyTypes) && keyTypes.length > 0
    ? ` [exports: ${(keyTypes as Array<{ name?: string }>).slice(0, 5).map((t) => t.name).filter(Boolean).join(', ')}]`
    : '';
  return `  ${filePath}${types}\n    ${b}`;
}

export interface AtlasLookupArgs {
  filePath: string;
  workspace?: string;
  includeSource?: boolean;
  includeNeighbors?: boolean;
  includeCrossRefs?: boolean;
  offset?: number;
  limit?: number;
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runLookupTool(runtime: AtlasRuntime, { filePath, workspace, includeSource, includeNeighbors, includeCrossRefs, offset, limit: sourceLimit }: AtlasLookupArgs): Promise<AtlasToolTextResult> {
  const ws = workspace ?? runtime.config.workspace;

  // Resolve DB and sourceRoot — local workspace or cross-workspace via bridge discovery
  let db: AtlasDatabase = runtime.db;
  let sourceRoot: string = runtime.config.sourceRoot;
  if (workspace && workspace !== runtime.config.workspace) {
    const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
    const target = allDbs.find((d) => d.workspace === workspace);
    if (!target) {
      const available = allDbs.map((d) => d.workspace).join(', ');
      return { content: [{ type: 'text', text: `Workspace "${workspace}" not found. Available: ${available}` }] };
    }
    db = target.db;
    sourceRoot = target.sourceRoot;
  }

  const row = getAtlasFile(db, ws, filePath);
  trackQuery(filePath, row ? [row.id] : [], row ? [row.file_path] : []);
  if (!row) {
    return { content: [{ type: 'text', text: `No atlas row found for ${filePath}.` }] };
  }

  const sourceFile = await readSourceFile(sourceRoot, filePath);
  const stale = sourceFile && row.file_hash && sourceFile.hash !== row.file_hash
    ? '\n⚠️  STALE: file has changed since last extraction.\n'
    : '';

  // Build full extraction section
  const lines: string[] = [];
  lines.push(`# ${row.file_path}`);
  if (stale) lines.push(stale);

  // ── Recent Changes (atlas_changelog consumer) ──
  const recentChanges = getRecentChangelog(db, ws, filePath, 5);
  if (recentChanges.length > 0) {
    lines.push('');
    lines.push('## Recent Changes');
    lines.push('These entries were written by agents after editing this file — capturing the "why" behind recent changes:');
    recentChanges.forEach((entry, i) => {
      lines.push(formatChangelogRow(entry, i));
    });
  }

  if (row.cluster) lines.push(`Cluster: ${row.cluster}`);
  lines.push('');
  lines.push('## Purpose');
  lines.push(row.purpose || row.blurb || '(no extraction yet)');

  if (Array.isArray(row.patterns) && row.patterns.length > 0) {
    lines.push('');
    lines.push('## Patterns');
    lines.push(row.patterns.join(', '));
  }

  if (Array.isArray(row.hazards) && row.hazards.length > 0) {
    lines.push('');
    lines.push('## Hazards');
    for (const h of row.hazards) lines.push(`- ${h}`);
  }

  if (Array.isArray(row.public_api) && row.public_api.length > 0) {
    lines.push('');
    lines.push('## Public API');
    for (const entry of (row.public_api as Array<{ name?: string; type?: string; description?: string }>).slice(0, 20)) {
      lines.push(`- ${entry.name} (${entry.type ?? '?'})${entry.description ? ': ' + entry.description : ''}`);
    }
  }

  if (row.dependencies) {
    const deps = row.dependencies as { imports?: string[]; imported_by?: string[] };
    if (deps.imports?.length) {
      lines.push('');
      lines.push('## Dependencies (imports)');
      lines.push(deps.imports.join(', '));
    }
    if (deps.imported_by?.length) {
      lines.push('');
      lines.push('## Dependencies (imported by)');
      lines.push(deps.imported_by.join(', '));
    }
  }

  if (Array.isArray(row.data_flows) && row.data_flows.length > 0) {
    lines.push('');
    lines.push('## Data Flows');
    for (const f of row.data_flows) lines.push(`- ${f}`);
  }

  if (Array.isArray(row.key_types) && row.key_types.length > 0) {
    lines.push('');
    lines.push('## Key Types');
    for (const t of row.key_types.slice(0, 20)) {
      const rendered = formatKeyTypeEntry(t);
      if (rendered) {
        lines.push(`- ${rendered}`);
      }
    }
  }

  if (includeCrossRefs === true && row.cross_refs?.symbols) {
    const syms = Object.entries(row.cross_refs.symbols);
    if (syms.length > 0) {
      const totalRefs = row.cross_refs.total_cross_references ?? 0;
      lines.push('');
      lines.push(`## Cross-References (${totalRefs} total)`);
      for (const [name, info] of syms) {
        const callerLines = info.call_sites?.map((cs: { file: string; usage_type: string; count: number; context: string }) =>
          `    ${cs.file} (${cs.usage_type}, ${cs.count}x): ${cs.context}`) || [];
        lines.push(`- \`${name}\` (${info.type}, blast_radius=${info.blast_radius}, ${info.total_usages} usages)`);
        if (callerLines.length > 0) lines.push(callerLines.join('\n'));
      }
    }
  }

  // Neighborhood — import graph proximity (off by default to save tokens; use atlas_graph for topology)
  if (includeNeighbors === true) {
    const imports = listImports(db, ws, filePath);
    const callers = listImportedBy(db, ws, filePath);

    if (imports.length > 0) {
      lines.push('');
      lines.push(`## Imports (${imports.length} direct dependencies)`);
      for (const imp of imports.slice(0, 20)) {
        const neighbor = getAtlasFile(db, ws, imp);
        lines.push(formatNeighborBlurb(imp, neighbor?.blurb || neighbor?.purpose, neighbor?.key_types));
      }
      if (imports.length > 20) lines.push(`  ... and ${imports.length - 20} more`);
    }

    if (callers.length > 0) {
      lines.push('');
      lines.push(`## Callers (${callers.length} files import this)`);
      for (const caller of callers.slice(0, 20)) {
        const neighbor = getAtlasFile(db, ws, caller);
        lines.push(formatNeighborBlurb(caller, neighbor?.blurb || neighbor?.purpose));
      }
      if (callers.length > 20) lines.push(`  ... and ${callers.length - 20} more`);
    }
  }

  // ── Source code: always include full source; curated snippets are optional guideposts ──
  const shouldIncludeSource = includeSource !== false;
  const rawHighlights = row.source_highlights ?? [];
  const highlights = Array.isArray(rawHighlights) ? rawHighlights : [];

  if (shouldIncludeSource && highlights.length > 0) {
    const sourceLines = sourceFile?.content.split('\n');
    const totalLines = sourceLines?.length ?? row.loc;
    lines.push('');
    lines.push(`## Source Highlights (${highlights.length} curated snippet${highlights.length === 1 ? '' : 's'} from ${totalLines} lines)`);
    lines.push('These snippets were selected by an agent as guideposts for the most important sections of this file.');
    lines.push('');
    for (const snippet of highlights) {
      const label = snippet.label ? ` — ${snippet.label}` : '';
      lines.push(`### Snippet ${snippet.id}${label} (lines ${snippet.startLine}–${snippet.endLine})`);
      lines.push('```');
      lines.push(snippet.content);
      lines.push('```');
      lines.push('');
    }
  }

  if (shouldIncludeSource && sourceFile) {
    const sourceLines = sourceFile.content.split('\n');
    const totalLines = sourceLines.length;

    // Smart pagination: auto-paginate large files, pass through small ones
    const SOURCE_PAGE_SIZE = 500;
    const hasPaginationParams = offset !== undefined || sourceLimit !== undefined;
    const needsPagination = totalLines > SOURCE_PAGE_SIZE || hasPaginationParams;

    if (!needsPagination) {
      // Small file — return everything (no behavior change for files ≤500 lines)
      lines.push('');
      lines.push(`## Source (${totalLines} lines)`);
      lines.push('```');
      lines.push(sourceLines.join('\n'));
      lines.push('```');
    } else {
      // Large file or explicit pagination — slice with offset/limit
      const startLine = Math.min(offset ?? 0, totalLines);
      const pageSize = sourceLimit ?? SOURCE_PAGE_SIZE;
      const endLine = Math.min(startLine + pageSize, totalLines);
      const page = sourceLines.slice(startLine, endLine);

      lines.push('');
      lines.push(`## Source (lines ${startLine + 1}–${endLine} of ${totalLines})`);
      lines.push('```');
      // Number each line for parity with Read tool output
      for (let i = 0; i < page.length; i++) {
        lines.push(`${String(startLine + i + 1).padStart(5)}\t${page[i]}`);
      }
      lines.push('```');

      if (endLine < totalLines) {
        const remaining = totalLines - endLine;
        lines.push(`\n📄 ${remaining} more lines. Next page: \`atlas_query action=lookup file_path="${filePath}" offset=${endLine}\``);
      }
    }

    if (highlights.length === 0) {
      lines.push('\n💡 This file has no curated source highlights yet. Run `atlas_commit` with `source_highlights` to add guidepost snippets for future lookups.');
    }
  }

  return {
    content: [{
      type: 'text',
      text: lines.join('\n'),
    }],
  };
}

export function registerLookupTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_lookup',
    'Get the full structured extraction for a specific file. Returns: purpose, public API, patterns, dependencies, data flows, key types, hazards, conventions, cross-references, and the full source code by default. Includes staleness check — warns if the file changed since last extraction. Use before editing a file.',
    {
      filePath: z.string().min(1),
      workspace: z.string().optional(),
      includeSource: coercedOptionalBoolean.describe('Include source code in output (default true). Set false to omit source and show only metadata.'),
      includeNeighbors: coercedOptionalBoolean.describe('Include import/caller neighbor blurbs (default false). Set true when you need to understand a file\'s neighborhood. For topology analysis, prefer atlas_graph action=neighbors instead.'),
      includeCrossRefs: coercedOptionalBoolean.describe('Include cross-reference details with call sites (default false). Set true when you need blast radius info. For impact analysis, prefer atlas_graph action=impact instead.'),
      offset: z.coerce.number().int().min(0).optional().describe('Source code line offset (0-indexed). For large files (>500 lines), source is auto-paginated. Use offset to read subsequent pages.'),
      limit: z.coerce.number().int().min(1).optional().describe('Max source lines to return per page (default 500). Use with offset for pagination.'),
    },
    async (args: AtlasLookupArgs & Record<string, unknown>) => runLookupTool(runtime, args),
  );
}
