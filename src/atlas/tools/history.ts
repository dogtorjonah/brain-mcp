import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import type { AtlasChangelogRecord, AtlasDatabase } from '../db.js';
import { queryAtlasChangelog } from '../db.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
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

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { db: runtime.db, workspace: runtime.config.workspace };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { db: target.db, workspace: target.workspace };
}

function formatEntry(entry: AtlasChangelogRecord): string {
  const authorLabel = entry.author_name ?? entry.author_instance_id ?? 'unknown';
  const engineSuffix = entry.author_engine ? `/${entry.author_engine}` : '';
  return `- ${formatLocalTimestamp(entry.created_at)} | ${entry.file_path} | ${authorLabel}${engineSuffix} | ${entry.verification_status}${entry.breaking_changes ? ' | BREAKING' : ''}\n  ${entry.summary}`;
}

function atlasContent(format: 'json' | 'text' | undefined, payload: Record<string, unknown>, text: string) {
  return {
    content: [{
      type: 'text' as const,
      text: format === 'json' ? JSON.stringify(payload, null, 2) : text,
    }],
  };
}

export interface AtlasHistoryArgs {
  file_path?: string;
  filePath?: string;
  cluster?: string;
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
  breaking_changes?: boolean;
  since?: string;
  until?: string;
  workspace?: string;
  limit?: number;
  format?: 'json' | 'text';
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runHistoryTool(runtime: AtlasRuntime, {
  file_path,
  filePath,
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
  breaking_changes,
  since,
  until,
  workspace,
  limit,
  format,
}: AtlasHistoryArgs): Promise<AtlasToolTextResult> {
  const context = resolveDbContext(runtime, workspace);
  if (!context) {
    return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
  }

  const ws = context.workspace;
  const file = file_path ?? filePath;
  const authorEngineValue = author_engine ?? authorEngine;
  const authorInstanceValue = author_instance_id ?? authorInstanceId;
  const authorNameValue = author_name ?? authorName;
  const authorIdentityValue = author_identity ?? authorIdentity;
  const verificationValue = verification_status ?? verificationStatus;
  // Cap raised 200 -> 2000. The voxxo-swarm changelog already carries nearly
  // 1000 entries after ~6 days; a 200 ceiling silently hid ~80% of workspace
  // history from any caller asking for the full log. 2000 is a safety rail,
  // not an expected working value — default stays at 20.
  const maxResults = Math.max(1, Math.min(limit ?? 20, 2000));

  const entries = queryAtlasChangelog(context.db, {
    workspace: ws,
    file,
    cluster,
    author_engine: authorEngineValue,
    author_instance_id: authorInstanceValue,
    author_name: authorNameValue,
    author_identity: authorIdentityValue,
    since,
    until,
    verification_status: verificationValue,
    breaking_only: breaking_changes,
    limit: maxResults,
  });

  const sliced = entries
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id)
    .slice(0, maxResults);

  const verificationBreakdown = new Map<string, number>();
  for (const entry of sliced) {
    verificationBreakdown.set(entry.verification_status, (verificationBreakdown.get(entry.verification_status) ?? 0) + 1);
  }

  const lines: string[] = ['## Atlas History', ''];
  if (sliced.length === 0) {
    lines.push('- No changelog entries match the current filters.');
  } else {
    lines.push(...sliced.map((entry) => formatEntry(entry)));
  }
  lines.push('');
  lines.push('### Summary');
  lines.push(`- Workspace: ${ws}`);
  lines.push(`- Entries: ${sliced.length}`);
  if (verificationBreakdown.size > 0) {
    lines.push(`- Verification: ${[...verificationBreakdown.entries()].map(([key, value]) => `${key}=${value}`).join(', ')}`);
  }

  return atlasContent(format, {
    ok: true,
    workspace: ws,
    filters: {
      file_path: file ?? null,
      cluster: cluster ?? null,
      author_engine: authorEngineValue ?? null,
      author_instance_id: authorInstanceValue ?? null,
      author_name: authorNameValue ?? null,
      author_identity: authorIdentityValue ?? null,
      verification_status: verificationValue ?? null,
      since: since ?? null,
      until: until ?? null,
      breaking_changes: typeof breaking_changes === 'boolean' ? breaking_changes : null,
      limit: maxResults,
    },
    entries: sliced,
    summary: {
      entry_count: sliced.length,
      verification_breakdown: Object.fromEntries(verificationBreakdown.entries()),
    },
  }, lines.join('\n'));
}

export function registerHistoryTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_history',
    'Query the atlas changelog — see what files changed, when, and why. Filter by time range, file path, cluster, author, verification status, or breaking changes. Best for: understanding recent changes, tracking down regressions, and reviewing what happened in a module. Supports cross-workspace history lookup.',
    {
      file_path: z.string().min(1).optional(),
      filePath: z.string().min(1).optional(),
      cluster: z.string().min(1).optional(),
      author_engine: z.string().min(1).optional(),
      authorEngine: z.string().min(1).optional(),
      author_instance_id: z.string().min(1).optional(),
      authorInstanceId: z.string().min(1).optional(),
      author_name: z.string().min(1).optional(),
      authorName: z.string().min(1).optional(),
      author_identity: z.string().min(1).optional(),
      authorIdentity: z.string().min(1).optional(),
      verification_status: z.string().min(1).optional(),
      verificationStatus: z.string().min(1).optional(),
      breaking_changes: coercedOptionalBoolean,
      since: z.string().min(1).optional(),
      until: z.string().min(1).optional(),
      workspace: z.string().min(1).optional(),
      // z.coerce to tolerate LLM tool-call serializers that emit "100" as a
      // string. Max raised 200 -> 2000 to match the runtime cap; default 20.
      limit: z.coerce.number().int().min(1).max(2000).optional(),
      format: z.enum(['json', 'text']).optional().describe('Output format: json for structured data, text for human-readable (default: text)'),
    },
    async (args: AtlasHistoryArgs) => runHistoryTool(runtime, args),
  );
}
