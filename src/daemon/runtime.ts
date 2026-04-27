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
    return context?.sessionId ?? context?.env.CLAUDE_SESSION_ID;
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
