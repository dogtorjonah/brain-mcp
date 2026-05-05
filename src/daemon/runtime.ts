import path from 'node:path';
import { HomeDb } from '../home/db.js';
import { IdentityStore } from '../identity/store.js';
import { EdgeEmitter } from '../edges/emitter.js';
import type { CallerContext } from './protocol.js';
import { AtlasToolPool } from './atlasToolPool.js';
import type { BrainPathConfig } from './paths.js';
import { WorkerManager } from './workers.js';
import { getCallerContext, withCallerContext } from './requestContext.js';

export interface BrainDaemonRuntimeOptions {
  paths: BrainPathConfig;
  atlasPoolSize?: number;
}

export class BrainDaemonRuntime {
  readonly startedAt = Date.now();
  readonly homeDb: HomeDb;
  readonly identityStore: IdentityStore;
  readonly edgeEmitter: EdgeEmitter;
  readonly atlasTools: AtlasToolPool;
  readonly workers = new WorkerManager();

  constructor(private readonly options: BrainDaemonRuntimeOptions) {
    this.homeDb = HomeDb.open({
      path: options.paths.homeDbPath,
      migrationsDir: options.paths.homeMigrationsDir,
    });
    this.identityStore = new IdentityStore(this.homeDb);
    this.edgeEmitter = new EdgeEmitter(this.homeDb);
    this.atlasTools = new AtlasToolPool({
      maxEntries: options.atlasPoolSize,
      edgeEmitter: this.edgeEmitter,
    });
  }

  withCallerContext<T>(context: CallerContext, fn: () => T): T {
    // Resolve (or auto-mint) the identity for this caller before any tool
    // runs. The result is mutated onto the context so getCurrentIdentity()
    // and downstream tools (brain_rebirth, brain_handoff, edges) all see a
    // real name instead of falling through to 'unknown'.
    this.ensureIdentityBound(context);
    return withCallerContext(context, fn);
  }

  getCallerContext(): CallerContext | undefined {
    return getCallerContext();
  }

  getCurrentIdentity(): string | undefined {
    const context = this.getCallerContext();
    return context?.identity ?? context?.env.CLAUDE_IDENTITY;
  }

  getCurrentSessionId(): string | undefined {
    const context = this.getCallerContext();
    return context?.sessionId ?? context?.env.CLAUDE_SESSION_ID ?? this.synthesizeSessionId(context);
  }

  /**
   * Ensure the caller has an identity bound and a session row written.
   * Idempotent: subsequent calls within the same session are no-ops once
   * `session_identity` is populated. Runs on every tool call but the work
   * after the first call is just a single SELECT.
   */
  private ensureIdentityBound(context: CallerContext): void {
    const sessionId = context.sessionId
      ?? context.env.CLAUDE_SESSION_ID
      ?? this.synthesizeSessionId(context);

    // Fast path: session is already bound. Reuse the bound identity and
    // skip the resolver entirely.
    if (sessionId) {
      const existing = this.identityStore.getSessionBinding(sessionId);
      if (existing) {
        context.identity = existing.identityName;
        context.sessionId = sessionId;
        return;
      }
    }

    const wrapperPid = context.wrapperPid && context.wrapperPid > 1
      ? context.wrapperPid
      : Number(context.env.BRAIN_WRAPPER_PID || context.env.REBIRTH_WRAPPER_PID || 0) || undefined;

    const resolved = this.identityStore.resolveOrMintIdentity({
      envIdentity: context.identity ?? context.env.CLAUDE_IDENTITY,
      wrapperPid,
      sessionId,
      cwd: context.cwd,
    });

    context.identity = resolved.name;
    context.sessionId = sessionId;
  }

  /**
   * Synthesize a stable session id when Claude Code doesn't push CLAUDE_SESSION_ID
   * into the environment. Keyed on wrapperPid + the MCP server's process startedAt
   * so a fresh `brain-claude` invocation, a `/mcp reconnect`, and a respawn each
   * land sensible boundaries:
   *   - same wrapper + same MCP server boot  → same synthetic session
   *   - same wrapper + MCP reconnect         → new synthetic session (server restarted)
   *   - new wrapper                          → new synthetic session
   */
  private synthesizeSessionId(context: CallerContext | undefined): string | undefined {
    if (!context) return undefined;
    const wrapperPid = context.wrapperPid
      ?? Number(context.env.BRAIN_WRAPPER_PID || context.env.REBIRTH_WRAPPER_PID || 0)
      ?? undefined;
    if (!wrapperPid || wrapperPid <= 1) return undefined;
    return `brain-${wrapperPid}-${context.startedAt}`;
  }

  getCurrentProjectSlug(): string | undefined {
    const context = this.getCallerContext();
    if (!context?.cwd) return undefined;
    return path.basename(context.cwd).toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  }

  snapshot(): Record<string, unknown> {
    return {
      uptimeMs: Date.now() - this.startedAt,
      homeDbPath: this.options.paths.homeDbPath,
      vectorEnabled: this.homeDb.hasVector,
      atlasPool: this.atlasTools.snapshot(),
      workers: this.workers.snapshot(),
    };
  }

  async close(): Promise<void> {
    await this.workers.stopAll();
    await this.atlasTools.close();
    this.homeDb.close();
  }
}
