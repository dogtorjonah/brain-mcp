import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { walkChainBack } from '../io/chain.js';

/**
 * Rebirth history tail — a per-cwd JSONL log of prior rebirths. Each build
 * appends one entry; the handoff renders the last N so the successor can
 * see "I've been reborn K times already, the last one was M minutes ago."
 *
 * Cadence signal matters because repeated rebirths often indicate the task
 * is stuck or the session is ambient-noisy: knowing the density lets the
 * successor calibrate its own behavior (slow down, ask for clarification,
 * pick a smaller sub-goal) rather than blindly continue.
 *
 * Storage is a single JSONL under ~/.claude/projects/<cwd-slug>/
 * so it lives next to the transcripts it summarizes and survives /clear.
 * JSONL append-only keeps writes atomic on any POSIX fs.
 */

export interface RebirthHistoryEntry {
  t: number; // epoch ms
  sessionId: string;
  bytes: number;
  trigger?: string;
}

const HISTORY_FILENAME = '.rebirth-history.jsonl';
const MAX_ENTRIES_KEPT = 200;

const FALLBACK_TAIL = 6;
const MAX_VISIBLE = 12;
const CHAIN_MAX_DEPTH = 20;

function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

function cwdToProjectSlug(cwd: string): string {
  return cwd.replaceAll('/', '-').replace(/^-/, '-');
}

export function historyPathForCwd(cwd: string): string {
  return join(claudeProjectsDir(), cwdToProjectSlug(cwd), HISTORY_FILENAME);
}

export async function appendRebirthHistory(
  cwd: string,
  entry: RebirthHistoryEntry,
): Promise<void> {
  const path = historyPathForCwd(cwd);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // History append is best-effort — a failed write must never prevent
    // the rebirth itself from returning to the caller.
  }
}

export function readRebirthHistory(cwd: string): RebirthHistoryEntry[] {
  const path = historyPathForCwd(cwd);
  if (!existsSync(path)) return [];
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const entries: RebirthHistoryEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as RebirthHistoryEntry;
      if (typeof parsed.t === 'number' && typeof parsed.sessionId === 'string') {
        entries.push(parsed);
      }
    } catch {
      // Skip malformed lines rather than failing the whole history read.
    }
  }
  return entries.slice(-MAX_ENTRIES_KEPT);
}

function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s after prior`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m after prior`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h after prior`;
  return `${Math.floor(h / 24)}d after prior`;
}

function formatTs(ms: number): string {
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
  } catch {
    return String(ms);
  }
}

export function renderRebirthHistory(
  cwd: string | undefined,
  currentSessionId?: string,
): string {
  if (!cwd) return '';
  const entries = readRebirthHistory(cwd);
  if (entries.length === 0) return '';

  // Cluster by session-chain membership (walkChainBack), NOT wall-clock
  // distance. Time windows break on stand-up-and-walk-away: a 3-hour AFK
  // between rebirths would otherwise drop entries that are part of the
  // same work thread. The chain is the ground truth for "this rebirth is a
  // continuation of that one" regardless of how long the user took between
  // them. Each rebirth writes a breadcrumb ~/.claude/rebirth-chain/<live>.json
  // = {prev: <resolved>}; history entries log the `resolved` sessionId
  // (the session we reborn FROM), so chain-filter = { sid : sid ∈ ancestors(current) }.
  let visible: RebirthHistoryEntry[] = [];
  let mode: 'chain' | 'tail' = 'tail';

  if (currentSessionId) {
    const chain = new Set(walkChainBack(currentSessionId, CHAIN_MAX_DEPTH));
    // Require depth ≥ 2 (start + at least one ancestor) to treat as a
    // real chain; a lone start-node means no breadcrumb was ever found.
    if (chain.size >= 2) {
      const chainFiltered = entries.filter((e) => chain.has(e.sessionId));
      if (chainFiltered.length > 0) {
        visible = chainFiltered;
        mode = 'chain';
      }
    }
  }

  // Fallback: no chain (or chain yielded zero matching history entries) —
  // show the last FALLBACK_TAIL entries. Count-based, AFK-agnostic.
  if (mode === 'tail' || visible.length === 0) {
    visible = entries.slice(-FALLBACK_TAIL);
    mode = 'tail';
  }

  // Hard cap so a 40-deep chain doesn't crowd the handoff budget.
  if (visible.length > MAX_VISIBLE) {
    visible = visible.slice(-MAX_VISIBLE);
  }

  const omitted = entries.length - visible.length;
  const modeLabel =
    mode === 'chain'
      ? 'chain-linked to current session'
      : `last ${visible.length}`;

  const lines: string[] = [
    '── Rebirth History (this project) ──',
    '',
    `Total rebirths recorded: ${entries.length}${omitted > 0 ? ` (showing ${visible.length} — ${modeLabel})` : ''}`,
    '',
  ];
  // Visible may be non-contiguous in chain mode (entries between chain
  // members are omitted from display). Look up absolute indices by
  // reference equality so #N labels stay consistent with the full log.
  // Cadence ("Xm after prior") references the TEMPORAL prior in the full
  // entries list — not the visible prior — so the "— 12m after prior"
  // label stays a true gap measurement even if the intervening entry is
  // hidden.
  visible.forEach((e) => {
    const absIdx = entries.indexOf(e);
    const prev = absIdx > 0 ? entries[absIdx - 1] : null;
    const cadence = prev ? ` — ${formatElapsedMs(e.t - prev.t)}` : ' — first recorded';
    const kb = e.bytes > 0 ? ` — ${(e.bytes / 1024).toFixed(1)}KB` : '';
    const trig = e.trigger ? ` — ${e.trigger}` : '';
    lines.push(`  #${absIdx + 1} ${formatTs(e.t)} — session=${e.sessionId.slice(0, 8)}${kb}${cadence}${trig}`);
  });
  lines.push('');
  return lines.join('\n');
}
