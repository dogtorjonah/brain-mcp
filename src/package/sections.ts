import type {
  AssistantTextEvent,
  NormalizedEvent,
  ReducedTranscript,
  ToolUseEvent,
  UserTextEvent,
} from '../trace/types.js';
import {
  allocateToolResultBytes,
  assignZones,
  summarizeToolCall,
  DEFAULT_TOOL_RESULT_BUDGET,
  type GradientConfig,
  type ToolResultBudget,
} from './gradient.js';
import type { FileContextEntry } from './fileContext.js';

/**
 * Renderers for each section of the handoff package. Every renderer returns
 * a markdown string that the top-level builder concatenates with thematic
 * section dividers. Section order and visual contract (emoji markers,
 * box-drawing dividers, HH:MM timestamps) are load-bearing — the successor
 * reads freshest human signal first, then works back into investigation
 * chronology.
 */

function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 5);
}

function fmtDateTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function calendarDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Return the first sentence (up to a sentence-ending punctuation followed
 * by whitespace or EOS), falling back to a hard character slice if no
 * sentence boundary is found within maxLen. Used for warm-line previews
 * so snippets read as natural clauses instead of mid-word truncations.
 */
function firstSentence(text: string, maxLen = 160): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed.length <= maxLen) return trimmed;
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  if (match && match[1] && match[1].length <= maxLen) return match[1];
  return trimmed.slice(0, maxLen) + '…';
}

function trimToLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  const elided = lines.length - maxLines;
  return lines.slice(0, maxLines).join('\n') + `\n… [+${elided} line${elided === 1 ? '' : 's'} elided]`;
}

function trimToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  const total = Buffer.byteLength(text, 'utf8');
  if (total <= maxBytes) return text;
  // Slice by bytes, then back off to a codepoint boundary so we don't split a
  // multi-byte UTF-8 sequence mid-rune.
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes);
  let safe = buf.toString('utf8');
  if (safe.endsWith('�')) safe = safe.slice(0, -1);
  const remaining = total - Buffer.byteLength(safe, 'utf8');
  return safe + `\n… [truncated, ${remaining} more bytes]`;
}

function isHistoricalResetPrompt(text: string): boolean {
  // Anchor slash-commands to line-start so organic prose that mentions
  // "/compact" inside a sentence doesn't get mistaken for the transport
  // invocation and elided from the handoff.
  return text.includes('[CONTEXT REBIRTH]')
    || /(?:^|\n)\s*\/(?:rebirth(?:-respawn)?|clear|compact)\b/.test(text);
}

function isConsumedTransportUserPrompt(text: string): boolean {
  const trimmed = text.trim();
  return isHistoricalResetPrompt(trimmed)
    || trimmed.includes('Call the `rebirth` MCP tool with:')
    || trimmed.includes('trigger: "slash-rebirth-respawn"')
    || trimmed.includes('rebirth({ emit:')
    || trimmed.includes('rebirth --emit ');
}

function sanitizeHookStdout(stdout: string): string {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return stdout;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const prompt = typeof parsed['prompt'] === 'string' ? parsed['prompt'] : null;
    if (prompt && isHistoricalResetPrompt(prompt)) {
      return JSON.stringify(
        {
          ...parsed,
          prompt: '[elided historical rebirth/reset prompt to avoid handoff loops]',
        },
        null,
        2,
      );
    }
  } catch {
    // Not JSON — fall back to plain-text inspection below.
  }

  return isHistoricalResetPrompt(trimmed)
    ? '[elided historical rebirth/reset prompt to avoid handoff loops]'
    : stdout;
}

// --- Last user + AI message ------------------------------------------------

export function renderLastMessages(reduced: ReducedTranscript, maxPairs = 5): string {
  const users = reduced.userMessages.filter(
    (m) => m.text.trim().length > 0 && !isConsumedTransportUserPrompt(m.text),
  );
  const ais = reduced.assistantMessages.filter((m) => m.text.trim().length > 0);

  // Pair each user turn with the first AI turn that follows it in time.
  // Walk newest-first so we take the most recent N pairs.
  const pairs: Array<{ user: typeof users[number]; ai: typeof ais[number] | null }> = [];
  const aiByTime = [...ais].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (let i = users.length - 1; i >= 0 && pairs.length < maxPairs; i--) {
    const u = users[i];
    if (!u) continue;
    const reply = aiByTime.find(
      (a) => a.timestamp.getTime() > u.timestamp.getTime(),
    ) ?? null;
    pairs.push({ user: u, ai: reply });
  }
  pairs.reverse(); // oldest → newest for display

  const parts: string[] = [];

  // ── Freshest Turn (most recent pair, emphasized) ──────────────────────
  // Split from prior context into its own section because the very last
  // exchange before rebirth is "what you pick up from" — the successor's
  // eye should land on it first, not have to scroll through context to
  // find it. Prior pairs follow below as "warm-up" evidence for the
  // current trajectory, but the emphasis is carried by the section break.
  const freshest = pairs.length > 0 ? pairs[pairs.length - 1] : null;
  const prior = pairs.length > 1 ? pairs.slice(0, pairs.length - 1) : [];

  if (freshest) {
    parts.push('── Freshest Turn (READ FIRST) ──');
    parts.push(
      '***The most recent human/AI exchange before rebirth capture — this is what you\'re picking up from.***',
    );
    parts.push('');
    parts.push(`👤 USER  [${fmtTime(freshest.user.timestamp)}]`);
    parts.push(trimToLines(freshest.user.text.trim(), 160));
    parts.push('');
    if (freshest.ai) {
      parts.push(`🤖 AI  [${fmtTime(freshest.ai.timestamp)}]`);
      parts.push(trimToLines(freshest.ai.text.trim(), 160));
      parts.push('');
    }
  }

  // ── Prior Turns (earlier context, oldest → newest) ───────────────────
  // Up to four earlier pairs, giving the successor enough runway to
  // see "how did we arrive at the freshest turn" without forcing them
  // to scroll to Current Thread / Activity Log for the answer.
  if (prior.length > 0) {
    parts.push(`── Prior Turns (${prior.length} earlier pair${prior.length === 1 ? '' : 's'}, oldest → newest) ──`);
    parts.push('');
    for (const { user, ai } of prior) {
      parts.push(`👤 USER  [${fmtTime(user.timestamp)}]`);
      parts.push(trimToLines(user.text.trim(), 160));
      parts.push('');
      if (ai) {
        parts.push(`🤖 AI  [${fmtTime(ai.timestamp)}]`);
        parts.push(trimToLines(ai.text.trim(), 160));
        parts.push('');
      }
    }
  }

  return parts.join('\n');
}

// --- Current thread --------------------------------------------------------

export function renderCurrentThread(reduced: ReducedTranscript, maxTurns = 8): string {
  const turns: Array<UserTextEvent | AssistantTextEvent> = [];
  for (const ev of reduced.events) {
    if (
      ev.kind === 'user_text'
      && !ev.synthetic
      && ev.text.trim().length > 0
      && !isConsumedTransportUserPrompt(ev.text)
    ) {
      turns.push(ev);
    }
    else if (ev.kind === 'assistant_text' && ev.text.trim().length > 0) turns.push(ev);
  }
  const recent = turns.slice(-maxTurns);
  // Dedupe the single newest assistant turn against Last AI Message, which
  // already rendered its body in full above. Repeating it here costs bytes
  // and adds no signal — just point back at the anchor.
  const lastAi = [...reduced.assistantMessages]
    .reverse()
    .find((m) => m.text.trim().length > 0);
  const parts: string[] = ['── Current Thread ──', ''];
  for (const t of recent) {
    const who = t.kind === 'user_text' ? '👤 USER' : '🤖 AI';
    parts.push(`[${fmtTime(t.timestamp)}] ${who}:`);
    if (
      t.kind === 'assistant_text'
      && lastAi
      && t.timestamp.getTime() === lastAi.timestamp.getTime()
      && t.text.trim() === lastAi.text.trim()
    ) {
      parts.push('(same as Last AI Message above)');
    } else {
      parts.push(trimToLines(t.text.trim(), 20));
    }
    parts.push('');
  }
  return parts.join('\n');
}

// --- Active Edit Delta -----------------------------------------------------

export function renderEditDelta(fileContext: FileContextEntry[], maxFiles = 6): string {
  const withEdits = fileContext.filter((e) => e.editDiffs.length > 0 || e.writeContent !== undefined);
  if (withEdits.length === 0) {
    return '── Active Edit Delta ──\n\n(no in-flight edits detected)\n';
  }
  const parts: string[] = ['── Active Edit Delta ──', ''];
  for (const entry of withEdits.slice(0, maxFiles)) {
    parts.push(`[${fmtTime(entry.touchedAt)}] ${entry.path}`);
    for (const diff of entry.editDiffs) {
      parts.push('  ⊖ ' + trimToLines(diff.oldString, 30).split('\n').join('\n    '));
      parts.push('  ⊕ ' + trimToLines(diff.newString, 30).split('\n').join('\n    '));
      parts.push('');
    }
    if (entry.writeContent !== undefined) {
      parts.push(`  ✎ Write (full file, ${entry.writeContent.length} bytes):`);
      parts.push('    ' + trimToLines(entry.writeContent, 20).split('\n').join('\n    '));
      parts.push('');
    }
  }
  return parts.join('\n');
}

// --- Files recently in context --------------------------------------------

export function renderFileContext(fileContext: FileContextEntry[]): string {
  if (fileContext.length === 0) return '';
  const parts: string[] = ['── Files Recently in Context ──', ''];
  for (const entry of fileContext) {
    const verb = entry.editDiffs.length > 0
      ? 'Edit'
      : entry.writeContent !== undefined
        ? 'Write'
        : 'Read';
    parts.push(`📄 ${entry.path}  [${verb}, ${fmtTime(entry.touchedAt)}]`);
    if (entry.lastReadSnippet) {
      const { fullLength, head, tail } = entry.lastReadSnippet;
      parts.push(`   Last Read snapshot (${fullLength} chars):`);
      parts.push('   ┌── head');
      parts.push(head.split('\n').map((l) => '   │ ' + l).join('\n'));
      if (tail) {
        parts.push('   ├── tail');
        parts.push(tail.split('\n').map((l) => '   │ ' + l).join('\n'));
      }
      parts.push('   └──');
    }
    parts.push('');
  }
  return parts.join('\n');
}

// --- Files referenced (mined from tool-result bodies) --------------------

export function renderFileReferences(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts: string[] = [
    '── Files Referenced (mentioned in tool results) ──',
    '',
    `${paths.length} path${paths.length === 1 ? '' : 's'} surfaced by MCP/search tools (not read or edited):`,
    '',
  ];
  for (const p of paths) parts.push(`📎 ${p}`);
  parts.push('');
  return parts.join('\n');
}

// --- Activity log ----------------------------------------------------------

const COLD_BUCKET_MAX_EVENTS = 25;

interface ColdBucketEntry {
  ev: NormalizedEvent;
  ts: Date;
}

interface ColdBucket {
  entries: ColdBucketEntry[];
  startTs: Date;
}

/**
 * Pass-through events keep their normal cold rendering even when inside a
 * cold run: errors need verbatim preview so silent failures don't hide,
 * real user turns are load-bearing context shifts (and anchor "what
 * happened after" semantics), hooks are rare and cheap enough to print.
 * Each pass-through also flushes the active bucket so the summary cleanly
 * bounds before them.
 */
function isColdPassthrough(ev: NormalizedEvent): boolean {
  if (ev.kind === 'user_text' && !ev.synthetic) return true;
  if (ev.kind === 'tool_result' && ev.isError) return true;
  if (ev.kind === 'hook') return true;
  return false;
}

/**
 * Longest common directory prefix across a bucket's file-bearing tool
 * inputs. Returns null when the bucket's files are scattered (LCP
 * collapses to '' or to bare '/'). Used only for the "mostly" clause on
 * the bucket summary line — a null result just omits the clause.
 */
function commonDirPrefix(paths: string[]): string | null {
  if (paths.length === 0) return null;
  let lcp = paths[0]!;
  for (let i = 1; i < paths.length; i++) {
    const p = paths[i]!;
    let j = 0;
    while (j < lcp.length && j < p.length && lcp[j] === p[j]) j++;
    lcp = lcp.slice(0, j);
    if (lcp.length === 0) return null;
  }
  const lastSlash = lcp.lastIndexOf('/');
  if (lastSlash < 1) return null;
  const dir = lcp.slice(0, lastSlash + 1);
  if (dir === '/') return null;
  return dir;
}

function summarizeColdBucket(bucket: ColdBucket): string {
  if (bucket.entries.length === 0) return '';
  const first = bucket.entries[0]!.ts;
  const last = bucket.entries[bucket.entries.length - 1]!.ts;
  const timeRange =
    first.getTime() === last.getTime()
      ? fmtTime(first)
      : `${fmtTime(first)}–${fmtTime(last)}`;

  const toolCounts = new Map<string, number>();
  let userTurns = 0;
  let aiTurns = 0;
  let thoughts = 0;
  let syntheticUsers = 0;
  const filePaths: string[] = [];

  for (const { ev } of bucket.entries) {
    switch (ev.kind) {
      case 'user_text':
        if (ev.synthetic) syntheticUsers++;
        else userTurns++;
        break;
      case 'assistant_text':
        aiTurns++;
        break;
      case 'assistant_thinking':
        if (ev.hasContent) thoughts++;
        break;
      case 'tool_use': {
        toolCounts.set(ev.name, (toolCounts.get(ev.name) ?? 0) + 1);
        const inp = (ev.input ?? {}) as Record<string, unknown>;
        const fp = inp['file_path'] ?? inp['path'] ?? inp['notebook_path'];
        if (typeof fp === 'string') filePaths.push(fp);
        break;
      }
      case 'tool_result':
      case 'hook':
        // tool_result rides with its paired tool_use count; hooks are pass-through.
        break;
    }
  }

  const clauses: string[] = [];
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (topTools.length > 0) {
    clauses.push(topTools.map(([n, c]) => `${c}× ${n}`).join(', '));
  }
  if (aiTurns > 0) clauses.push(`${aiTurns} AI turn${aiTurns === 1 ? '' : 's'}`);
  if (userTurns > 0) clauses.push(`${userTurns} user turn${userTurns === 1 ? '' : 's'}`);
  if (thoughts > 0) clauses.push(`${thoughts} thought${thoughts === 1 ? '' : 's'}`);
  if (syntheticUsers > 0) clauses.push(`${syntheticUsers} synthetic`);

  const prefix = commonDirPrefix(filePaths);
  const prefixClause = prefix ? ` (mostly ${prefix})` : '';
  const body = clauses.length > 0 ? clauses.join(', ') : 'misc';
  return `[${timeRange}] ◯ ${bucket.entries.length} cold events: ${body}${prefixClause}`;
}

export function renderActivityLog(
  reduced: ReducedTranscript,
  gradient: GradientConfig,
  toolResultBudget: ToolResultBudget = DEFAULT_TOOL_RESULT_BUDGET,
): string {
  const zones = assignZones(reduced.events, gradient);
  const alloc = allocateToolResultBytes(reduced.events, zones, toolResultBudget);
  const parts: string[] = ['── Activity Log (canonical events) ──', ''];
  parts.push(
    `Chronology: oldest → newest. ${reduced.events.length} events, ` +
      `gradient ${gradient.hotCount} hot / ${gradient.warmCount} warm / rest summarized into cold buckets. ` +
      `Tool-result budget ${toolResultBudget.globalBudget}B (hot≤${toolResultBudget.hotBytes}, ` +
      `warm≤${toolResultBudget.warmBytes}, small-bypass≤${toolResultBudget.smallBypassBytes}).`,
  );
  parts.push('');

  const lineBuf: string[] = [];
  let lastDayKey: string | null = null;
  let coldBucket: ColdBucket | null = null;

  const flushColdBucket = () => {
    if (!coldBucket || coldBucket.entries.length === 0) {
      coldBucket = null;
      return;
    }
    lineBuf.push(summarizeColdBucket(coldBucket));
    coldBucket = null;
  };

  for (let i = 0; i < reduced.events.length; i++) {
    const ev = reduced.events[i];
    const z = zones[i];
    if (!ev || !z) continue;

    // Calendar-day separator: flushes any open bucket first so the divider
    // appears between the summary and the new day's events, not inside.
    if (ev.timestamp.getTime() > 0) {
      const dayKey = calendarDayKey(ev.timestamp);
      if (dayKey !== lastDayKey) {
        flushColdBucket();
        lineBuf.push(`── ${dayKey} ──`);
        lastDayKey = dayKey;
      }
    }
    const t = fmtTime(ev.timestamp);
    const a = alloc[i] ?? 0;

    if (z === 'cold') {
      // Pass-through cold events render verbatim and break the bucket so
      // the surrounding summary lines cleanly bracket them.
      if (isColdPassthrough(ev)) {
        flushColdBucket();
        const tag = coldLine(ev, a);
        if (tag) lineBuf.push(`[${t}] · ${tag}`);
        continue;
      }
      // Start or extend the open cold bucket. Bucket boundary is EVENT-count
      // only — never wall-clock time — because user AFK-time (stand up, walk
      // away, come back) shouldn't split a logically-contiguous cold run.
      // Pass-through events (errors / real user turns / hooks) and the
      // calendar-day divider already provide semantic boundaries. The time
      // range shown on the bucket line is purely descriptive of the
      // contained events, not a bucketing rule.
      const shouldStartNew = !coldBucket || coldBucket.entries.length >= COLD_BUCKET_MAX_EVENTS;
      if (shouldStartNew) {
        flushColdBucket();
        coldBucket = { entries: [{ ev, ts: ev.timestamp }], startTs: ev.timestamp };
      } else {
        coldBucket!.entries.push({ ev, ts: ev.timestamp });
      }
      continue;
    }

    // Warm or hot: close any open cold bucket first so the summary is
    // anchored before the detailed chronology resumes.
    flushColdBucket();
    if (z === 'warm') {
      lineBuf.push(`[${t}] ${warmLine(ev, reduced, a)}`);
      continue;
    }
    lineBuf.push(`[${t}] ${hotLine(ev, a)}`);
  }
  // Final trailing-cold flush.
  flushColdBucket();

  const collapsed = collapseConsecutiveRuns(lineBuf);
  parts.push(...collapsed);
  parts.push('');
  return parts.join('\n');
}

/**
 * Post-process the activity-log line buffer to collapse consecutive runs of
 * the same single-line breadcrumb — specifically cold tool_use rows
 * (`[hh:mm] · ToolName`) and thinking rows (`[hh:mm] · thought` or
 * `[hh:mm] 💭 (thinking)`) — into a single `×N` range line. Huge on sessions
 * where the same tool fires many times back-to-back (Read loops, grep
 * sweeps, think-then-act chains). Non-matching lines break the run.
 *
 * Hot/warm lines that contain body text are left untouched: coalescing them
 * would hide actual signal. Only the narrow "identical breadcrumb" pattern
 * collapses, which is exactly the high-noise-zero-signal case.
 */
function collapseConsecutiveRuns(lines: string[]): string[] {
  const COLD_TOOL_RE = /^\[([^\]]+)\] · (\S+)$/;
  const THOUGHT_RE = /^\[([^\]]+)\] (?:· thought|💭 \(thinking\))$/;
  const out: string[] = [];
  let runKind: 'tool' | 'thought' | null = null;
  let runLabel = '';
  let runFirst = '';
  let runLast = '';
  let runCount = 0;

  const flush = () => {
    if (runCount === 0) return;
    const body = runKind === 'tool' ? `· ${runLabel}` : runLabel;
    if (runCount === 1) {
      out.push(`[${runFirst}] ${body}`);
    } else {
      out.push(`[${runFirst} – ${runLast}] ${body} ×${runCount}`);
    }
    runCount = 0;
    runKind = null;
  };

  for (const line of lines) {
    const toolMatch = COLD_TOOL_RE.exec(line);
    const thoughtMatch = THOUGHT_RE.exec(line);
    if (toolMatch) {
      const [, time, name] = toolMatch;
      const label = `· ${name}`;
      if (runKind === 'tool' && runLabel === label) {
        runLast = time!;
        runCount++;
      } else {
        flush();
        runKind = 'tool';
        runLabel = name!;
        runFirst = time!;
        runLast = time!;
        runCount = 1;
      }
    } else if (thoughtMatch) {
      const [, time] = thoughtMatch;
      const label = line.includes('💭') ? '💭 (thinking)' : '· thought';
      if (runKind === 'thought' && runLabel === label) {
        runLast = time!;
        runCount++;
      } else {
        flush();
        runKind = 'thought';
        runLabel = label;
        runFirst = time!;
        runLast = time!;
        runCount = 1;
      }
    } else {
      flush();
      out.push(line);
    }
  }
  flush();
  return out;
}

function coldLine(ev: NormalizedEvent, alloc: number): string | null {
  switch (ev.kind) {
    case 'user_text':
      return ev.synthetic ? null : 'user';
    case 'assistant_text':
      return 'ai';
    case 'assistant_thinking':
      return ev.hasContent ? 'thought' : null;
    case 'tool_use':
      return ev.name;
    case 'tool_result': {
      // Errors always surface with a brief inline preview so silent failures
      // never slip past the cold zone.
      if (ev.isError) {
        const preview = trimToBytes(ev.text, 120).replace(/\s+/g, ' ').trim();
        return preview ? `tool_error: ${preview}` : 'tool_error';
      }
      // Small-result bypass: tiny payloads (e.g. `recordCount: 0`) render
      // inline. Otherwise the paired tool_use breadcrumb already announces
      // the call — a separate result row would just be visual noise.
      if (alloc > 0) {
        const inline = trimToBytes(ev.text, alloc).replace(/\s+/g, ' ').trim();
        return inline ? `↩ ${inline}` : null;
      }
      return null;
    }
    case 'hook':
      return null;
  }
}

function warmLine(ev: NormalizedEvent, reduced: ReducedTranscript, alloc: number): string {
  switch (ev.kind) {
    case 'user_text':
      if (ev.synthetic) return '(synthetic user)';
      return isConsumedTransportUserPrompt(ev.text)
        ? '👤 [rebirth/reset transport command already consumed]'
        : `👤 ${firstSentence(ev.text, 160)}`;
    case 'assistant_text':
      return `🤖 ${firstSentence(ev.text, 160)}`;
    case 'assistant_thinking':
      return '💭 (thinking)';
    case 'tool_use': {
      const call = reduced.toolCalls.find((c) => c.use.id === ev.id);
      return `🔧 ${call ? summarizeToolCall(call) : ev.name}`;
    }
    case 'tool_result': {
      if (ev.isError) {
        const preview = trimToBytes(ev.text, Math.max(alloc, 160)).replace(/\s+/g, ' ').trim();
        return `⚠ tool_error: ${preview}`;
      }
      if (alloc === 0) return '↩ tool_result';
      // Warm entries are one-entry-per-line in the rendered log; keep the
      // inline preview single-line unless the caller budget justifies spill.
      const body = trimToBytes(ev.text, alloc);
      const oneLine = body.length <= 200 ? body.replace(/\s+/g, ' ').trim() : body;
      return `↩ result: ${oneLine}`;
    }
    case 'hook':
      return `⚙ hook: ${ev.hookEvent}`;
  }
}

function hotLine(ev: NormalizedEvent, alloc: number): string {
  switch (ev.kind) {
    case 'user_text':
      return ev.synthetic
        ? '(synthetic user — suppressed in hot view)'
        : isConsumedTransportUserPrompt(ev.text)
          ? '👤 USER:\n[rebirth/reset transport command already consumed]'
          : `👤 USER:\n${trimToLines(ev.text.trim(), 6)}`;
    case 'assistant_text':
      return `🤖 AI:\n${trimToLines(ev.text.trim(), 6)}`;
    case 'assistant_thinking':
      return '💭 (extended thinking — payload encrypted)';
    case 'tool_use': {
      const inp = ev.input ?? {};
      // Per-body-type byte caps: long bash commands, full file_paths, and
      // hefty patterns each get their own ceiling so the hot-line preview
      // stays readable without dropping the lead value. Mirrors the
      // voxxo-swarm HOT_EDIT / HOT_COMMAND / HOT_TEXT split, adapted to
      // tool-input preview keys.
      const previewCaps: Record<string, number> = {
        file_path: 200,
        command: 180,
        pattern: 120,
        url: 200,
        query: 160,
      };
      const preview = Object.entries(previewCaps)
        .map(([k, cap]) => {
          const v = (inp as Record<string, unknown>)[k];
          if (typeof v !== 'string') return null;
          const val = v.length > cap ? v.slice(0, cap) + '…' : v;
          return `${k}=${val}`;
        })
        .filter((x): x is string => x !== null)
        .join(' ');
      return `🔧 ${(ev as ToolUseEvent).name}${preview ? ' ' + preview : ''}`;
    }
    case 'tool_result': {
      if (ev.isError) {
        return `⚠ tool_error:\n${trimToBytes(ev.text, Math.max(alloc, 400))}`;
      }
      if (alloc === 0) return '↩ tool_result (payload elided by budget)';
      return `↩ tool_result:\n${trimToBytes(ev.text, alloc)}`;
    }
    case 'hook':
      return `⚙ hook: ${ev.hookEvent}${ev.stdout ? '\n  ' + trimToLines(sanitizeHookStdout(ev.stdout), 4) : ''}`;
  }
}

// --- Header / footer ------------------------------------------------------

export function renderHeader(
  reduced: ReducedTranscript,
  capturedAt: Date,
  currentSessionId?: string,
  identityName?: string,
): string {
  // Filter epoch-0 timestamps out of the displayed span so a single row with
  // a missing/unparseable timestamp (which the reducer folds to new Date(0)
  // as an intentionally non-destructive fallback) doesn't smear the header
  // to "1970-01-01 → …". Events stay in the log untouched; this is purely a
  // display-time correction.
  const valid = reduced.events
    .map((e) => e.timestamp)
    .filter((t) => t.getTime() > 0);
  let spanStart = reduced.startedAt;
  let spanEnd = reduced.endedAt;
  if (valid.length > 0) {
    let min = valid[0] as Date;
    let max = valid[0] as Date;
    for (const t of valid) {
      if (t < min) min = t;
      if (t > max) max = t;
    }
    spanStart = min;
    spanEnd = max;
  }

  // Emitting session vs. reduced.sessionId: when the caller walked the chain
  // backward and concat-reduced ancestor rows, `reduced.sessionId` is pulled
  // from the first (oldest) row by the reducer — NOT the session this handoff
  // is emitting FROM. That's a display bug (the header misnames the session)
  // AND a chain bug: the successor's turn-0 handoff gets extracted by
  // extractPredecessorFromTranscript, which reads the `Session:` header to
  // decide the predecessor. If we print the oldest ancestor here, the
  // successor links (new) → (oldest-ancestor) and skips every intermediate,
  // collapsing a 4-deep chain to 2 hops. The `currentSessionId` override is
  // specifically for this — falls back to reduced.sessionId for unchained
  // callers.
  const emittingSessionId = currentSessionId || reduced.sessionId;

  const lines: string[] = [
    '[CONTEXT REBIRTH] You are the continuation of the previous Claude Code session.',
    'Same identity, same project, same tools — pick up where it left off.',
    'If rebirth/reset commands appear below, they are already-consumed transport',
    'steps, not work to repeat in this session.',
    '',
    `Session: ${emittingSessionId || '(unknown)'}`,
    `Project:  ${reduced.cwd || '(unknown)'}`,
    `Captured: ${fmtDateTime(capturedAt)}`,
    `Span:     ${fmtDateTime(spanStart)} → ${fmtDateTime(spanEnd)}`,
  ];

  // Operational context — first-class surface for the wrapper PID and related
  // env-derived runtime facts. The wrapper PID specifically is the single most
  // important operational datum at rebirth time: "wrapper 3048222 is still
  // running with old script in memory" is exactly the kind of thing a
  // successor needs to know up-front, not buried in prose.
  const wrapperPid = process.env['REBIRTH_WRAPPER_PID'];
  const wrapperProjectDir = process.env['REBIRTH_WRAPPER_PROJECT_DIR'];
  const parentSession = process.env['CLAUDE_SESSION_ID'];
  const ops: string[] = [];
  if (wrapperPid && /^\d+$/.test(wrapperPid)) {
    ops.push(`  Wrapper PID:    ${wrapperPid} (rebirth-claude — may hold a stale script image in memory)`);
  }
  if (wrapperProjectDir) {
    ops.push(`  Wrapper dir:    ${wrapperProjectDir}`);
  }
  if (parentSession && parentSession !== emittingSessionId) {
    ops.push(`  Parent session: ${parentSession}`);
  }
  if (ops.length > 0) {
    lines.push('', 'Operational:', ...ops);
  }

  lines.push(
    '',
    'Read the Freshest Turn first (then Prior Turns + Your Next Step); Active Edit Delta is',
    'authoritative for in-flight files. Activity Log is canonical chronology.',
    '',
    // Gap-fill hint — the handoff is lossy by design (hot/warm/cold gradient,
    // tool-result budgets). If the successor needs a detail that was elided,
    // the `rebirth` MCP tool can retrieve it from the chain's raw .jsonls via
    // hybrid BM25 + vector search. `scope:"self"` narrows to this lineage,
    // which is almost always what you want for gap-fill; `scope:"all"`
    // expands cross-project if the thread jumped workspaces.
    'Gap-fill: if a detail feels missing, call the `rebirth` MCP tool with',
    '`{query:"...", scope:"self"}` to search this lineage (or `scope:"all"`',
    'for cross-project). Only reach for it when the handoff itself is thin —',
    'raw reads + reruns are still cheaper when you already know the file.',
    '',
  );

  // Identity details (name, profile, recent specialty signal, swap/audit
  // pointers, recommend nudge) live in the dedicated `── Identity ──` section
  // that buildHandoff places between the header and Freshest Turn — see
  // renderIdentitySnapshot below. Keeping the header itself terse means the
  // successor's eye lands on Freshest Turn one screen sooner.
  void identityName;

  return lines.join('\n');
}

// --- Identity snapshot ----------------------------------------------------

/**
 * Per-respawn snapshot of "who you are this session." Surfaces the agent-
 * written profile (blurb + specialty), the lineage's recent activity (top
 * files, total edits/sessions/files), and a one-line nudge toward
 * `rebirth_identity_recommend` for cases where the upcoming work doesn't
 * match this identity's specialty.
 *
 * Why this section exists at all: the recommend MCP tool is invisible by
 * default — no agent runs it unless something points them at it. Firing
 * this snapshot once per respawn turns recommend from "tool you have to
 * remember" into "next-step prompt you read." Pure additive change to the
 * handoff: no cost when the caller didn't supply an identity name.
 *
 * Skipped (returns '') when:
 *   - identityName is not supplied (CLI / test harnesses that bypass the
 *     identity resolver)
 *   - the home-level rebirth-index DB doesn't open (treat as fresh install
 *     and fall through to the bare-name + swap/audit hint)
 *
 * Reads from IdentityStore directly — no fresh indexing — so the section
 * stays cheap. If the corpus is stale the activity numbers will lag, but
 * the profile lines are always live.
 */
export function renderIdentitySnapshot(opts: {
  identityName?: string;
  blurb?: string;
  specialtyTags?: string;
  handoffNote?: string | null;
  activeSops?: Array<{ title: string; body?: string }>;
  recentFiles?: Array<{ workspace?: string; filePath: string; edgeCount?: number; lastTouchedAt?: number }>;
  topFiles?: number;
  /** Max SOPs to inline in full. Overflow gets a "+M more" pointer. Default 8. */
  topSops?: number;
}): string {
  const name = opts.identityName?.trim();
  if (!name) return '';
  const topSopN = opts.topSops ?? 8;

  const lines: string[] = ['── Identity ──', ''];
  lines.push(`You are: **${name}**`);

  if (opts.handoffNote && opts.handoffNote.trim().length > 0) {
    lines.push('');
    lines.push('📝 **From-me-to-future-me**:');
    lines.push('');
    for (const ln of opts.handoffNote.trim().split('\n')) {
      lines.push(`  ${ln}`);
    }
    lines.push('');
  }

  if (opts.specialtyTags?.trim()) {
    lines.push(`Specialty tags: ${opts.specialtyTags.trim()}`);
  }
  if (opts.blurb?.trim()) {
    const flat = opts.blurb.trim().replace(/\s+/g, ' ');
    const blurbLine = flat.length > 220 ? flat.slice(0, 220) + '…' : flat;
    lines.push(`About: ${blurbLine}`);
  }

  if (!opts.blurb?.trim() && !opts.specialtyTags?.trim()) {
    lines.push('_(no self-description or specialty tags yet)_');
  }
  lines.push('');

  const sops = (opts.activeSops ?? []).slice(0, topSopN);
  if (sops.length > 0) {
    lines.push(`Operating manual (${sops.length} SOP${sops.length === 1 ? '' : 's'}):`);
    for (const sop of sops) {
      lines.push(`  - **${sop.title}**`);
      const body = sop.body?.trim() ?? '';
      if (body) {
        const flat = body.replace(/\s+/g, ' ');
        const trimmed = flat.length > 240 ? flat.slice(0, 240) + '…' : flat;
        lines.push(`    ${trimmed}`);
      }
    }
    lines.push('');
  }

  const recentFiles = (opts.recentFiles ?? []).slice(0, opts.topFiles ?? 3);
  if (recentFiles.length > 0) {
    lines.push('Recent file experience:');
    for (const f of recentFiles) {
      const last = f.lastTouchedAt ? `, last ${new Date(f.lastTouchedAt).toISOString().slice(0, 10)}` : '';
      const count = f.edgeCount ? ` — ${f.edgeCount} edge${f.edgeCount === 1 ? '' : 's'}` : '';
      const workspace = f.workspace ? `${f.workspace}:` : '';
      lines.push(`  - \`${workspace}${f.filePath}\`${count}${last}`);
    }
    lines.push('');
  }

  lines.push('Different work? Use `brain_recommend` to find the best identity for the next task.');

  return lines.join('\n');
}

// --- Your Next Step -------------------------------------------------------

/**
 * Surfaces the successor's "what you're being picked up to do" as a
 * first-class section instead of making the successor infer it from the
 * last-messages block. Heuristic is intentionally dumb: lift the freshest
 * non-transport user message, optionally frame based on whether the newest
 * turn was user (pick up from the ask) or AI (finish the in-flight action
 * first). If there is no user message at all, fall back to pointing at the
 * last AI turn.
 */
export function renderNextStep(reduced: ReducedTranscript): string {
  const lastUser = [...reduced.userMessages]
    .reverse()
    .find((m) => m.text.trim().length > 0 && !isConsumedTransportUserPrompt(m.text));
  const lastAi = [...reduced.assistantMessages]
    .reverse()
    .find((m) => m.text.trim().length > 0);
  if (!lastUser && !lastAi) return '';
  const parts: string[] = ['── Your Next Step ──', ''];
  if (!lastUser && lastAi) {
    parts.push(
      'No pending human ask — the session last ended with an AI turn. See Last AI',
      'Message above for the in-flight action to continue or wrap up.',
      '',
    );
    return parts.join('\n');
  }
  if (lastUser) {
    const userIsNewest = !lastAi || lastUser.timestamp.getTime() >= lastAi.timestamp.getTime();
    const ask = trimToLines(lastUser.text.trim(), 24);
    parts.push(`Human's last ask  [${fmtTime(lastUser.timestamp)}]:`);
    parts.push('  ' + ask.split('\n').join('\n  '));
    parts.push('');
    parts.push(
      userIsNewest
        ? 'Pick up from the ask above. If you need clarification, ask the user rather than guessing.'
        : 'The user asked the above earlier — the AI was mid-action (see Last AI Message). Finish that in-flight work first, then return to this.',
    );
    parts.push('');
  }
  return parts.join('\n');
}
