import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type {
  BrainDaemonRequest,
  BrainDaemonResponse,
  BrainToolResult,
  CallerContext,
  ToolDefinition,
} from '../daemon/protocol.js';
import { BRAIN_DAEMON_PROTOCOL_VERSION, isRecord, normalizeToolResult, safeJsonLineStringify } from '../daemon/protocol.js';
import { resolveBrainPaths } from '../daemon/paths.js';

export interface BrainDaemonClientOptions {
  socketPath?: string;
  requestTimeoutMs?: number;
}

type ClientRequestInput =
  | { method: 'ping'; caller?: CallerContext }
  | { method: 'listTools'; caller?: CallerContext }
  | { method: 'callTool'; toolName: string; args: Record<string, unknown>; caller: CallerContext }
  | { method: 'shutdown'; caller?: CallerContext };

export class BrainDaemonClient {
  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;

  constructor(options: BrainDaemonClientOptions = {}) {
    this.socketPath = options.socketPath ?? resolveBrainPaths().socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  ping(caller?: CallerContext): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>({ method: 'ping', caller });
  }

  listTools(caller?: CallerContext): Promise<ToolDefinition[]> {
    return this.request<ToolDefinition[]>({ method: 'listTools', caller });
  }

  async callTool(toolName: string, args: Record<string, unknown>, caller: CallerContext): Promise<BrainToolResult> {
    const result = await this.request<unknown>({ method: 'callTool', toolName, args, caller });
    return normalizeToolResult(result);
  }

  private request<T>(request: ClientRequestInput): Promise<T> {
    const fullRequest = {
      ...request,
      id: randomUUID(),
      protocolVersion: BRAIN_DAEMON_PROTOCOL_VERSION,
    } as BrainDaemonRequest;

    return new Promise<T>((resolve, reject) => {
      const socket = net.connect(this.socketPath);
      let buffer = '';
      let settled = false;

      const timeout = setTimeout(() => {
        finish(new Error(`brain-daemon request timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      timeout.unref();

      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };

      socket.setEncoding('utf8');
      socket.once('connect', () => {
        socket.write(`${safeJsonLineStringify(fullRequest)}\n`);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex < 0) return;
        const line = buffer.slice(0, newlineIndex).trim();
        try {
          const response = JSON.parse(line) as unknown;
          if (!isDaemonResponse(response)) throw new Error('invalid daemon response');
          if (!response.ok) {
            finish(new Error(response.error.message));
            return;
          }
          finish(undefined, response.result as T);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('error', (error) => finish(error));
    });
  }
}

function isDaemonResponse(value: unknown): value is BrainDaemonResponse {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    (value.ok || isRecord(value.error));
}
