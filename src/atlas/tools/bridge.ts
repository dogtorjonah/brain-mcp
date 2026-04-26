/**
 * Atlas Bridge Tool — Cross-workspace search for atlas-mcp-server
 *
 * Discovers atlas databases from sibling repositories on the local machine
 * and provides unified search/lookup across workspace boundaries.
 *
 * Discovery: scans parent directory of the current source root for
 * sibling repos with .atlas/atlas.sqlite files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolWithDescription } from './helpers.js';
import type { AtlasRuntime } from '../types.js';
import { openAtlasDatabase, type AtlasDatabase } from '../db.js';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeDb {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
  dbPath: string;
}

// ---------------------------------------------------------------------------
// Database pool
// ---------------------------------------------------------------------------

const bridgeDbs = new Map<string, BridgeDb>();
/**
 * Writable-mode DB pool for cross-workspace WRITE operations (reindex, etc.).
 * Separate from `bridgeDbs` because that pool opens readonly — great for
 * queries, useless for reindex pipelines that insert/update atlas_files rows.
 *
 * Keyed by absolute dbPath. Handles stay open for the process lifetime once
 * acquired; closeBridgeDb evicts both pools so init's pre-reset cleanup still
 * works (a stale writable handle would block file deletion on some platforms
 * and, more importantly, would keep stale schema state after a reset).
 */
const writableDbs = new Map<string, AtlasDatabase>();

/** Close and remove a bridge DB handle from BOTH pools (e.g. before nuking it). */
export function closeBridgeDb(dbPath: string): void {
  const entry = bridgeDbs.get(dbPath);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    bridgeDbs.delete(dbPath);
  }
  closeWritableBridgeDb(dbPath);
}

/** Close only the writable handle for a dbPath (readonly pool is left untouched). */
export function closeWritableBridgeDb(dbPath: string): void {
  const db = writableDbs.get(dbPath);
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    writableDbs.delete(dbPath);
  }
}

/**
 * Open (or return a cached handle for) a writable atlas DB at `dbPath`.
 * Runs migrations and vec0 healing on first open — cheap no-op on subsequent
 * opens. Callers are expected NOT to close the returned handle; the pool owns
 * the lifetime. Use closeBridgeDb/closeWritableBridgeDb to evict.
 */
export function openWritableBridgeDb(
  dbPath: string,
  migrationDir: string,
  sqliteVecExtension?: string,
  embeddingDimensions?: number,
): AtlasDatabase {
  const existing = writableDbs.get(dbPath);
  if (existing) return existing;
  const db = openAtlasDatabase({ dbPath, migrationDir, sqliteVecExtension, embeddingDimensions });
  writableDbs.set(dbPath, db);
  return db;
}

function loadSqliteVec(db: AtlasDatabase): void {
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') {
      db.loadExtension(sv.getLoadablePath());
    }
  } catch (err) {
    console.warn('[atlas-bridge] sqlite-vec extension not available:', err instanceof Error ? err.message : String(err));
  }
}

export function openBridgeDb(workspace: string, sourceRoot: string): BridgeDb | null {
  const dbPath = path.join(sourceRoot, '.atlas', 'atlas.sqlite');
  const existing = bridgeDbs.get(dbPath);
  if (existing) return existing;

  if (!fs.existsSync(dbPath)) return null;

  try {
    const db: AtlasDatabase = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    loadSqliteVec(db);

    const entry: BridgeDb = { db, workspace, sourceRoot, dbPath };
    bridgeDbs.set(dbPath, entry);
    return entry;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** A discoverable root on the local machine — may or may not have an atlas yet. */
export interface DiscoveredRoot {
  /** Derived workspace name (slugified dir basename). */
  workspace: string;
  /** Absolute path to the repo root. */
  sourceRoot: string;
  /** True if `.atlas/atlas.sqlite` exists at this root. */
  indexed: boolean;
  /** Path to the atlas sqlite (set regardless of existence; used as target on bootstrap). */
  dbPath: string;
  /** True if this root has a `.git` entry (file or directory). */
  hasGit: boolean;
}

/** Directories scanned for sibling repos / atlases. */
function getScanDirs(currentSourceRoot: string): Set<string> {
  const scanDirs = new Set<string>();
  scanDirs.add(path.dirname(currentSourceRoot));
  const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir().trim();
  if (homeDir) {
    scanDirs.add(homeDir);
  }
  return scanDirs;
}

/** Normalize a directory basename into a workspace slug. */
export function slugifyWorkspaceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export function normalizeCurrentWorkspaceAlias(
  sourceRoot: string,
  runtimeWorkspace: string,
  requestedWorkspace?: string | null,
): string | undefined {
  const trimmed = requestedWorkspace?.trim();
  if (!trimmed) return undefined;

  const currentDirAlias = slugifyWorkspaceName(path.basename(sourceRoot));
  if (currentDirAlias && currentDirAlias === trimmed && currentDirAlias !== runtimeWorkspace) {
    return runtimeWorkspace;
  }

  return trimmed;
}

/**
 * Scan common parent dirs for all discoverable roots — both indexed (have an
 * atlas database) and indexable (have a `.git` directory but no atlas yet).
 *
 * Dedupes by absolute sourceRoot so a repo that happens to live both next to
 * the current source and in $HOME is not double-reported.
 */
export function discoverAllRoots(currentSourceRoot: string): DiscoveredRoot[] {
  const resolvedCurrentSourceRoot = path.resolve(currentSourceRoot);
  const seen = new Set<string>();
  const results: DiscoveredRoot[] = [];

  for (const scanDir of getScanDirs(currentSourceRoot)) {
    if (!fs.existsSync(scanDir)) continue;
    try {
      const entries = fs.readdirSync(scanDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (!entry.isDirectory()) continue;

        const childPath = path.resolve(scanDir, entry.name);
        if (childPath === resolvedCurrentSourceRoot) continue;
        if (seen.has(childPath)) continue;

        const atlasPath = path.join(childPath, '.atlas', 'atlas.sqlite');
        const gitPath = path.join(childPath, '.git');
        const indexed = fs.existsSync(atlasPath);
        const hasGit = fs.existsSync(gitPath);

        // Only surface roots that are either already indexed or are git repos
        // ready to be indexed — ignore random directories.
        if (!indexed && !hasGit) continue;

        seen.add(childPath);
        results.push({
          workspace: slugifyWorkspaceName(path.basename(childPath)),
          sourceRoot: childPath,
          indexed,
          dbPath: atlasPath,
          hasGit,
        });
      }
    } catch {
      // permission errors
    }
  }

  // Sort: indexed first (alphabetical), then indexable git repos (alphabetical).
  results.sort((a, b) => {
    if (a.indexed !== b.indexed) return a.indexed ? -1 : 1;
    return a.workspace.localeCompare(b.workspace);
  });

  return results;
}

/** Scan common parent dirs for sibling atlas databases (indexed workspaces only). */
export function discoverWorkspaces(currentSourceRoot: string): BridgeDb[] {
  const results: BridgeDb[] = [];
  for (const root of discoverAllRoots(currentSourceRoot)) {
    if (!root.indexed) continue;
    const bdb = openBridgeDb(root.workspace, root.sourceRoot);
    if (bdb) results.push(bdb);
  }
  return results;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

function getFileCount(db: AtlasDatabase, workspace: string): number {
  try {
    const row = db.prepare('SELECT count(*) as cnt FROM atlas_files WHERE workspace = ?').get(workspace) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Cross-workspace DB resolution
// ---------------------------------------------------------------------------

export interface ResolvedWorkspace {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
}

/**
 * Resolve the correct database handle for a workspace parameter.
 * Returns runtime's own db when workspace matches (or is omitted),
 * otherwise discovers and opens the target workspace's bridge db.
 */
export function resolveWorkspaceDb(
  runtime: AtlasRuntime,
  workspace?: string,
): ResolvedWorkspace | { error: string } {
  const targetWorkspace = normalizeCurrentWorkspaceAlias(
    runtime.config.sourceRoot,
    runtime.config.workspace,
    workspace,
  ) ?? runtime.config.workspace;

  // Current workspace — use runtime db directly
  if (targetWorkspace === runtime.config.workspace) {
    return {
      db: runtime.db,
      workspace: runtime.config.workspace,
      sourceRoot: runtime.config.sourceRoot,
    };
  }

  // Cross-workspace — discover and open bridge db
  const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
  const target = allDbs.find((bdb) => bdb.workspace === targetWorkspace);
  if (!target) {
    const available = allDbs.map((d) => d.workspace).join(', ');
    return { error: `Workspace "${targetWorkspace}" not found. Available: ${available}` };
  }

  return {
    db: target.db,
    workspace: target.workspace,
    sourceRoot: target.sourceRoot,
  };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBridgeTools(server: McpServer, runtime: AtlasRuntime): void {
  // ── atlas_bridge_list ──
  toolWithDescription(server)(
    'atlas_bridge_list',
    'Discover all local atlas-bearing repos AND indexable git repos on this machine. Indexed workspaces are listed with file counts; unindexed git repos are listed as bootstrap candidates (call atlas_admin action=init workspace=<name> confirm=true to create a fresh atlas for them).',
    {},
    async () => {
      const roots = discoverAllRoots(runtime.config.sourceRoot);
      if (roots.length === 0) {
        return { content: [{ type: 'text', text: 'No atlas databases or git repos found on this machine.' }] };
      }

      const indexedLines: string[] = [];
      const indexableLines: string[] = [];
      for (const root of roots) {
        if (root.indexed) {
          const bdb = openBridgeDb(root.workspace, root.sourceRoot);
          const count = bdb ? getFileCount(bdb.db, bdb.workspace) : 0;
          indexedLines.push(`📦 ${root.workspace} — ${count} files\n   ${root.sourceRoot}`);
        } else if (root.hasGit) {
          indexableLines.push(`🌱 ${root.workspace} — not indexed yet (git repo)\n   ${root.sourceRoot}`);
        }
      }

      const sections: string[] = [];
      if (indexedLines.length > 0) {
        sections.push(`Indexed workspaces (${indexedLines.length}):\n${indexedLines.join('\n\n')}`);
      }
      if (indexableLines.length > 0) {
        sections.push(`Indexable (not yet indexed) git repos (${indexableLines.length}):\n${indexableLines.join('\n\n')}`);
      }

      const tips: string[] = [];
      if (indexedLines.length > 0) {
        tips.push('💡 Query any indexed workspace with `atlas_query action=search workspace=<name>`.');
      }
      if (indexableLines.length > 0) {
        tips.push('💡 Bootstrap an unindexed repo with `atlas_admin action=init workspace=<name> confirm=true`.');
      }

      return {
        content: [{
          type: 'text',
          text: [
            `🌉 Atlas Bridge — ${indexedLines.length} indexed, ${indexableLines.length} indexable`,
            '',
            sections.join('\n\n'),
            tips.length > 0 ? '\n' + tips.join('\n') : '',
          ].join('\n'),
        }],
      };
    },
  );

}
