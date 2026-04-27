import type { NormalizedEvent } from './types.js';

/**
 * Extract the most recently set /effort level from a reduced event stream.
 * Returns null when the user never ran /effort in this chain (meaning the
 * replacement process should inherit whatever its CLI default is, which is
 * Claude Code's built-in "medium" for interactive sessions).
 *
 * Detection reads the synthetic user stream — /effort's stdout lands as a
 * `<local-command-stdout>Set effort level to <level> ...</local-command-stdout>`
 * block inside a user row. Those rows are `synthetic=true` in our reduced
 * form, so they don't show up in `userMessages`, but they're still present
 * in the raw `events` array. We walk backward to honor the user's latest
 * choice, not the first one.
 *
 * Valid levels per `claude --effort <level>`: low | medium | high | xhigh | max.
 * We accept any identifier Claude Code emits to stay forward-compatible with
 * new levels, but the wrapper only passes it through if it matches this set.
 */
const VALID_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function detectLastEffortLevel(events: NormalizedEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind !== 'user_text') continue;
    const m = e.text.match(/Set effort level to (\w+)/);
    if (!m || !m[1]) continue;
    const level = m[1].toLowerCase();
    if (VALID_LEVELS.has(level)) return level;
  }
  return null;
}

export function isValidEffortLevel(level: string): boolean {
  return VALID_LEVELS.has(level.toLowerCase());
}
