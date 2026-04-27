import type { ReducedTranscript, ToolCall } from '../trace/types.js';

/**
 * "Files recently in context" — mines the reduced transcript for the last
 * N files Claude has touched (Read/Edit/Write) and surfaces:
 *   - every Edit diff as old_string → new_string
 *   - the last Read's head+tail for each file
 *   - path-only mentions for Grep/Glob hits
 *
 * The selection is deterministic and bounded by byteBudget so handoffs stay
 * predictable in size even for long sessions.
 */

export interface FileContextEntry {
  path: string;
  touchedAt: Date;
  editDiffs: Array<{ oldString: string; newString: string; replaceAll?: boolean }>;
  writeContent?: string;
  lastReadSnippet?: { fullLength: number; head: string; tail: string };
}

export interface FileContextOptions {
  maxFiles: number;
  headLines: number;
  tailLines: number;
  maxEntryBytes: number;
  byteBudget: number;
}

export const DEFAULT_FILE_CONTEXT: FileContextOptions = {
  maxFiles: 12,
  headLines: 40,
  tailLines: 40,
  maxEntryBytes: 8_000,
  byteBudget: 40_000,
};

function headTail(text: string, headLines: number, tailLines: number): { head: string; tail: string } {
  const lines = text.split('\n');
  if (lines.length <= headLines + tailLines) {
    return { head: lines.join('\n'), tail: '' };
  }
  const head = lines.slice(0, headLines).join('\n');
  const tail = lines.slice(-tailLines).join('\n');
  return { head, tail };
}

function truncate(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  // naive truncation to byte budget; good enough for ascii-heavy sources
  return text.slice(0, maxBytes) + '\n… [truncated]';
}

export function collectFileContext(
  reduced: ReducedTranscript,
  opts: FileContextOptions = DEFAULT_FILE_CONTEXT,
): FileContextEntry[] {
  const byPath = new Map<string, FileContextEntry>();

  const ensure = (path: string, ts: Date): FileContextEntry => {
    let e = byPath.get(path);
    if (!e) {
      e = { path, touchedAt: ts, editDiffs: [] };
      byPath.set(path, e);
    }
    if (ts > e.touchedAt) e.touchedAt = ts;
    return e;
  };

  // Walk tool calls in transcript order; last wins for "touchedAt" / "lastReadSnippet".
  for (const call of reduced.toolCalls) {
    const { use, result } = call;
    const inp = (use.input ?? {}) as Record<string, unknown>;
    const pathVal = typeof inp['file_path'] === 'string' ? (inp['file_path'] as string) : undefined;

    if (!pathVal) continue;

    if (use.name === 'Edit') {
      const entry = ensure(pathVal, use.timestamp);
      entry.editDiffs.push({
        oldString: typeof inp['old_string'] === 'string' ? (inp['old_string'] as string) : '',
        newString: typeof inp['new_string'] === 'string' ? (inp['new_string'] as string) : '',
        replaceAll: Boolean(inp['replace_all']),
      });
    } else if (use.name === 'Write') {
      const entry = ensure(pathVal, use.timestamp);
      if (typeof inp['content'] === 'string') {
        entry.writeContent = inp['content'] as string;
      }
    } else if (use.name === 'Read') {
      const entry = ensure(pathVal, use.timestamp);
      const text = result?.text ?? '';
      // Claude Code Reads come with `cat -n` line prefixes like "   42\tfoo".
      // Strip them so head/tail looks like the actual file.
      const cleaned = text
        .split('\n')
        .map((l) => l.replace(/^\s*\d+\t/, ''))
        .join('\n');
      const { head, tail } = headTail(cleaned, opts.headLines, opts.tailLines);
      entry.lastReadSnippet = { fullLength: cleaned.length, head, tail };
    }
  }

  // Newest-first, capped by maxFiles.
  const ordered = Array.from(byPath.values()).sort(
    (a, b) => b.touchedAt.getTime() - a.touchedAt.getTime(),
  );
  const capped = ordered.slice(0, opts.maxFiles);

  // Per-entry byte cap on the snippet, then global byte budget.
  let totalBytes = 0;
  const kept: FileContextEntry[] = [];
  for (const entry of capped) {
    if (entry.lastReadSnippet) {
      entry.lastReadSnippet.head = truncate(entry.lastReadSnippet.head, Math.floor(opts.maxEntryBytes / 2));
      entry.lastReadSnippet.tail = truncate(entry.lastReadSnippet.tail, Math.floor(opts.maxEntryBytes / 2));
    }
    if (entry.writeContent && entry.writeContent.length > opts.maxEntryBytes) {
      entry.writeContent = truncate(entry.writeContent, opts.maxEntryBytes);
    }
    const approxBytes = estimateEntryBytes(entry);
    if (totalBytes + approxBytes > opts.byteBudget && kept.length > 0) break;
    totalBytes += approxBytes;
    kept.push(entry);
  }
  return kept;
}

function estimateEntryBytes(e: FileContextEntry): number {
  let n = e.path.length + 64;
  for (const d of e.editDiffs) n += d.oldString.length + d.newString.length + 32;
  if (e.writeContent) n += e.writeContent.length;
  if (e.lastReadSnippet) n += e.lastReadSnippet.head.length + e.lastReadSnippet.tail.length;
  return n;
}

/**
 * Scan every tool_result body for absolute-looking file paths and return
 * the distinct set, newest-call-first, excluding paths already surfaced as
 * edited/read in the primary FileContext list. Catches paths mentioned by
 * MCP tools (atlas queries, grep-style tools, etc.) that the Read/Edit/Write
 * tracker wouldn't otherwise notice — these are often the files the
 * successor will want to open next.
 */
const NOISE_PATH_PREFIXES = [
  '/tmp/',
  '/var/tmp/',
  '/var/folders/',
  '/proc/',
  '/sys/',
  '/dev/',
  '/run/',
];

function isNoisePath(p: string): boolean {
  for (const pre of NOISE_PATH_PREFIXES) {
    if (p.startsWith(pre)) return true;
  }
  return false;
}

export function collectFileReferences(
  reduced: ReducedTranscript,
  excludePaths: Set<string>,
  max = 30,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Require absolute path + an extension (1–6 chars). Keeps false-positive
  // rate low on prose containing "/foo/bar" directory mentions.
  const re = /(?:^|[\s(),"'`])(\/(?:[^\s()"'`,<>]+)\.[a-zA-Z0-9]{1,6})(?=[\s)"'`,.:;<>]|$)/g;
  for (let i = reduced.toolCalls.length - 1; i >= 0; i--) {
    const call = reduced.toolCalls[i];
    const text = call?.result?.text;
    if (!text) continue;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const p = m[1];
      if (!p || seen.has(p) || excludePaths.has(p) || isNoisePath(p)) continue;
      seen.add(p);
      out.push(p);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/** Summarise Grep/Glob calls into a compact paragraph. */
export function searchFootprint(reduced: ReducedTranscript, maxEntries = 8): string[] {
  const lines: string[] = [];
  const relevant: ToolCall[] = reduced.toolCalls.filter(
    (c) => c.use.name === 'Grep' || c.use.name === 'Glob',
  );
  const recent = relevant.slice(-maxEntries);
  for (const call of recent) {
    const inp = (call.use.input ?? {}) as Record<string, unknown>;
    if (call.use.name === 'Grep') {
      const pattern = typeof inp['pattern'] === 'string' ? inp['pattern'] : '';
      const path = typeof inp['path'] === 'string' ? ` in ${inp['path']}` : '';
      const hits = call.result?.text ? call.result.text.split('\n').length : 0;
      lines.push(`Grep /${pattern}/${path} → ~${hits} hits`);
    } else {
      const pattern = typeof inp['pattern'] === 'string' ? inp['pattern'] : '';
      lines.push(`Glob ${pattern}`);
    }
  }
  return lines;
}
