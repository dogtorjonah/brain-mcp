export const BRAIN_DAEMON_PROTOCOL_VERSION = 1;

export interface BrainContentItem {
  type: string;
  [key: string]: unknown;
}

export interface BrainToolResult {
  content: BrainContentItem[];
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface CallerContext {
  cwd: string;
  pid: number;
  ppid: number;
  startedAt: number;
  identity?: string;
  sessionId?: string;
  wrapperPid?: number;
  projectDir?: string;
  env: Record<string, string>;
}

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  annotations?: Record<string, unknown>;
}

export type BrainDaemonRequest =
  | {
      id: string;
      protocolVersion: number;
      method: 'ping';
      caller?: CallerContext;
    }
  | {
      id: string;
      protocolVersion: number;
      method: 'listTools';
      caller?: CallerContext;
    }
  | {
      id: string;
      protocolVersion: number;
      method: 'callTool';
      caller: CallerContext;
      toolName: string;
      args: Record<string, unknown>;
    }
  | {
      id: string;
      protocolVersion: number;
      method: 'shutdown';
      caller?: CallerContext;
    };

export type BrainDaemonResponse =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: {
        code: string;
        message: string;
        stack?: string;
      };
    };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeToolResult(value: unknown): BrainToolResult {
  if (isRecord(value) && Array.isArray(value.content)) {
    const content = value.content
      .filter(isRecord)
      .map((item) => ({ ...item, type: typeof item.type === 'string' ? item.type : 'text' }));
    return {
      content,
      structuredContent: value.structuredContent,
      isError: value.isError === true,
      _meta: isRecord(value._meta) ? value._meta : undefined,
    };
  }

  if (typeof value === 'string') {
    return { content: [{ type: 'text', text: value }] };
  }

  return {
    content: [{ type: 'text', text: safeJsonStringify(value) }],
    structuredContent: value,
  };
}

export function normalizeError(error: unknown): BrainToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

export function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, innerValue: unknown) => (typeof innerValue === 'bigint' ? innerValue.toString() : innerValue),
      2,
    );
  } catch {
    return String(value);
  }
}

export function safeJsonLineStringify(value: unknown): string {
  try {
    return JSON.stringify(
      value,
      (_key, innerValue: unknown) => (typeof innerValue === 'bigint' ? innerValue.toString() : innerValue),
    );
  } catch {
    return JSON.stringify(String(value));
  }
}
