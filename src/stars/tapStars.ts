/**
 * Tap Stars — persistent cognitive waypoints for agent transcripts.
 *
 * Stars are short, categorized snippets an agent pins during work.
 * They serve two purposes:
 *   1. Ephemeral acknowledgment — without a category, just confirms the note.
 *   2. Rebirth injection — categorized stars auto-inject into handoff/rebirth
 *      packages so a successor sees a curated highlight reel.
 *
 * Storage: SQLite `starred_moments` table in the Home DB.
 * Mirrors voxxo-swarm's relay/src/persistence/tapStars.ts but uses SQLite
 * instead of JSONL files to match brain-mcp's storage patterns.
 */

import type Database from 'better-sqlite3';

/** Valid star categories — the curation signal that separates ephemeral from persistent. */
export const STAR_CATEGORIES = [
  'decision',
  'discovery',
  'pivot',
  'handoff',
  'gotcha',
  'result',
] as const;

export type StarCategory = (typeof STAR_CATEGORIES)[number];

export interface StarredMoment {
  /** Row ID in the database. */
  id?: number;
  /** Unix epoch ms when the star was created. */
  ts: number;
  /** Identity name that created the star. */
  identityName: string;
  /** Session ID that created the star. */
  sessionId?: string;
  /** Category — when present, this star is persistent (rebirth-injected). */
  category?: StarCategory;
  /** The snippet text (max 200 chars for categorized, max 120 for ephemeral). */
  note: string;
}

export const MAX_AMBIENT_NOTE_CHARS = 120;
export const MAX_CATEGORIZED_NOTE_CHARS = 200;
const MAX_STARS_PER_IDENTITY = 500;
const STAR_REEL_MAX_CHARS = 50_000;

/** Truncate a string to maxLen, avoiding splitting a surrogate pair. */
export function safeTruncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  const truncated = str.slice(0, maxLen);
  const lastCode = truncated.charCodeAt(maxLen - 1);
  // Don't split a surrogate pair.
  return lastCode >= 0xD800 && lastCode <= 0xDBFF ? truncated.slice(0, -1) : truncated;
}

/** Validate a category string. Returns the typed category or undefined. */
export function validateCategory(raw?: string): StarCategory | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  return (STAR_CATEGORIES as readonly string[]).includes(normalized)
    ? (normalized as StarCategory)
    : undefined;
}

/** Append a categorized star to the Home DB. Returns the stored moment. */
export function appendStar(
  db: InstanceType<typeof Database>,
  identityName: string,
  sessionId: string | undefined,
  note: string,
  category: StarCategory,
): StarredMoment {
  const trimmed = note.trim();
  const truncated = safeTruncate(trimmed, MAX_CATEGORIZED_NOTE_CHARS);
  const ts = Date.now();

  const result = db.prepare(`
    INSERT INTO starred_moments (identity_name, session_id, note, category, ts)
    VALUES (?, ?, ?, ?, ?)
  `).run(identityName, sessionId ?? null, truncated, category, ts);

  return {
    id: Number(result.lastInsertRowid),
    ts,
    identityName,
    sessionId,
    note: truncated,
    category,
  };
}

/** Load all stars for an identity. Returns newest-last, capped at MAX_STARS_PER_IDENTITY. */
export function loadStars(
  db: InstanceType<typeof Database>,
  identityName: string,
): StarredMoment[] {
  const rows = db.prepare(`
    SELECT id, identity_name, session_id, note, category, ts
    FROM starred_moments
    WHERE identity_name = ?
    ORDER BY ts ASC
    LIMIT ?
  `).all(identityName, MAX_STARS_PER_IDENTITY) as Array<{
    id: number;
    identity_name: string;
    session_id: string | null;
    note: string;
    category: string | null;
    ts: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    ts: row.ts,
    identityName: row.identity_name,
    sessionId: row.session_id ?? undefined,
    note: row.note,
    category: row.category ? validateCategory(row.category) : undefined,
  }));
}

/** Load only categorized (persistent) stars for rebirth/handoff injection. */
export function loadCategorizedStars(
  db: InstanceType<typeof Database>,
  identityName: string,
): StarredMoment[] {
  return loadStars(db, identityName).filter((s) => s.category);
}

// ── Formatting for rebirth injection ─────────────────────────────────

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatStarTimestamp(tsMs: number): string {
  const date = new Date(tsMs);
  if (Number.isNaN(date.getTime())) return String(tsMs);
  return [
    `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`,
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`,
  ].join(' ');
}

function formatStarLine(star: StarredMoment): string {
  const cat = star.category ? `[${star.category}]` : '';
  return `⭐ ${cat} ${star.note} (${formatStarTimestamp(star.ts)})`;
}

/**
 * Collect star lines that fit within a character budget.
 * Newest stars take priority — fills from the end and reverses.
 */
function collectStarReelLines(stars: StarredMoment[], maxChars: number): string[] {
  const keptLines: string[] = [];
  let remainingChars = Math.max(0, maxChars);

  for (let index = stars.length - 1; index >= 0; index--) {
    const line = formatStarLine(stars[index]);
    const lineCost = line.length + (keptLines.length > 0 ? 1 : 0);

    if (lineCost > remainingChars) {
      if (keptLines.length === 0 && remainingChars > 0) {
        keptLines.push(safeTruncate(line, remainingChars));
      }
      break;
    }

    keptLines.push(line);
    remainingChars -= lineCost;
  }

  return keptLines.reverse();
}

/** Format starred moments for rebirth/handoff package injection. Keeps newest stars that fit the budget. */
export function formatStarredMomentsForRebirth(
  stars: StarredMoment[],
  maxChars = STAR_REEL_MAX_CHARS,
): string {
  if (stars.length === 0) return '';
  const lines = collectStarReelLines(stars, maxChars);
  if (lines.length === 0) return '';

  return `\u{1F4CC} Starred Moments (${stars.length} persisted):\n${lines.join('\n')}`;
}
