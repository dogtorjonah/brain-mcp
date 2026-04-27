/**
 * Typed view of a Claude Code JSONL transcript.
 *
 * Only fields we actually consume are modelled; unknown fields fall through
 * as `unknown`. The transcript schema is Claude Code's private format — we
 * treat it as a stable-ish stream and degrade gracefully on shape drift.
 */

export interface RawTranscriptLine {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  message?: RawMessage;
  toolUseResult?: RawToolUseResult;
  attachment?: RawAttachment;
  [k: string]: unknown;
}

export interface RawMessage {
  role?: 'user' | 'assistant';
  model?: string;
  content?: string | RawContentBlock[];
  [k: string]: unknown;
}

export type RawContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string | RawContentBlock[]; is_error?: boolean }
  | { type: string; [k: string]: unknown };

export interface RawToolUseResult {
  stdout?: string;
  stderr?: string;
  interrupted?: boolean;
  isImage?: boolean;
  returnCodeInterpretation?: string;
  noOutputExpected?: boolean;
  file?: { filePath?: string; content?: string; numLines?: number };
  [k: string]: unknown;
}

export interface RawAttachment {
  type: string;
  hookName?: string;
  hookEvent?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  [k: string]: unknown;
}

// --- Normalised event model used by the reducer + renderers ---------------

export type NormalizedEvent =
  | UserTextEvent
  | AssistantTextEvent
  | AssistantThinkingEvent
  | ToolUseEvent
  | ToolResultEvent
  | HookEvent;

export interface BaseEvent {
  uuid?: string;
  parentUuid?: string | null;
  timestamp: Date;
}

export interface UserTextEvent extends BaseEvent {
  kind: 'user_text';
  text: string;
  /** True if this message was auto-generated (hook injection, system reminder, tool_result wrapper). */
  synthetic: boolean;
}

export interface AssistantTextEvent extends BaseEvent {
  kind: 'assistant_text';
  text: string;
  model?: string;
}

export interface AssistantThinkingEvent extends BaseEvent {
  kind: 'assistant_thinking';
  /** Raw thinking is usually encrypted; we only note that thinking happened. */
  hasContent: boolean;
}

export interface ToolUseEvent extends BaseEvent {
  kind: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultEvent extends BaseEvent {
  kind: 'tool_result';
  toolUseId: string;
  /** Textified result content (tool outputs Claude actually saw). */
  text: string;
  isError: boolean;
  /** Present when the tool was Read and we have the full file payload. */
  file?: { path: string; numLines?: number };
}

export interface HookEvent extends BaseEvent {
  kind: 'hook';
  hookEvent: string;
  hookName?: string;
  stdout?: string;
  exitCode?: number;
}

// --- Higher-order structures ---------------------------------------------

export interface ToolCall {
  use: ToolUseEvent;
  result?: ToolResultEvent;
}

export interface ReducedTranscript {
  sessionId: string;
  cwd: string;
  startedAt: Date;
  endedAt: Date;
  events: NormalizedEvent[];
  toolCalls: ToolCall[];
  userMessages: UserTextEvent[];
  assistantMessages: AssistantTextEvent[];
}
