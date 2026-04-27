import type { AtlasDatabase } from '../atlas/db.js';
import { resolveExistingAtlasDbPath } from './workspaceLocator.js';

export interface AttachedAtlas {
  alias: string;
  workspace: string;
  sourceRoot: string;
  dbPath: string;
  lastUsed: number;
}

export interface AttachCoordinatorOptions {
  maxAttached?: number;
  aliasPrefix?: string;
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function makeAlias(prefix: string, index: number): string {
  return `${prefix}${index}`;
}

/**
 * Owns SQLite ATTACH/DETACH state for a single home DB connection.
 *
 * Relay Atlas currently routes cross-workspace calls through separate DB
 * handles. Brain-mcp's daemon needs an explicit attached-DB coordinator so
 * home-side synapse writes and repo-local Atlas rows can participate in one
 * logical request while still keeping repo Atlas files separate on disk.
 */
export class AttachCoordinator {
  private readonly maxAttached: number;
  private readonly aliasPrefix: string;
  private readonly attached = new Map<string, AttachedAtlas>();
  private readonly aliases = new Set<string>();

  constructor(
    private readonly homeDb: AtlasDatabase,
    options: AttachCoordinatorOptions = {},
  ) {
    this.maxAttached = Math.max(1, options.maxAttached ?? 3);
    this.aliasPrefix = options.aliasPrefix ?? 'atlas_';
  }

  ensureAttached(workspace: string, sourceRoot: string): AttachedAtlas | null {
    const existingPath = resolveExistingAtlasDbPath(sourceRoot);
    if (!existingPath) return null;

    const cached = this.attached.get(existingPath.dbPath);
    if (cached) {
      cached.lastUsed = Date.now();
      return cached;
    }

    this.evictIfNeeded();
    const alias = this.nextAlias();
    this.homeDb.exec(`ATTACH DATABASE ${quoteSqlString(existingPath.dbPath)} AS ${quoteIdentifier(alias)}`);

    const attached: AttachedAtlas = {
      alias,
      workspace,
      sourceRoot,
      dbPath: existingPath.dbPath,
      lastUsed: Date.now(),
    };
    this.attached.set(existingPath.dbPath, attached);
    this.aliases.add(alias);
    return attached;
  }

  detach(dbPathOrAlias: string): void {
    const entry = [...this.attached.values()].find((attached) =>
      attached.dbPath === dbPathOrAlias || attached.alias === dbPathOrAlias,
    );
    if (!entry) return;

    try {
      this.homeDb.exec(`DETACH DATABASE ${quoteIdentifier(entry.alias)}`);
    } finally {
      this.attached.delete(entry.dbPath);
      this.aliases.delete(entry.alias);
    }
  }

  detachAll(): void {
    for (const entry of [...this.attached.values()]) {
      this.detach(entry.alias);
    }
  }

  list(): AttachedAtlas[] {
    return [...this.attached.values()].sort((left, right) => left.alias.localeCompare(right.alias));
  }

  private evictIfNeeded(): void {
    while (this.attached.size >= this.maxAttached) {
      const lru = [...this.attached.values()].sort((left, right) => left.lastUsed - right.lastUsed)[0];
      if (!lru) return;
      this.detach(lru.alias);
    }
  }

  private nextAlias(): string {
    let index = 0;
    while (this.aliases.has(makeAlias(this.aliasPrefix, index))) {
      index += 1;
    }
    return makeAlias(this.aliasPrefix, index);
  }
}
