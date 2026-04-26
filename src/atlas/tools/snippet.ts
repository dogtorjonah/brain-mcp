import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { discoverWorkspaces } from './bridge.js';

interface WorkspaceContext {
  sourceRoot: string;
  workspace: string;
}

interface SymbolRange {
  startLine: number;
  endLine: number;
}

function resolveWorkspace(runtime: AtlasRuntime, workspace?: string): WorkspaceContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return { sourceRoot: runtime.config.sourceRoot, workspace: runtime.config.workspace };
  }
  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return { sourceRoot: target.sourceRoot, workspace: target.workspace };
}

function clampLine(value: number, max: number): number {
  return Math.max(1, Math.min(max, value));
}

function buildSymbolPatterns(symbol: string): RegExp[] {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?class\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?interface\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?type\\s+${escaped}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?enum\\s+${escaped}\\b`),
  ];
}

function findMatchingBraceEnd(source: string, openBracePos: number): number | null {
  let depth = 0;
  let inString: '"' | '\'' | '`' | null = null;
  let escaped = false;

  for (let i = openBracePos; i < source.length; i += 1) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (ch === inString) {
        inString = null;
      }
      continue;
    }

    if (ch === '"' || ch === '\'' || ch === '`') {
      inString = ch;
      continue;
    }

    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return null;
}

function toLineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function findSymbolRange(source: string, symbol: string): SymbolRange | null {
  const lines = source.split('\n');
  const patterns = buildSymbolPatterns(symbol);
  let startLine = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (patterns.some((pattern) => pattern.test(line))) {
      startLine = i + 1;
      break;
    }
  }
  if (startLine < 1) return null;

  const startOffset = source.split('\n').slice(0, startLine - 1).join('\n').length + (startLine > 1 ? 1 : 0);
  const segment = source.slice(startOffset);
  const braceRel = segment.indexOf('{');
  if (braceRel >= 0) {
    const braceAbs = startOffset + braceRel;
    const endOffset = findMatchingBraceEnd(source, braceAbs);
    if (endOffset != null) {
      return {
        startLine,
        endLine: toLineNumber(source, endOffset) + 1,
      };
    }
  }

  let endLine = startLine;
  for (let i = startLine; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (i > startLine && /^\s*(?:export\s+)?(?:async\s+)?(?:function|class)\b/.test(line)) break;
    if (line.trim() === '' && i > startLine) break;
    endLine = i + 1;
  }
  return { startLine, endLine };
}

export interface AtlasSnippetArgs {
  filePath: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
  workspace?: string;
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runSnippetTool(runtime: AtlasRuntime, {
  filePath,
  symbol,
  startLine,
  endLine,
  workspace,
}: AtlasSnippetArgs): Promise<AtlasToolTextResult> {
  const context = resolveWorkspace(runtime, workspace);
  if (!context) {
    return { content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }] };
  }

  const absolutePath = path.join(context.sourceRoot, filePath);
  let source: string;
  try {
    source = await fs.readFile(absolutePath, 'utf8');
  } catch {
    return { content: [{ type: 'text', text: `Unable to read ${filePath}.` }] };
  }

  const lines = source.split('\n');
  let from = startLine;
  let to = endLine;

  if (symbol && !from && !to) {
    const range = findSymbolRange(source, symbol);
    if (!range) {
      return { content: [{ type: 'text', text: `Symbol "${symbol}" not found in ${filePath}.` }] };
    }
    from = range.startLine;
    to = range.endLine;
  }

  const start = clampLine(from ?? 1, lines.length);
  const end = clampLine(to ?? Math.min(lines.length, start + 80), lines.length);
  const resolvedEnd = Math.max(start, end);
  const snippet = lines.slice(start - 1, resolvedEnd).join('\n');

  return {
    content: [{
      type: 'text',
      text: `# Snippet: ${filePath}:${start}-${resolvedEnd}${symbol ? ` (${symbol})` : ''}\n\`\`\`\n${snippet}\n\`\`\``,
    }],
  };
}

export function registerSnippetTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_snippet',
    'Extract exact source code snippets from a file by symbol name or line range. Provide a symbol name to get its full declaration, or startLine/endLine for a specific range. Returns code with line numbers.',
    {
      filePath: z.string().min(1),
      symbol: z.string().min(1).optional(),
      startLine: z.coerce.number().int().min(1).optional(),
      endLine: z.coerce.number().int().min(1).optional(),
      workspace: z.string().optional(),
    },
    async (args: AtlasSnippetArgs) => runSnippetTool(runtime, args),
  );
}
