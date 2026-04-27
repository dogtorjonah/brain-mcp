import type {
  NormalizedEvent,
  RawContentBlock,
  RawTranscriptLine,
  ReducedTranscript,
  ToolCall,
  ToolResultEvent,
  ToolUseEvent,
  UserTextEvent,
  AssistantTextEvent,
} from './types.js';

/**
 * A text block inside a role:user frame is "synthetic" (agent/harness-injected
 * rather than human-typed) when it is a system-reminder, command wrapper, or
 * rebirth sentinel. Evaluated per-block because a single user turn often
 * bundles one or more reminder blocks alongside the actual human prompt — we
 * must not filter the whole turn just because it has reminders attached.
 *
 * Keep the sentinel set aligned with Claude Code's harness output: the CLI
 * wraps slash-commands as `<command-name>/<command-message>` pairs, dumps
 * slash-command stdout as `<local-command-stdout>`, and emits
 * `<local-command-caveat>` when transcribing a caveat block before the
 * rendered command. Interrupt markers surface as plain `[Request interrupted
 * by user]` text (no XML wrapper) so we match that verbatim.
 */
function isSyntheticUserText(text: string): boolean {
  const head = text.slice(0, 200);
  return /^\s*<(system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-caveat|meta-state-report-request)>/.test(head)
    || head.includes('[CONTEXT REBIRTH]')
    || /^\s*\[Request interrupted by user\]/.test(head);
}

function textifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const block = b as RawContentBlock;
      if (block.type === 'text' && 'text' in block) return (block as { text: string }).text;
      return '';
    })
    .join('\n');
}

function parseTimestamp(row: RawTranscriptLine): Date {
  if (typeof row.timestamp === 'string') {
    const d = new Date(row.timestamp);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date(0);
}

/**
 * Reduce a raw transcript into a flat event stream plus convenience indexes.
 * Event order = transcript order; pairing is done after by scanning tool_use
 * ids against tool_result ids.
 */
export function reduceTranscript(rows: RawTranscriptLine[]): ReducedTranscript {
  const events: NormalizedEvent[] = [];
  let sessionId = '';
  let cwd = '';
  let first: Date | null = null;
  let last: Date | null = null;

  for (const row of rows) {
    const ts = parseTimestamp(row);
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;
    if (!sessionId && typeof row.sessionId === 'string') sessionId = row.sessionId;
    if (!cwd && typeof row.cwd === 'string') cwd = row.cwd;

    if (row.type === 'user') {
      const content = row.message?.content;
      // Claude Code marks harness-injected user rows (slash-command bodies,
      // caveat transcripts, command wrapper blocks) with `isMeta: true` at
      // the row level. Treat every text block inside an isMeta row as
      // synthetic regardless of payload — the row itself is the signal that
      // no human typed this.
      const rowIsMeta = (row as { isMeta?: unknown }).isMeta === true;
      // Claude Code stores plain typed prompts as a raw string and structured
      // frames (tool_result wrappers, MCP tool invocations, multi-block
      // reminders) as arrays. String content was previously dropped entirely,
      // which is why every human prompt vanished from the handoff — treat it
      // as a single synthetic-evaluated text block here.
      if (typeof content === 'string') {
        events.push({
          kind: 'user_text',
          text: content,
          synthetic: rowIsMeta || isSyntheticUserText(content),
          timestamp: ts,
          uuid: row.uuid,
          parentUuid: row.parentUuid ?? null,
        });
        continue;
      }
      if (!Array.isArray(content)) continue;
      // A tool_result block marks its own frame as a tool wrapper; text blocks
      // sharing that frame are still evaluated individually below.
      const frameIsToolWrapper = content.some(
        (b) => (b as RawContentBlock).type === 'tool_result',
      );
      for (const raw of content) {
        const block = raw as RawContentBlock;
        if (block.type === 'text' && 'text' in block) {
          const text = (block as { text: string }).text;
          const synthetic = rowIsMeta || frameIsToolWrapper || isSyntheticUserText(text);
          events.push({
            kind: 'user_text',
            text,
            synthetic,
            timestamp: ts,
            uuid: row.uuid,
            parentUuid: row.parentUuid ?? null,
          });
        } else if (block.type === 'tool_result' && 'tool_use_id' in block) {
          const tr = block as {
            type: 'tool_result';
            tool_use_id: string;
            content: unknown;
            is_error?: boolean;
          };
          const text = textifyToolResultContent(tr.content);
          const ev: ToolResultEvent = {
            kind: 'tool_result',
            toolUseId: tr.tool_use_id,
            text,
            isError: Boolean(tr.is_error),
            timestamp: ts,
            uuid: row.uuid,
            parentUuid: row.parentUuid ?? null,
          };
          // Enrich Read results with file metadata if present
          const file = row.toolUseResult?.file;
          if (file?.filePath) {
            ev.file = { path: file.filePath, numLines: file.numLines };
          }
          events.push(ev);
        }
      }
      continue;
    }

    if (row.type === 'assistant') {
      const content = row.message?.content;
      if (!Array.isArray(content)) continue;
      const model = typeof row.message?.model === 'string' ? row.message.model : undefined;
      for (const raw of content) {
        const block = raw as RawContentBlock;
        if (block.type === 'text' && 'text' in block) {
          events.push({
            kind: 'assistant_text',
            text: (block as { text: string }).text,
            model,
            timestamp: ts,
            uuid: row.uuid,
            parentUuid: row.parentUuid ?? null,
          });
        } else if (block.type === 'thinking') {
          const thinking = (block as { thinking?: string }).thinking ?? '';
          events.push({
            kind: 'assistant_thinking',
            hasContent: thinking.length > 0,
            timestamp: ts,
            uuid: row.uuid,
            parentUuid: row.parentUuid ?? null,
          });
        } else if (block.type === 'tool_use' && 'id' in block) {
          const tu = block as { type: 'tool_use'; id: string; name: string; input: unknown };
          events.push({
            kind: 'tool_use',
            id: tu.id,
            name: tu.name,
            input: (tu.input as Record<string, unknown> | null) ?? {},
            timestamp: ts,
            uuid: row.uuid,
            parentUuid: row.parentUuid ?? null,
          });
        }
      }
      continue;
    }

    if (row.type === 'attachment' && row.attachment) {
      const a = row.attachment;
      events.push({
        kind: 'hook',
        hookEvent: a.hookEvent ?? a.type,
        hookName: a.hookName,
        stdout: a.stdout,
        exitCode: a.exitCode,
        timestamp: ts,
        uuid: row.uuid,
        parentUuid: row.parentUuid ?? null,
      });
    }
  }

  const toolCalls = pairToolCalls(events);
  const userMessages = events.filter(
    (e): e is UserTextEvent => e.kind === 'user_text' && !e.synthetic,
  );
  const assistantMessages = events.filter(
    (e): e is AssistantTextEvent => e.kind === 'assistant_text',
  );

  return {
    sessionId,
    cwd,
    startedAt: first ?? new Date(0),
    endedAt: last ?? new Date(0),
    events,
    toolCalls,
    userMessages,
    assistantMessages,
  };
}

function pairToolCalls(events: NormalizedEvent[]): ToolCall[] {
  const uses = new Map<string, ToolUseEvent>();
  const calls: ToolCall[] = [];
  for (const ev of events) {
    if (ev.kind === 'tool_use') {
      uses.set(ev.id, ev);
      calls.push({ use: ev });
    } else if (ev.kind === 'tool_result') {
      const call = calls.find((c) => c.use.id === ev.toolUseId && !c.result);
      if (call) call.result = ev;
    }
  }
  return calls;
}
