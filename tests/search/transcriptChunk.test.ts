import { describe, it, expect } from 'vitest';
import { buildChunks, type Chunk } from '../../src/search/transcriptChunk.js';
import type { NormalizedEvent, UserTextEvent, AssistantTextEvent, HookEvent, AssistantThinkingEvent, ToolUseEvent, ToolResultEvent } from '../../src/trace/types.js';

function userEvent(text: string, opts: Partial<UserTextEvent> = {}): UserTextEvent {
  return { kind: 'user_text', text, synthetic: false, timestamp: new Date('2026-01-01T00:00:00Z'), ...opts };
}

function assistantEvent(text: string, opts: Partial<AssistantTextEvent> = {}): AssistantTextEvent {
  return { kind: 'assistant_text', text, timestamp: new Date('2026-01-01T00:00:01Z'), ...opts };
}

function hookEvent(hookEvent: string, stdout: string, opts: Partial<HookEvent> = {}): HookEvent {
  return { kind: 'hook', hookEvent, stdout, timestamp: new Date('2026-01-01T00:00:02Z'), ...opts };
}

function thinkingEvent(): AssistantThinkingEvent {
  return { kind: 'assistant_thinking', hasContent: false, timestamp: new Date('2026-01-01T00:00:03Z') };
}

const DEFAULT_OPTS = { sessionId: 'sess-1', cwdSlug: 'test-repo', sourcePath: '/tmp/test.jsonl' };

describe('transcriptChunk: buildChunks — user/assistant/hook events', () => {
  it('user_text → chunk with kind=user, prefix [user], chunkId=sess-1:0', () => {
    const events: NormalizedEvent[] = [userEvent('hello world')];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('user');
    expect(chunks[0].text).toMatch(/^\[user\] hello world$/);
    expect(chunks[0].chunkId).toBe('sess-1:0');
  });

  it('assistant_text → kind=assistant, prefix [assistant]', () => {
    const events: NormalizedEvent[] = [assistantEvent('I will help you.')];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('assistant');
    expect(chunks[0].text).toMatch(/^\[assistant\] I will help you\.$/);
  });

  it('synthetic user_text → prefix [synthetic]', () => {
    const events: NormalizedEvent[] = [userEvent('auto-injected', { synthetic: true })];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toMatch(/^\[synthetic\] auto-injected$/);
  });

  it('hook event with stdout → kind=hook, prefix [hook]', () => {
    const events: NormalizedEvent[] = [hookEvent('PreToolUse', 'running pre-check')];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('hook');
    expect(chunks[0].text).toMatch(/^\[hook\] PreToolUse running pre-check$/);
  });

  it('hook event with empty stdout → skipped', () => {
    const events: NormalizedEvent[] = [hookEvent('PreToolUse', '  ')];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(0);
  });

  it('assistant_thinking → skipped entirely', () => {
    const events: NormalizedEvent[] = [thinkingEvent()];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(0);
  });

  it('chunkId format is sessionId:ordinal', () => {
    const events: NormalizedEvent[] = [
      userEvent('first'),
      assistantEvent('second'),
      thinkingEvent(), // skipped
      hookEvent('Hook', 'output'),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    // user_text(0) + assistant_text(1) + thinking(skipped) + hook(3) = 3 chunks
    expect(chunks).toHaveLength(3);
    expect(chunks[0].chunkId).toBe('sess-1:0');
    expect(chunks[1].chunkId).toBe('sess-1:1');
    expect(chunks[2].chunkId).toBe('sess-1:3'); // thinking at index 2 is skipped
  });

  it('chunk metadata: sessionId, cwdSlug, sourcePath, textHash populated', () => {
    const events: NormalizedEvent[] = [userEvent('test')];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    const chunk = chunks[0];
    expect(chunk.sessionId).toBe('sess-1');
    expect(chunk.cwdSlug).toBe('test-repo');
    expect(chunk.sourcePath).toBe('/tmp/test.jsonl');
    expect(chunk.textHash).toMatch(/^[0-9a-f]{16}$/);
    expect(chunk.timestampMs).toBeGreaterThan(0);
  });
});

describe('transcriptChunk: buildChunks — tool_use+result pairing', () => {
  function toolUse(id: string, name: string, input: Record<string, unknown> = {}, ts = new Date('2026-01-01T00:00:00Z')): ToolUseEvent {
    return { kind: 'tool_use', id, name, input, timestamp: ts };
  }

  function toolResult(toolUseId: string, text: string, isError = false, ts = new Date('2026-01-01T00:00:01Z')): ToolResultEvent {
    return { kind: 'tool_result', toolUseId, text, isError, timestamp: ts };
  }

  it('tool_use paired with tool_result → single chunk with result text', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Read', { file_path: 'src/foo.ts' }),
      toolResult('tu-1', 'file contents here'),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    // tool_use + consumed tool_result = 1 chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('tool_call');
    expect(chunks[0].text).toContain('[tool_call]');
    expect(chunks[0].text).toContain('tool:Read');
    expect(chunks[0].text).toContain('result: file contents here');
    expect(chunks[0].toolName).toBe('Read');
  });

  it('tool_use without matching tool_result → chunk emitted without result', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Bash', { command: 'npm test' }),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('[tool_call]');
    expect(chunks[0].text).toContain('tool:Bash');
    expect(chunks[0].text).not.toContain('result:');
  });

  it('orphan tool_result → standalone chunk with [tool_result] prefix', () => {
    const events: NormalizedEvent[] = [
      toolResult('tu-missing', 'orphan output'),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('[tool_result]');
    expect(chunks[0].text).toContain('orphan output');
  });

  it('tool_result with isError → [error] tag in prefix', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Bash', { command: 'false' }),
      toolResult('tu-1', 'exit code 1', true),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toContain('[error]');
  });

  it('paired tool_result is consumed — no duplicate orphan chunk', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Read', { file_path: 'src/foo.ts' }),
      toolResult('tu-1', 'contents'),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    // Exactly 1 chunk: the paired tool_use+result
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe('tool_call');
  });

  it('textHash is deterministic SHA-256 (16-char hex prefix)', () => {
    const events: NormalizedEvent[] = [userEvent('deterministic text')];
    const chunks1 = buildChunks({ events, ...DEFAULT_OPTS });
    const chunks2 = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks1[0].textHash).toBe(chunks2[0].textHash);
    expect(chunks1[0].textHash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('transcriptChunk: truncation, file paths, multi-event stream', () => {
  function toolUse(id: string, name: string, input: Record<string, unknown> = {}, ts = new Date('2026-01-01T00:00:00Z')): ToolUseEvent {
    return { kind: 'tool_use', id, name, input, timestamp: ts };
  }

  function toolResult(toolUseId: string, text: string, ts = new Date('2026-01-01T00:00:01Z')): ToolResultEvent {
    return { kind: 'tool_result', toolUseId, text, isError: false, timestamp: ts };
  }

  it('text longer than 6000 chars → truncated', () => {
    const longText = 'a'.repeat(10000);
    const events: NormalizedEvent[] = [userEvent(longText)];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text.length).toBeLessThanOrEqual(6000 + 20); // prefix + truncated
  });

  it('tool input JSON truncated at 2000 chars via formatToolInput', () => {
    const bigInput: Record<string, unknown> = { file_path: 'src/foo.ts', data: 'x'.repeat(5000) };
    const events: NormalizedEvent[] = [toolUse('tu-1', 'Edit', bigInput)];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    // The full text should not contain the full 5000-char data
    // formatToolInput truncates JSON to 2000 chars; prefix + tool name + file path + "result: " ~ 65 chars
    expect(chunks[0].text.length).toBeLessThanOrEqual(2100);
  });

  it('file paths extracted from file_path, filePath, path, paths array', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Read', { file_path: 'src/a.ts' }),
      toolUse('tu-2', 'Read', { filePath: 'src/b.ts' }),
      toolUse('tu-3', 'Read', { path: 'src/c.ts' }),
      toolUse('tu-4', 'Read', { paths: ['src/d.ts', 'src/e.ts'] }),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(4);
    expect(chunks[0].filePaths).toContain('src/a.ts');
    expect(chunks[1].filePaths).toContain('src/b.ts');
    expect(chunks[2].filePaths).toContain('src/c.ts');
    expect(chunks[3].filePaths).toContain('src/d.ts');
    expect(chunks[3].filePaths).toContain('src/e.ts');
  });

  it('file paths extracted from tool_result.file.path', () => {
    const events: NormalizedEvent[] = [
      toolUse('tu-1', 'Read', { file_path: 'src/foo.ts' }),
      toolResult('tu-1', 'contents', new Date('2026-01-01T00:00:01Z')),
    ];
    // Override to add file to result
    (events[1] as ToolResultEvent).file = { path: 'src/bar.ts' };
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].filePaths).toContain('src/foo.ts');
    expect(chunks[0].filePaths).toContain('src/bar.ts');
  });

  it('mixed event stream → correct chunk count and ordinals', () => {
    const events: NormalizedEvent[] = [
      userEvent('q1'),                                    // 0
      assistantEvent('a1'),                              // 1
      toolUse('tu-1', 'Read', { file_path: 'x.ts' }),  // 2
      toolResult('tu-1', 'ok'),                          // 3 (consumed)
      userEvent('q2'),                                    // 4
      assistantEvent('a2'),                              // 5
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    // 2 user + 2 assistant + 1 tool pair = 5 chunks (tool_result consumed)
    expect(chunks).toHaveLength(5);
    expect(chunks[0].chunkId).toBe('sess-1:0');
    expect(chunks[1].chunkId).toBe('sess-1:1');
    expect(chunks[2].chunkId).toBe('sess-1:2'); // tool_use
    expect(chunks[3].chunkId).toBe('sess-1:4'); // user_text (tool_result at 3 consumed)
    expect(chunks[4].chunkId).toBe('sess-1:5');
  });

  it('sourcePath set on every chunk', () => {
    const events: NormalizedEvent[] = [
      userEvent('test'),
      assistantEvent('response'),
      toolUse('tu-1', 'Bash', { command: 'ls' }),
    ];
    const chunks = buildChunks({ events, ...DEFAULT_OPTS });
    for (const chunk of chunks) {
      expect(chunk.sourcePath).toBe('/tmp/test.jsonl');
    }
  });
});
