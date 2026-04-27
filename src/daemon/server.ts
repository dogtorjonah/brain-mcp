import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { BrainDaemonRequest, BrainDaemonResponse, CallerContext } from './protocol.js';
import { BRAIN_DAEMON_PROTOCOL_VERSION, isRecord, safeJsonLineStringify, safeJsonStringify } from './protocol.js';
import { ensureBrainHome, resolveBrainPaths, type BrainPathConfig } from './paths.js';
import { BrainDaemonRuntime } from './runtime.js';
import { registerDefaultTools } from './registrars.js';
import { ToolRegistry } from './toolRegistry.js';

export interface BrainDaemonOptions {
  paths?: Partial<BrainPathConfig>;
  atlasPoolSize?: number;
}

export class BrainDaemon {
  private readonly paths: BrainPathConfig;
  private readonly runtime: BrainDaemonRuntime;
  private readonly registry = new ToolRegistry();
  private socketServer: net.Server | null = null;
  private healthServer: http.Server | null = null;
  private stopping = false;

  constructor(options: BrainDaemonOptions = {}) {
    this.paths = resolveBrainPaths(options.paths);
    this.runtime = new BrainDaemonRuntime({
      paths: this.paths,
      atlasPoolSize: options.atlasPoolSize,
    });
  }

  async start(): Promise<void> {
    ensureBrainHome(this.paths);
    await registerDefaultTools(this.registry, this.runtime);
    await this.listenOnSocket();
    await this.listenForHealth();
    await this.runtime.workers.startAll();
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    const tasks: Array<Promise<void>> = [];
    if (this.socketServer) {
      tasks.push(closeServer(this.socketServer));
      this.socketServer = null;
    }
    if (this.healthServer) {
      tasks.push(closeServer(this.healthServer));
      this.healthServer = null;
    }

    await Promise.allSettled(tasks);
    await this.runtime.close();

    try {
      fs.unlinkSync(this.paths.socketPath);
    } catch {
      // Non-fatal: another daemon may have taken ownership or the file is gone.
    }
  }

  snapshot(): Record<string, unknown> {
    return {
      protocolVersion: BRAIN_DAEMON_PROTOCOL_VERSION,
      socketPath: this.paths.socketPath,
      healthPort: this.paths.healthPort,
      tools: this.registry.listTools().map((tool) => tool.name),
      ...this.runtime.snapshot(),
    };
  }

  private async listenOnSocket(): Promise<void> {
    if (fs.existsSync(this.paths.socketPath)) {
      const live = await canConnect(this.paths.socketPath);
      if (live) {
        throw new Error(`brain-daemon socket already active at ${this.paths.socketPath}`);
      }
      fs.unlinkSync(this.paths.socketPath);
    }

    const server = net.createServer((socket) => this.handleSocket(socket));
    this.socketServer = server;

    server.listen(this.paths.socketPath);
    await once(server, 'listening');
    fs.chmodSync(this.paths.socketPath, 0o600);
  }

  private async listenForHealth(): Promise<void> {
    const server = http.createServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/status' || req.url === '/') {
        const body = safeJsonStringify(this.snapshot());
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(body);
        return;
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
    });

    this.healthServer = server;
    await new Promise<void>((resolve) => {
      server.once('error', (error) => {
        process.stderr.write(`[brain-daemon] health server disabled: ${error.message}\n`);
        resolve();
      });
      server.listen(this.paths.healthPort, '127.0.0.1', () => resolve());
    });
  }

  private handleSocket(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) {
          void this.handleLine(socket, line);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    let request: BrainDaemonRequest;
    try {
      request = parseRequest(line);
    } catch (error) {
      writeResponse(socket, {
        id: 'unknown',
        ok: false,
        error: {
          code: 'bad_request',
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    try {
      const result = await this.dispatch(request);
      writeResponse(socket, { id: request.id, ok: true, result });
    } catch (error) {
      writeResponse(socket, {
        id: request.id,
        ok: false,
        error: {
          code: 'dispatch_error',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
      });
    }
  }

  private async dispatch(request: BrainDaemonRequest): Promise<unknown> {
    switch (request.method) {
      case 'ping':
        return this.snapshot();
      case 'listTools':
        return this.registry.listTools();
      case 'callTool': {
        const caller = request.caller;
        return this.runtime.withCallerContext(
          caller,
          () => this.registry.callTool(request.toolName, request.args, caller, this.runtime),
        );
      }
      case 'shutdown':
        setTimeout(() => {
          void this.stop();
        }, 10).unref();
        return { shuttingDown: true };
    }
  }
}

function parseRequest(line: string): BrainDaemonRequest {
  const parsed = JSON.parse(line) as unknown;
  if (!isRecord(parsed)) throw new Error('request must be a JSON object');
  if (typeof parsed.id !== 'string') throw new Error('request.id must be a string');
  if (parsed.protocolVersion !== BRAIN_DAEMON_PROTOCOL_VERSION) {
    throw new Error(`unsupported protocolVersion: ${String(parsed.protocolVersion)}`);
  }
  if (parsed.method === 'ping' || parsed.method === 'listTools' || parsed.method === 'shutdown') {
    return parsed as BrainDaemonRequest;
  }
  if (parsed.method === 'callTool') {
    if (typeof parsed.toolName !== 'string') throw new Error('callTool.toolName must be a string');
    if (!isRecord(parsed.args)) throw new Error('callTool.args must be an object');
    if (!isCallerContext(parsed.caller)) throw new Error('callTool.caller is invalid');
    return parsed as BrainDaemonRequest;
  }
  throw new Error(`unknown method: ${String(parsed.method)}`);
}

function isCallerContext(value: unknown): value is CallerContext {
  return isRecord(value) &&
    typeof value.cwd === 'string' &&
    typeof value.pid === 'number' &&
    typeof value.ppid === 'number' &&
    typeof value.startedAt === 'number' &&
    isRecord(value.env);
}

function writeResponse(socket: net.Socket, response: BrainDaemonResponse): void {
  socket.write(`${safeJsonLineStringify(response)}\n`);
}

async function closeServer(server: net.Server | http.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const done = (value: boolean) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(200);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

export function describeAddress(server: net.Server): string {
  const address = server.address();
  if (!address) return 'not listening';
  return typeof address === 'string' ? address : `${(address as AddressInfo).address}:${(address as AddressInfo).port}`;
}
