/**
 * Fold a reduced transcript event stream into chunks suitable for retrieval.
 *
 * One chunk = one semantic unit:
 *   - user_text event → one chunk
 *   - assistant_text event → one chunk
 *   - tool_use event paired with its tool_result → one chunk (combined text)
 *   - hook event → one chunk
 *
 * Thinking events (encrypted, content-free) are skipped.
 *
 * Metadata is folded into the chunk text at indexing time using a tagged
 * prefix — `[kind] tool:name file:/path actual text…`. This means the BM25
 * tokenizer indexes the metadata alongside the body, so queries like
 * "Bash grep engine.ts" or "tool_use Edit" hit relevant chunks without a
 * separate metadata scorer. Dense embeddings see the same prefix so the
 * semantic side also gets the metadata context for free.
 */

import { createHash } from 'node:crypto';
import type {
  NormalizedEvent,
  ToolCall,
  ToolUseEvent,
  ToolResultEvent,
} from '../trace/types.js';

export type ChunkKind = 'user' | 'assistant' | 'tool_call' | 'hook';

export interface Chunk {
  /** Globally unique chunk id: `${sessionId}:${ordinal}`. Stable across re-indexes. */
  chunkId: string;
  sessionId: string;
  cwdSlug: string;
  kind: ChunkKind;
  /** Tool name for tool_call chunks; undefined otherwise. */
  toolName?: string;
  /** File paths the chunk references (pulled from tool inputs / Read results). */
  filePaths: string[];
  /** Epoch ms — used for recency-weighted ordering at query time. */
  timestampMs: number;
  /** The indexable body (metadata prefix + event text). */
  text: string;
  /** Hash of `text` — drives embedding dedup on re-index. */
  textHash: string;
  /** Absolute path of the source .jsonl this chunk came from. */
  sourcePath: string;
}

const MAX_CHUNK_CHARS = 6000;

/**
 * Build chunks from an ordered event stream. Tool use/result pairing is
 * done here rather than relying on the reducer's ToolCall index so we keep
 * the original event ordinal for deterministic chunkId generation.
 */
export function buildChunks(opts: {
  events: NormalizedEvent[];
  sessionId: string;
  cwdSlug: string;
  sourcePath: string;
}): Chunk[] {
  const { events, sessionId, cwdSlug, sourcePath } = opts;
  const chunks: Chunk[] = [];

  // Pair tool_use with its tool_result via toolUseId lookup.
  const resultByUseId = new Map<string, ToolResultEvent>();
  for (const ev of events) {
    if (ev.kind === 'tool_result') resultByUseId.set(ev.toolUseId, ev);
  }

  // Track which tool_use event_indexes have been consumed as part of a pair
  // so we don't double-emit a tool_result chunk.
  const consumedResultIds = new Set<string>();

  events.forEach((ev, ordinal) => {
    const chunkId = `${sessionId}:${ordinal}`;
    const baseTs = ev.timestamp instanceof Date ? ev.timestamp.getTime() : 0;

    if (ev.kind === 'user_text') {
      // Synthetic user frames (tool_result wrappers, system reminders)
      // carry signal — a stale hook payload can be the exact needle a
      // successor is looking for. Keep them, tagged.
      const prefix = ev.synthetic ? '[synthetic]' : '[user]';
      const body = truncate(ev.text, MAX_CHUNK_CHARS);
      chunks.push(makeChunk({
        chunkId, sessionId, cwdSlug, kind: 'user',
        text: `${prefix} ${body}`,
        filePaths: [], timestampMs: baseTs, sourcePath,
      }));
      return;
    }

    if (ev.kind === 'assistant_text') {
      const body = truncate(ev.text, MAX_CHUNK_CHARS);
      chunks.push(makeChunk({
        chunkId, sessionId, cwdSlug, kind: 'assistant',
        text: `[assistant] ${body}`,
        filePaths: [], timestampMs: baseTs, sourcePath,
      }));
      return;
    }

    if (ev.kind === 'tool_use') {
      const result = resultByUseId.get(ev.id);
      if (result) consumedResultIds.add(ev.id);
      const paths = extractFilePaths(ev, result);
      const pathsPrefix = paths.length > 0 ? `file:${paths.join(' file:')} ` : '';
      const useText = formatToolInput(ev);
      const resultText = result
        ? truncate(result.text, Math.floor(MAX_CHUNK_CHARS / 2))
        : '';
      const errorTag = result?.isError ? '[error] ' : '';
      const combined = result
        ? `[tool_call] ${errorTag}tool:${ev.name} ${pathsPrefix}args: ${useText}\nresult: ${resultText}`
        : `[tool_call] tool:${ev.name} ${pathsPrefix}args: ${useText}`;
      chunks.push(makeChunk({
        chunkId, sessionId, cwdSlug, kind: 'tool_call',
        toolName: ev.name,
        text: truncate(combined, MAX_CHUNK_CHARS),
        filePaths: paths, timestampMs: baseTs, sourcePath,
      }));
      return;
    }

    if (ev.kind === 'tool_result') {
      // Orphan tool_result (its tool_use wasn't in the event stream —
      // shouldn't happen in practice, but defensive). Emit as standalone.
      if (consumedResultIds.has(ev.toolUseId)) return;
      const paths = ev.file?.path ? [ev.file.path] : [];
      const pathsPrefix = paths.length > 0 ? `file:${paths.join(' file:')} ` : '';
      const errorTag = ev.isError ? '[error] ' : '';
      chunks.push(makeChunk({
        chunkId, sessionId, cwdSlug, kind: 'tool_call',
        text: `[tool_result] ${errorTag}${pathsPrefix}${truncate(ev.text, MAX_CHUNK_CHARS)}`,
        filePaths: paths, timestampMs: baseTs, sourcePath,
      }));
      return;
    }

    if (ev.kind === 'hook') {
      const body = ev.stdout ?? '';
      if (!body.trim()) return;
      chunks.push(makeChunk({
        chunkId, sessionId, cwdSlug, kind: 'hook',
        text: `[hook] ${ev.hookEvent}${ev.hookName ? `:${ev.hookName}` : ''} ${truncate(body, MAX_CHUNK_CHARS)}`,
        filePaths: [], timestampMs: baseTs, sourcePath,
      }));
      return;
    }

    // assistant_thinking events: no extractable content, skip.
  });

  return chunks;
}

function makeChunk(input: Omit<Chunk, 'textHash' | 'toolName' | 'filePaths'> & {
  toolName?: string;
  filePaths?: string[];
}): Chunk {
  const textHash = createHash('sha256').update(input.text).digest('hex').slice(0, 16);
  return {
    chunkId: input.chunkId,
    sessionId: input.sessionId,
    cwdSlug: input.cwdSlug,
    kind: input.kind,
    toolName: input.toolName,
    filePaths: input.filePaths ?? [],
    timestampMs: input.timestampMs,
    text: input.text,
    textHash,
    sourcePath: input.sourcePath,
  };
}

function formatToolInput(use: ToolUseEvent): string {
  try {
    return JSON.stringify(use.input).slice(0, 2000);
  } catch {
    return '';
  }
}

function extractFilePaths(use: ToolUseEvent, result?: ToolResultEvent): string[] {
  const paths = new Set<string>();
  const input = use.input ?? {};
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path']) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) paths.add(v);
  }
  const paths2 = (input as Record<string, unknown>)['paths'];
  if (Array.isArray(paths2)) {
    for (const v of paths2) if (typeof v === 'string') paths.add(v);
  }
  if (result?.file?.path) paths.add(result.file.path);
  return Array.from(paths);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…[truncated]';
}
