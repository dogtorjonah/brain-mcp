import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ChainLink {
  /** The predecessor session this session inherited context from. */
  prev: string;
  /** ISO timestamp the link was written. */
  ts: string;
  /** Optional workspace cwd at inheritance time. */
  cwd?: string;
}

export function chainDir(): string {
  const brainHome = process.env.BRAIN_HOME?.trim() || join(homedir(), '.brain');
  return join(brainHome, 'session-chain');
}

function legacyRebirthChainDir(): string {
  return join(homedir(), '.claude', 'rebirth-chain');
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function chainFilePath(sessionId: string, dir = chainDir()): string {
  return join(dir, `${safeSessionId(sessionId)}.json`);
}

export function writeChainLink(
  fromSessionId: string,
  prevSessionId: string,
  cwd?: string,
): boolean {
  if (!fromSessionId || !prevSessionId || fromSessionId === prevSessionId) return false;
  try {
    const dir = chainDir();
    mkdirSync(dir, { recursive: true });
    const link: ChainLink = {
      prev: prevSessionId,
      ts: new Date().toISOString(),
      ...(cwd ? { cwd } : {}),
    };
    writeFileSync(chainFilePath(fromSessionId, dir), JSON.stringify(link), 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function readChainLink(sessionId: string): ChainLink | null {
  return readChainLinkFrom(chainFilePath(sessionId))
    ?? readChainLinkFrom(chainFilePath(sessionId, legacyRebirthChainDir()));
}

function readChainLinkFrom(filePath: string): ChainLink | null {
  if (!existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.prev !== 'string' || !obj.prev) return null;
    return {
      prev: obj.prev,
      ts: typeof obj.ts === 'string' ? obj.ts : '',
      ...(typeof obj.cwd === 'string' ? { cwd: obj.cwd } : {}),
    };
  } catch {
    return null;
  }
}

export function extractPredecessorFromTranscript(
  transcriptPath: string,
  currentSessionId: string,
  maxRows = 50,
): string | null {
  if (!existsSync(transcriptPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, 'utf8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');
  const limit = Math.min(lines.length, maxRows);
  for (let i = 0; i < limit; i += 1) {
    const line = lines[i];
    if (!line?.trim() || !line.includes('[CONTEXT REBIRTH]')) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== 'user') continue;

    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          text += String((part as Record<string, unknown>).text ?? '');
        }
      }
    }

    if (!text.includes('[CONTEXT REBIRTH]')) continue;
    const match = /\n\s*Session:\s*([0-9a-fA-F-]{8,})\s*(?:\n|$)/.exec(text);
    const predecessor = match?.[1]?.trim();
    if (!predecessor || predecessor === currentSessionId) return null;
    return predecessor;
  }

  return null;
}

export function walkChainBack(startSessionId: string, maxDepth = 20): string[] {
  if (!startSessionId) return [];
  const seen = new Set<string>();
  const ordered: string[] = [];
  let cursor: string | undefined = startSessionId;
  let depth = 0;

  while (cursor && !seen.has(cursor) && depth < maxDepth) {
    seen.add(cursor);
    ordered.push(cursor);
    cursor = readChainLink(cursor)?.prev;
    depth += 1;
  }

  return ordered.reverse();
}
