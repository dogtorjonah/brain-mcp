import fs from 'node:fs';
import path from 'node:path';
import { CloseableLruPool } from './resourcePool.js';
import type { BrainToolResult, CallerContext, ToolDefinition } from './protocol.js';
import { normalizeError } from './protocol.js';
import { ToolRegistry } from './toolRegistry.js';

const ATLAS_TOOL_DEFINITIONS: ToolDefinition[] = [
  { name: 'atlas_changelog', description: 'Query and maintain Atlas changelog entries for the caller workspace.' },
  { name: 'atlas_commit', description: 'Record Atlas file metadata and changelog context.' },
  { name: 'atlas_query', description: 'Search, inspect, and retrieve Atlas knowledge.' },
  { name: 'atlas_graph', description: 'Run Atlas dependency graph and reachability analysis.' },
  { name: 'atlas_audit', description: 'Run Atlas quality, gap, smell, and hotspot analysis.' },
  { name: 'atlas_admin', description: 'Manage Atlas indexing, migrations, bridge discovery, and maintenance.' },
];

interface AtlasToolPoolOptions {
  maxEntries?: number;
  edgeEmitter?: unknown;
}

interface AtlasRuntimeShape {
  config: Record<string, unknown>;
  db: { close(): void };
  server?: unknown;
  edgeEmitter?: unknown;
}

type RegisterAtlasTool = (server: unknown, runtime: AtlasRuntimeShape) => void;

const WATCH_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql',
  '.py',
  '.go', '.rs', '.java', '.kt', '.swift',
  '.vue', '.svelte',
  '.md',
]);
const IGNORED_PARTS = new Set([
  '.brain', '.atlas', '.git', 'dist', 'node_modules', '.next',
  '.turbo', '.cache', 'coverage', 'build', 'out', '.vercel',
]);
const DEFAULT_REFRESH_DEBOUNCE_MS = 1_500;
const DEFAULT_REFRESH_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_BATCH = 20;

class AtlasToolClient {
  private readonly registry = new ToolRegistry();
  private coordinator: AtlasFreshnessCoordinator | null = null;

  private constructor(
    private readonly sourceRoot: string,
    private readonly runtime: AtlasRuntimeShape,
  ) {}

  static async create(
    sourceRoot: string,
    edgeEmitter?: unknown,
    options: AtlasRuntimeOpenOptions = {},
  ): Promise<AtlasToolClient> {
    const runtime = await createAtlasRuntime(sourceRoot, edgeEmitter, options);
    const client = new AtlasToolClient(sourceRoot, runtime);
    await client.captureTools();
    client.startCoordinator();
    return client;
  }

  async callTool(name: string, args: Record<string, unknown>, caller: CallerContext): Promise<BrainToolResult> {
    if (!this.registry.hasTool(name)) {
      return normalizeError(new Error(`Atlas tool "${name}" is not available for ${this.sourceRoot}`));
    }
    this.coordinator?.setCaller(caller);
    return this.registry.callTool(name, args, caller, this.runtime);
  }

  close(): void {
    this.coordinator?.close();
    this.coordinator = null;
    this.runtime.db.close();
  }

  private startCoordinator(): void {
    if (!isAutoRefreshEnabled()) {
      return;
    }
    this.coordinator = new AtlasFreshnessCoordinator(this.sourceRoot, async (files, caller) => {
      const result = await this.registry.callTool(
        'atlas_admin',
        { action: 'reindex', files, confirm: true },
        caller,
        this.runtime,
      );
      if (result.isError) {
        const text = result.content
          .map((item) => (typeof item.text === 'string' ? item.text : ''))
          .filter(Boolean)
          .join('\n');
        process.stderr.write(`[brain-daemon] atlas auto-refresh failed for ${this.sourceRoot}: ${text || 'unknown error'}\n`);
      }
    });
    this.coordinator.start();
  }

  private async captureTools(): Promise<void> {
    const captureServer = this.registry.createCaptureServer('Atlas tool: ');
    const specs: Array<[string, string]> = [
      ['../atlas/tools/changelog.js', 'registerChangelogTools'],
      ['../atlas/tools/commit.js', 'registerCommitTool'],
      ['../atlas/tools/query.js', 'registerQueryTool'],
      ['../atlas/tools/graphComposite.js', 'registerGraphCompositeTool'],
      ['../atlas/tools/audit.js', 'registerAuditTool'],
      ['../atlas/tools/admin.js', 'registerAdminTool'],
    ];

    for (const [modulePath, exportName] of specs) {
      try {
        const mod = await import(modulePath) as Record<string, unknown>;
        const register = mod[exportName];
        if (typeof register === 'function') {
          (register as RegisterAtlasTool)(captureServer, this.runtime);
        }
      } catch (error) {
        process.stderr.write(
          `[brain-daemon] atlas registrar ${exportName} unavailable: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  }
}

class AtlasFreshnessCoordinator {
  private readonly debounceMs = readPositiveInt(process.env.BRAIN_ATLAS_AUTO_REFRESH_DEBOUNCE_MS)
    ?? DEFAULT_REFRESH_DEBOUNCE_MS;
  private readonly cooldownMs = readPositiveInt(process.env.BRAIN_ATLAS_AUTO_REFRESH_COOLDOWN_MS)
    ?? DEFAULT_REFRESH_COOLDOWN_MS;
  private readonly maxBatch = readPositiveInt(process.env.BRAIN_ATLAS_AUTO_REFRESH_MAX_BATCH)
    ?? DEFAULT_MAX_BATCH;
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private readonly visitedDirs = new Set<string>();
  private readonly pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastStartedAt = 0;
  private caller: CallerContext | null = null;

  constructor(
    private readonly sourceRoot: string,
    private readonly onBatch: (files: string[], caller: CallerContext) => Promise<void>,
  ) {}

  start(): void {
    this.registerDirectory(this.sourceRoot);
  }

  setCaller(caller: CallerContext): void {
    this.caller = {
      ...caller,
      env: { ...caller.env },
    };
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.visitedDirs.clear();
    this.pending.clear();
  }

  private registerDirectory(directory: string): void {
    const absoluteDir = path.resolve(directory);
    if (this.visitedDirs.has(absoluteDir) || isIgnoredPath(absoluteDir)) {
      return;
    }
    this.visitedDirs.add(absoluteDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        this.registerDirectory(path.join(absoluteDir, entry.name));
      }
    }

    try {
      const watcher = fs.watch(absoluteDir, (eventType, filename) => {
        if (!filename) {
          return;
        }
        const absolutePath = path.join(absoluteDir, String(filename));
        if (eventType === 'rename' && pathExistsAsDirectory(absolutePath)) {
          this.registerDirectory(absolutePath);
          return;
        }
        this.schedule(absolutePath);
      });
      this.watchers.set(absoluteDir, watcher);
    } catch {
      // Watch limits and transient deletions should not take down the daemon.
    }
  }

  private schedule(absolutePath: string): void {
    if (!isWatchedFile(absolutePath) || isIgnoredPath(absolutePath)) {
      return;
    }
    const filePath = toWorkspacePath(this.sourceRoot, absolutePath);
    if (!filePath) {
      return;
    }
    this.pending.add(filePath);
    this.arm(this.debounceMs);
  }

  private arm(delayMs: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(0, delayMs));
    this.timer.unref();
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }
    if (this.running) {
      this.arm(this.cooldownMs);
      return;
    }
    const remainingCooldown = this.cooldownMs - (Date.now() - this.lastStartedAt);
    if (remainingCooldown > 0) {
      this.arm(remainingCooldown);
      return;
    }

    const batch = [...this.pending].slice(0, this.maxBatch);
    for (const filePath of batch) {
      this.pending.delete(filePath);
    }

    this.running = true;
    this.lastStartedAt = Date.now();
    try {
      await this.onBatch(batch, this.caller ?? fallbackCaller(this.sourceRoot));
    } catch (error) {
      process.stderr.write(
        `[brain-daemon] atlas auto-refresh failed for ${this.sourceRoot}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    } finally {
      this.running = false;
      if (this.pending.size > 0) {
        this.arm(this.cooldownMs);
      }
    }
  }
}

export class AtlasToolPool {
  private readonly pool: CloseableLruPool<AtlasToolClient>;
  private readonly edgeEmitter?: unknown;

  constructor(options: AtlasToolPoolOptions = {}) {
    this.pool = new CloseableLruPool(options.maxEntries ?? 8);
    this.edgeEmitter = options.edgeEmitter;
  }

  listToolDefinitions(): ToolDefinition[] {
    return ATLAS_TOOL_DEFINITIONS;
  }

  async callTool(cwd: string, name: string, args: Record<string, unknown>, caller: CallerContext): Promise<BrainToolResult> {
    try {
      const sourceRoot = findSourceRoot(cwd);
      const openOptions = resolveAtlasOpenOptions(name, args);
      const client = await this.pool.get(sourceRoot, () =>
        AtlasToolClient.create(sourceRoot, this.edgeEmitter, openOptions),
      );
      return client.callTool(name, enrichAtlasArgs(name, args, caller), caller);
    } catch (error) {
      return normalizeError(error);
    }
  }

  snapshot(): Array<{ key: string; lastUsed: number }> {
    return this.pool.snapshot();
  }

  close(): Promise<void> {
    return this.pool.closeAll();
  }
}

function enrichAtlasArgs(name: string, args: Record<string, unknown>, caller: CallerContext): Record<string, unknown> {
  if (name !== 'atlas_commit') return args;

  const identity = caller.identity ?? caller.env.CLAUDE_IDENTITY;
  const sessionId = caller.sessionId ?? caller.env.CLAUDE_SESSION_ID;
  const enriched = { ...args };

  if (identity && typeof enriched.author_identity !== 'string' && typeof enriched.authorIdentity !== 'string') {
    enriched.author_identity = identity;
  }
  if (identity && typeof enriched.author_name !== 'string' && typeof enriched.authorName !== 'string') {
    enriched.author_name = identity;
  }
  if (sessionId && typeof enriched.author_instance_id !== 'string' && typeof enriched.authorInstanceId !== 'string') {
    enriched.author_instance_id = sessionId;
  }

  return enriched;
}

function isAutoRefreshEnabled(): boolean {
  const value = process.env.BRAIN_ATLAS_AUTO_REFRESH?.trim().toLowerCase();
  return value !== '0' && value !== 'false' && value !== 'off';
}

function readPositiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function pathExistsAsDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isIgnoredPath(absolutePath: string): boolean {
  return absolutePath.split(path.sep).some((part) => IGNORED_PARTS.has(part));
}

function isWatchedFile(absolutePath: string): boolean {
  return WATCH_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

function toWorkspacePath(root: string, absolutePath: string): string | null {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function fallbackCaller(sourceRoot: string): CallerContext {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return {
    cwd: sourceRoot,
    pid: process.pid,
    ppid: process.ppid,
    startedAt: Date.now(),
    env,
  };
}

function findSourceRoot(cwd: string): string {
  let cursor = path.resolve(cwd || process.cwd());

  for (let depth = 0; depth < 64; depth += 1) {
    if (
      fs.existsSync(path.join(cursor, '.git')) ||
      fs.existsSync(path.join(cursor, '.brain'))
    ) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return path.resolve(cwd || process.cwd());
}

interface AtlasRuntimeOpenOptions {
  /** Allow `openAtlasDatabase` to create a new file. Only set for explicit init/reset. */
  allowCreate?: boolean;
  /** Forcibly claim an existing un-marked DB as brain-mcp's (for `init force=true`). */
  forceClaim?: boolean;
}

/**
 * Decide whether the caller is permitted to create / claim the atlas DB.
 * Only `atlas_admin action=init` (and `reset`) gets to scaffold a new DB —
 * every other tool call must operate on an already-initialized atlas.
 */
function resolveAtlasOpenOptions(
  toolName: string,
  args: Record<string, unknown>,
): AtlasRuntimeOpenOptions {
  if (toolName !== 'atlas_admin') return {};
  const action = typeof args.action === 'string' ? args.action : '';
  if (action === 'init' || action === 'reset') {
    return {
      allowCreate: true,
      forceClaim: args.force === true || args.force === 'true',
    };
  }
  return {};
}

async function createAtlasRuntime(
  sourceRoot: string,
  edgeEmitter?: unknown,
  openOptions: AtlasRuntimeOpenOptions = {},
): Promise<AtlasRuntimeShape> {
  const configModulePath = '../atlas/config.js';
  const dbModulePath = '../atlas/db.js';
  const migrationDirModulePath = '../atlas/migrationDir.js';
  const workspaceLocatorModulePath = '../bridge/workspaceLocator.js';

  const [configModule, dbModule, migrationModule, locatorModule] = await Promise.all([
    import(configModulePath) as Promise<Record<string, unknown>>,
    import(dbModulePath) as Promise<Record<string, unknown>>,
    import(migrationDirModulePath) as Promise<Record<string, unknown>>,
    import(workspaceLocatorModulePath) as Promise<Record<string, unknown>>,
  ]);

  const loadAtlasConfig = configModule.loadAtlasConfig;
  const openAtlasDatabase = dbModule.openAtlasDatabase;
  const getWritableAtlasPathForRoot = locatorModule.getWritableAtlasPathForRoot;
  const slugifyWorkspaceName = locatorModule.slugifyWorkspaceName;

  if (typeof loadAtlasConfig !== 'function') throw new Error('Atlas loadAtlasConfig export missing');
  if (typeof openAtlasDatabase !== 'function') throw new Error('Atlas openAtlasDatabase export missing');
  if (typeof getWritableAtlasPathForRoot !== 'function') throw new Error('Bridge getWritableAtlasPathForRoot export missing');
  if (typeof slugifyWorkspaceName !== 'function') throw new Error('Bridge slugifyWorkspaceName export missing');
  if (typeof migrationModule.ATLAS_MIGRATION_DIR !== 'string') throw new Error('ATLAS_MIGRATION_DIR export missing');

  const workspace = (slugifyWorkspaceName as (name: string) => string)(path.basename(sourceRoot));
  const dbPath = (getWritableAtlasPathForRoot as (root: string) => string)(sourceRoot);
  const config = (loadAtlasConfig as (
    argv: string[],
    defaults: { sourceRoot: string; dbPath: string; workspace: string },
  ) => Record<string, unknown>)([], { sourceRoot, dbPath, workspace });

  const db = (openAtlasDatabase as (options: Record<string, unknown>) => { close(): void })({
    dbPath: config.dbPath,
    migrationDir: migrationModule.ATLAS_MIGRATION_DIR,
    sqliteVecExtension: config.sqliteVecExtension,
    embeddingDimensions: config.embeddingDimensions,
    sourceRoot,
    allowCreate: openOptions.allowCreate ?? false,
    forceClaim: openOptions.forceClaim ?? false,
  });

  return { config, db, edgeEmitter };
}
