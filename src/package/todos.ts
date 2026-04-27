import type { ReducedTranscript } from '../trace/types.js';

/**
 * Mines the reduced transcript for the most recent TodoWrite call and
 * surfaces the in-flight todo list in the handoff. TodoWrite is Claude
 * Code's canonical "what am I working on right now" signal — the last
 * write wins because TodoWrite is treated as a full-snapshot overwrite
 * by the harness, not an append. So the freshest call is the current
 * state of the todo list at capture time.
 *
 * TodoWrite is almost always a better "what am I doing right now" signal
 * than free-form scratchpads because each item carries explicit status
 * (pending / in_progress / completed) so the successor can sort and act
 * on them directly without re-reading conversation prose.
 */

export interface TodoItem {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed' | string;
  activeForm?: string;
  [k: string]: unknown;
}

export interface TodoSnapshot {
  timestamp: Date;
  todos: TodoItem[];
}

/**
 * Walk tool_calls backward and return the first TodoWrite we find.
 * Returns null if no TodoWrite ever happened in this session.
 */
export function extractLatestTodoSnapshot(reduced: ReducedTranscript): TodoSnapshot | null {
  for (let i = reduced.toolCalls.length - 1; i >= 0; i--) {
    const call = reduced.toolCalls[i];
    if (!call || call.use.name !== 'TodoWrite') continue;
    const todos = (call.use.input as { todos?: unknown }).todos;
    if (!Array.isArray(todos)) continue;
    const cleaned: TodoItem[] = [];
    for (const raw of todos) {
      if (!raw || typeof raw !== 'object') continue;
      const obj = raw as Record<string, unknown>;
      const content = typeof obj['content'] === 'string' ? (obj['content'] as string) : undefined;
      if (!content) continue;
      const status = typeof obj['status'] === 'string' ? (obj['status'] as string) : undefined;
      const activeForm =
        typeof obj['activeForm'] === 'string' ? (obj['activeForm'] as string) : undefined;
      const item: TodoItem = { content };
      if (status) item.status = status;
      if (activeForm) item.activeForm = activeForm;
      cleaned.push(item);
    }
    if (cleaned.length === 0) continue;
    return { timestamp: call.use.timestamp, todos: cleaned };
  }
  return null;
}

function fmtTime(d: Date): string {
  return d.toTimeString().slice(0, 5);
}

function statusGlyph(status?: string): string {
  switch (status) {
    case 'completed':
      return '✅';
    case 'in_progress':
      return '▶️';
    case 'pending':
      return '☐';
    default:
      return '·';
  }
}

/**
 * Render a Todos section showing the latest TodoWrite snapshot, ordered
 * in_progress → pending → completed so the successor reads active work
 * first. Completed items are kept (not dropped) so the successor can see
 * what's already done in this session and doesn't redo it.
 */
export function renderTodos(reduced: ReducedTranscript): string {
  const snap = extractLatestTodoSnapshot(reduced);
  // Emit a negative-assertion stub rather than omitting the section, so the
  // successor knows todo state wasn't lost in compaction — there just wasn't
  // any. Silent omission is ambiguous; an explicit "(none)" is reassuring.
  if (!snap) {
    return ['── Active Todos (last TodoWrite snapshot) ──', '', '(no TodoWrite called this session)', ''].join('\n');
  }
  const order = (s?: string): number => {
    if (s === 'in_progress') return 0;
    if (s === 'pending') return 1;
    if (s === 'completed') return 2;
    return 3;
  };
  const sorted = [...snap.todos].sort((a, b) => order(a.status) - order(b.status));
  const parts: string[] = [
    '── Active Todos (last TodoWrite snapshot) ──',
    '',
    `Captured at ${fmtTime(snap.timestamp)} — ${sorted.length} item${sorted.length === 1 ? '' : 's'}`,
    '',
  ];
  for (const t of sorted) {
    const glyph = statusGlyph(t.status);
    const label = t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
    parts.push(`  ${glyph} ${label}`);
  }
  parts.push('');
  return parts.join('\n');
}
