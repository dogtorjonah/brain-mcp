import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RawTranscriptLine } from './types.js';

/**
 * Stream a Claude Code .jsonl transcript line by line. Bad JSON lines are
 * skipped silently — the transcript format is append-only and occasionally
 * contains partial writes mid-flush.
 */
export async function* streamTranscript(filePath: string): AsyncGenerator<RawTranscriptLine> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as RawTranscriptLine;
    } catch {
      // ignore malformed line
    }
  }
}

/** Load the full transcript into memory (typical sessions are a few MB). */
export async function loadTranscript(filePath: string): Promise<RawTranscriptLine[]> {
  const out: RawTranscriptLine[] = [];
  for await (const row of streamTranscript(filePath)) {
    out.push(row);
  }
  return out;
}
