import type { NormalizedEvent, ToolCall } from '../trace/types.js';

/**
 * Gradient zoning: chronologically the newest events get full fidelity;
 * older events get progressively less detail. The zone assignments let
 * the activity-log renderer emit a recency-weighted summary so a new
 * session orients on current signal without drowning in old tool-call
 * noise.
 */

export interface GradientConfig {
  hotCount: number;   // full-detail
  warmCount: number;  // snippet (~1 line)
  // everything older = cold (breadcrumb: just the kind + timestamp)
}

export const DEFAULT_GRADIENT: GradientConfig = {
  hotCount: 12,
  warmCount: 40,
};

export type Zone = 'hot' | 'warm' | 'cold';

export function assignZones(events: NormalizedEvent[], cfg: GradientConfig = DEFAULT_GRADIENT): Zone[] {
  const n = events.length;
  const zones: Zone[] = new Array(n).fill('cold');
  const hotStart = Math.max(0, n - cfg.hotCount);
  const warmStart = Math.max(0, n - cfg.hotCount - cfg.warmCount);
  for (let i = warmStart; i < hotStart; i++) zones[i] = 'warm';
  for (let i = hotStart; i < n; i++) zones[i] = 'hot';
  return zones;
}

/**
 * Per-zone caps on tool_result payload rendering, plus a global budget to
 * keep the activity log from ballooning when a session is dense with tool
 * calls. Small results (<= smallBypassBytes) always render in full
 * regardless of zone — they're cheap and often diagnostic (empty counts,
 * short error strings, one-line confirmations).
 */
export interface ToolResultBudget {
  hotBytes: number;
  warmBytes: number;
  smallBypassBytes: number;
  globalBudget: number;
}

export const DEFAULT_TOOL_RESULT_BUDGET: ToolResultBudget = {
  hotBytes: 2_000,
  warmBytes: 500,
  smallBypassBytes: 200,
  globalBudget: 8_000,
};

/**
 * Decide how many bytes of result payload each tool_result event gets.
 * Returns a parallel array to `events`; entries that are not tool_result
 * events (or whose result text is empty) get 0.
 *
 * Allocation proceeds in three phases:
 *   1. Zone-based initial caps + small-result bypass
 *   2. If total > globalBudget: demote hot→warm (oldest first)
 *   3. If still over: drop warm entries to 0 (oldest first)
 *
 * Small-bypass entries are never demoted — they're already tiny, and the
 * diagnostic value per byte is high.
 */
export function allocateToolResultBytes(
  events: NormalizedEvent[],
  zones: Zone[],
  budget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET,
): number[] {
  const alloc: number[] = new Array(events.length).fill(0);
  const textBytes: number[] = new Array(events.length).fill(0);

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev || ev.kind !== 'tool_result') continue;
    const bytes = Buffer.byteLength(ev.text, 'utf8');
    if (bytes === 0) continue;
    textBytes[i] = bytes;
    const zone = zones[i];
    let cap = zone === 'hot' ? budget.hotBytes : zone === 'warm' ? budget.warmBytes : 0;
    if (bytes <= budget.smallBypassBytes) cap = Math.max(cap, bytes);
    alloc[i] = Math.min(cap, bytes);
  }

  const total = () => alloc.reduce<number>((a, b) => a + b, 0);

  // Phase 2: demote hot → warm (oldest first).
  if (total() > budget.globalBudget) {
    for (let i = 0; i < events.length; i++) {
      if (total() <= budget.globalBudget) break;
      if (textBytes[i] === 0 || textBytes[i]! <= budget.smallBypassBytes) continue;
      if (alloc[i]! > budget.warmBytes) {
        alloc[i] = Math.min(budget.warmBytes, textBytes[i]!);
      }
    }
  }

  // Phase 3: drop warm → 0 (oldest first).
  if (total() > budget.globalBudget) {
    for (let i = 0; i < events.length; i++) {
      if (total() <= budget.globalBudget) break;
      if (textBytes[i] === 0 || textBytes[i]! <= budget.smallBypassBytes) continue;
      if (alloc[i]! > 0 && alloc[i]! <= budget.warmBytes) {
        alloc[i] = 0;
      }
    }
  }

  return alloc;
}

/** Best-effort one-line summary of a tool call for warm-zone rendering. */
export function summarizeToolCall(call: ToolCall, maxLen = 120): string {
  const { name, input } = call.use;
  const inp = input ?? {};
  const get = (k: string): string | undefined => {
    const v = (inp as Record<string, unknown>)[k];
    return typeof v === 'string' ? v : undefined;
  };
  switch (name) {
    case 'Read':
      return `Read ${get('file_path') ?? ''}`.slice(0, maxLen);
    case 'Edit':
      return `Edit ${get('file_path') ?? ''}`.slice(0, maxLen);
    case 'Write':
      return `Write ${get('file_path') ?? ''}`.slice(0, maxLen);
    case 'Bash': {
      const cmd = get('command') ?? '';
      return `Bash: ${cmd}`.slice(0, maxLen);
    }
    case 'Grep':
      return `Grep /${get('pattern') ?? ''}/${get('path') ? ' in ' + get('path') : ''}`.slice(0, maxLen);
    case 'Glob':
      return `Glob ${get('pattern') ?? ''}`.slice(0, maxLen);
    case 'WebSearch':
      return `WebSearch "${get('query') ?? ''}"`.slice(0, maxLen);
    case 'WebFetch':
      return `WebFetch ${get('url') ?? ''}`.slice(0, maxLen);
    case 'TodoWrite':
      return `TodoWrite`;
    default: {
      // Unknown tool — show first string arg if any.
      const firstStr = Object.values(inp).find((v) => typeof v === 'string') as string | undefined;
      return firstStr ? `${name} ${firstStr}`.slice(0, maxLen) : name;
    }
  }
}
