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

class AtlasToolClient {
  private readonly registry = new ToolRegistry();

  private constructor(
    private readonly sourceRoot: string,
    private readonly runtime: AtlasRuntimeShape,
  ) {}

  static async create(sourceRoot: string, edgeEmitter?: unknown): Promise<AtlasToolClient> {
    const runtime = await createAtlasRuntime(sourceRoot, edgeEmitter);
    const client = new AtlasToolClient(sourceRoot, runtime);
    await client.captureTools();
    return client;
  }

  async callTool(name: string, args: Record<string, unknown>, caller: CallerContext): Promise<BrainToolResult> {
    if (!this.registry.hasTool(name)) {
      return normalizeError(new Error(`Atlas tool "${name}" is not available for ${this.sourceRoot}`));
    }
    return this.registry.callTool(name, args, caller, this.runtime);
  }

  close(): void {
    this.runtime.db.close();
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
      const client = await this.pool.get(sourceRoot, () => AtlasToolClient.create(sourceRoot, this.edgeEmitter));
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

async function createAtlasRuntime(sourceRoot: string, edgeEmitter?: unknown): Promise<AtlasRuntimeShape> {
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
  });

  return { config, db, edgeEmitter };
}
