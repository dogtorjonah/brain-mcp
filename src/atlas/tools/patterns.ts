import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { countDistinctPatterns, listDistinctPatterns, listPatternFiles } from '../db.js';

export interface AtlasPatternsArgs {
  pattern?: string;
  workspace?: string;
  limit?: number;
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const MAX_OUTPUT_CHARS = 32_000;

function formatPatternCatalog(patterns: string[], workspace: string, limit: number, totalAvailable?: number): string {
  if (patterns.length === 0) {
    return `No patterns found in workspace "${workspace}". Patterns are extracted during atlas indexing (extract phase). Run \`atlas_admin action=reindex\` to populate.`;
  }
  const showing = totalAvailable && totalAvailable > patterns.length
    ? ` (showing ${patterns.length} of ${totalAvailable})`
    : ` (${patterns.length})`;
  let text = `Available patterns in "${workspace}"${showing}:\n${patterns.map((p) => `  • ${p}`).join('\n')}`;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n… output truncated at ${MAX_OUTPUT_CHARS} chars. Use \`pattern=<name>\` to query a specific pattern, or increase \`limit\`.`;
  }
  return text;
}

export async function runPatternsTool(runtime: AtlasRuntime, { pattern, workspace, limit }: AtlasPatternsArgs): Promise<AtlasToolTextResult> {
  const ws = workspace ?? runtime.config.workspace;

  // Catalog mode: no pattern specified — list all distinct patterns
  if (!pattern) {
    const catalogLimit = limit ?? 50;
    const totalAvailable = countDistinctPatterns(runtime.db, ws);
    const patterns = listDistinctPatterns(runtime.db, ws, catalogLimit);
    return {
      content: [{
        type: 'text',
        text: formatPatternCatalog(patterns, ws, catalogLimit, totalAvailable),
      }],
    };
  }

  const fileLimit = limit ?? 100;
  const rows = listPatternFiles(runtime.db, ws, pattern, fileLimit);

  if (rows.length === 0) {
    const available = listDistinctPatterns(runtime.db, ws, 20);
    const catalogHint = available.length > 0
      ? `\n\nAvailable patterns:\n${available.map((p) => `  • ${p}`).join('\n')}`
      : '\n\nNo patterns found in this workspace. Patterns are extracted during atlas indexing (extract phase).';
    return {
      content: [{
        type: 'text',
        text: `No files with pattern "${pattern}" in workspace "${ws}".${catalogHint}`,
      }],
    };
  }

  const lines = rows.map((row) =>
    `  📄 ${row.file_path} [${row.cluster ?? 'unknown'}] (${row.loc} LOC)\n     ${row.purpose.slice(0, 120)}`,
  );

  let text = `Pattern: "${pattern}" (${rows.length} files)\n\n${lines.join('\n\n')}`;
  if (text.length > MAX_OUTPUT_CHARS) {
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n… output truncated at ${MAX_OUTPUT_CHARS} chars. Use a smaller \`limit\` to narrow results.`;
  }

  return {
    content: [{
      type: 'text',
      text,
    }],
  };
}

export function registerPatternsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_patterns',
    'Find all files that use a specific architectural pattern. Patterns are extracted during atlas indexing (e.g., "orchestrator-facade", "TTL-cache", "Supabase-client-singleton"). Use to find files following a convention or antipattern.',
    {
      pattern: z.string().min(1),
      workspace: z.string().optional(),
      limit: z.coerce.number().int().optional(),
    },
    async (args: AtlasPatternsArgs) => runPatternsTool(runtime, args),
  );
}
