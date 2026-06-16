import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { listAtlasFilesAsync } from '../dbAsync.js';
import { discoverWorkspaces } from './bridge.js';

export interface AtlasCatalogArgs {
  workspace?: string;
  cluster?: string;
  query?: string;
  path_prefix?: string;
  pathPrefix?: string;
  field?: CatalogField;
  target?: CatalogField;
  limit?: number;
  offset?: number;
  format?: 'json' | 'text';
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export type CatalogField = 'blurb' | 'purpose';
type CatalogSummarySource = CatalogField | 'empty';

interface CatalogEntry {
  file_path: string;
  cluster: string | null;
  loc: number;
  blurb: string;
  purpose: string;
  summary: string;
  summary_source: CatalogSummarySource;
}

interface RuntimeDbContext {
  workspace: string;
  dbPath: string;
  cwd: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const TEXT_SUMMARY_MAX_CHARS = 320;

function hasText(value: string | null | undefined): boolean {
  return Boolean(value?.trim());
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit ?? DEFAULT_LIMIT)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(limit ?? DEFAULT_LIMIT), MAX_LIMIT));
}

function clampOffset(offset: number | undefined): number {
  if (!Number.isFinite(offset ?? 0)) return 0;
  return Math.max(0, Math.trunc(offset ?? 0));
}

function trimOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** rail-e0eb24f7 s11: normalized path_prefix — posix separators, no leading './'. */
function resolvePathPrefix(args: AtlasCatalogArgs): string | null {
  const raw = (args.path_prefix ?? args.pathPrefix)?.trim();
  if (!raw) return null;
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

function clampText(value: string, maxChars: number): string {
  const trimmed = trimOneLine(value);
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function resolveCatalogField(args: AtlasCatalogArgs): CatalogField {
  return args.field ?? args.target ?? 'blurb';
}

function normalizeCurrentWorkspaceAlias(currentWorkspace: string, workspace?: string): string {
  const target = workspace?.trim();
  if (!target || target === '.' || target === 'current') {
    return currentWorkspace;
  }
  return target;
}

function fallbackField(field: CatalogField): CatalogField {
  return field === 'blurb' ? 'purpose' : 'blurb';
}

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  const targetWorkspace = normalizeCurrentWorkspaceAlias(
    runtime.config.workspace,
    workspace,
  );

  if (targetWorkspace === runtime.config.workspace) {
    return {
      workspace: runtime.config.workspace,
      dbPath: runtime.config.dbPath,
      cwd: runtime.config.sourceRoot,
    };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === targetWorkspace);
  if (!target) return null;
  return {
    workspace: target.workspace,
    dbPath: target.dbPath,
    cwd: target.sourceRoot,
  };
}

function summarizeFile(row: AtlasFileRecord, field: CatalogField): CatalogEntry {
  const blurb = trimOneLine(row.blurb ?? '');
  const purpose = trimOneLine(row.purpose ?? '');
  const fallback = fallbackField(field);
  const values: Record<CatalogField, string> = { blurb, purpose };
  const summarySource: CatalogSummarySource = values[field] ? field : values[fallback] ? fallback : 'empty';
  const summary = summarySource === 'empty'
    ? `(no ${field} or ${fallback} yet)`
    : summarySource === 'purpose'
      ? clampText(purpose, TEXT_SUMMARY_MAX_CHARS)
      : blurb;

  return {
    file_path: row.file_path,
    cluster: row.cluster,
    loc: row.loc,
    blurb,
    purpose,
    summary,
    summary_source: summarySource,
  };
}

function matchesQuery(row: AtlasFileRecord, query: string | undefined): boolean {
  const needle = query?.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    row.file_path,
    row.cluster ?? '',
    row.blurb ?? '',
    row.purpose ?? '',
    ...(Array.isArray(row.tags) ? row.tags : []),
    ...(Array.isArray(row.patterns) ? row.patterns : []),
  ].join('\n').toLowerCase();
  return haystack.includes(needle);
}

function quoteArg(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function buildNextCommand(args: AtlasCatalogArgs, nextOffset: number, limit: number): string {
  const parts = ['atlas_query action=catalog'];
  const field = resolveCatalogField(args);
  if (field !== 'blurb') parts.push(`field=${field}`);
  if (args.workspace) parts.push(`workspace=${quoteArg(args.workspace)}`);
  if (args.cluster) parts.push(`cluster=${quoteArg(args.cluster)}`);
  if (args.query) parts.push(`query=${quoteArg(args.query)}`);
  const nextPathPrefix = resolvePathPrefix(args);
  if (nextPathPrefix) parts.push(`path_prefix=${quoteArg(nextPathPrefix)}`);
  parts.push(`offset=${nextOffset}`);
  parts.push(`limit=${limit}`);
  return parts.join(' ');
}

function formatCatalogText(args: AtlasCatalogArgs, payload: {
  workspace: string;
  total_files: number;
  files_with_blurb: number;
  files_with_purpose: number;
  field: CatalogField;
  matched_files: number;
  limit: number;
  offset: number;
  shown: number;
  has_more: boolean;
  next_offset: number | null;
  entries: CatalogEntry[];
}): string {
  const lines: string[] = [];
  lines.push(`## Atlas Catalog - ${payload.workspace}`);
  lines.push(
    `Files: ${payload.total_files} | With blurbs: ${payload.files_with_blurb} | With purpose: ${payload.files_with_purpose} | Matched: ${payload.matched_files}`,
  );
  lines.push(`Field: ${payload.field} (${fallbackField(payload.field)} fallback)`);
  const shownStart = payload.shown > 0 ? payload.offset + 1 : 0;
  const shownEnd = payload.offset + payload.shown;
  lines.push(`Showing: ${shownStart}-${shownEnd} (limit=${payload.limit}, offset=${payload.offset})`);

  const filters: string[] = [];
  if (args.cluster?.trim()) filters.push(`cluster=${args.cluster.trim()}`);
  if (args.query?.trim()) filters.push(`query=${args.query.trim()}`);
  const filterPathPrefix = resolvePathPrefix(args);
  if (filterPathPrefix) filters.push(`path_prefix=${filterPathPrefix}`);
  if (filters.length > 0) lines.push(`Filters: ${filters.join(' | ')}`);

  lines.push('');
  if (payload.entries.length === 0) {
    lines.push('No files matched.');
  } else {
    for (const entry of payload.entries) {
      const sourceSuffix = entry.summary_source === payload.field
        ? ''
        : entry.summary_source === fallbackField(payload.field)
          ? ` [${entry.summary_source} fallback]`
          : ' [empty]';
      const clusterSuffix = entry.cluster ? ` [${entry.cluster}]` : '';
      lines.push(`- ${entry.file_path}${clusterSuffix} (${entry.loc} LOC)${sourceSuffix}: ${entry.summary}`);
    }
  }

  if (payload.has_more && payload.next_offset != null) {
    lines.push('');
    lines.push(`Next page: \`${buildNextCommand(args, payload.next_offset, payload.limit)}\``);
  }

  return lines.join('\n');
}

export async function runCatalogTool(runtime: AtlasRuntime, args: AtlasCatalogArgs): Promise<AtlasToolTextResult> {
  const context = resolveDbContext(runtime, args.workspace);
  if (!context) {
    return {
      content: [{
        type: 'text',
        text: `Workspace "${args.workspace}" not found.`,
      }],
    };
  }

  const limit = clampLimit(args.limit);
  const offset = clampOffset(args.offset);
  const field = resolveCatalogField(args);
  const rows = await listAtlasFilesAsync(context.workspace, {
    dbPath: context.dbPath,
    cwd: context.cwd,
  });

  const totalFiles = rows.length;
  const filesWithBlurb = rows.filter((row) => hasText(row.blurb)).length;
  const filesWithPurpose = rows.filter((row) => hasText(row.purpose)).length;
  const pathPrefix = resolvePathPrefix(args);
  const filteredRows = rows.filter((row) => {
    if (pathPrefix && !row.file_path.startsWith(pathPrefix)) return false;
    if (args.cluster?.trim() && row.cluster !== args.cluster.trim()) return false;
    return matchesQuery(row, args.query);
  });
  const entries = filteredRows.slice(offset, offset + limit).map((row) => summarizeFile(row, field));
  const nextOffset = offset + entries.length;
  const hasMore = nextOffset < filteredRows.length;

  const payload = {
    workspace: context.workspace,
    total_files: totalFiles,
    files_with_blurb: filesWithBlurb,
    files_with_purpose: filesWithPurpose,
    field,
    matched_files: filteredRows.length,
    limit,
    offset,
    shown: entries.length,
    has_more: hasMore,
    next_offset: hasMore ? nextOffset : null,
    filters: {
      cluster: args.cluster?.trim() || null,
      query: args.query?.trim() || null,
      path_prefix: pathPrefix,
    },
    entries,
  };

  return {
    content: [{
      type: 'text',
      text: args.format === 'json' ? JSON.stringify(payload, null, 2) : formatCatalogText(args, payload),
    }],
  };
}
