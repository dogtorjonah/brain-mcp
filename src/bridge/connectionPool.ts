import { createRequire } from 'node:module';
import Database from 'better-sqlite3';
import type { AtlasRuntime } from '../atlas/types.js';
import { openAtlasDatabase, type AtlasDatabase } from '../atlas/db.js';
import {
  discoverAllRoots,
  normalizeCurrentWorkspaceAlias,
  resolveExistingAtlasDbPath,
} from './workspaceLocator.js';

const require = createRequire(import.meta.url);

export interface BridgeDb {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
  dbPath: string;
}

export interface ResolvedWorkspace {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
}

const readonlyDbs = new Map<string, BridgeDb>();
const writableDbs = new Map<string, AtlasDatabase>();

function loadSqliteVec(db: AtlasDatabase): void {
  try {
    const sv = require('sqlite-vec') as { getLoadablePath?: () => string };
    if (typeof sv.getLoadablePath === 'function') {
      db.loadExtension(sv.getLoadablePath());
    }
  } catch (err) {
    console.warn('[brain-bridge] sqlite-vec extension not available:', err instanceof Error ? err.message : String(err));
  }
}

export function closeWritableBridgeDb(dbPath: string): void {
  const db = writableDbs.get(dbPath);
  if (db) {
    try { db.close(); } catch { /* ignore */ }
    writableDbs.delete(dbPath);
  }
}

export function closeBridgeDb(dbPath: string): void {
  const entry = readonlyDbs.get(dbPath);
  if (entry) {
    try { entry.db.close(); } catch { /* ignore */ }
    readonlyDbs.delete(dbPath);
  }
  closeWritableBridgeDb(dbPath);
}

export function openBridgeDb(workspace: string, sourceRoot: string): BridgeDb | null {
  const existingPath = resolveExistingAtlasDbPath(sourceRoot);
  if (!existingPath) return null;
  const { dbPath } = existingPath;

  const existing = readonlyDbs.get(dbPath);
  if (existing) return existing;

  try {
    const db: AtlasDatabase = new Database(dbPath, { readonly: true });
    db.pragma('journal_mode = WAL');
    loadSqliteVec(db);
    const entry: BridgeDb = { db, workspace, sourceRoot, dbPath };
    readonlyDbs.set(dbPath, entry);
    return entry;
  } catch {
    return null;
  }
}

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

export function discoverWorkspaces(currentSourceRoot: string): BridgeDb[] {
  const results: BridgeDb[] = [];
  for (const root of discoverAllRoots(currentSourceRoot)) {
    if (!root.indexed) continue;
    const bridgeDb = openBridgeDb(root.workspace, root.sourceRoot);
    if (bridgeDb) results.push(bridgeDb);
  }
  return results;
}

export function resolveWorkspaceDb(
  runtime: AtlasRuntime,
  workspace?: string,
): ResolvedWorkspace | { error: string } {
  const targetWorkspace = normalizeCurrentWorkspaceAlias(
    runtime.config.sourceRoot,
    runtime.config.workspace,
    workspace,
  ) ?? runtime.config.workspace;

  if (targetWorkspace === runtime.config.workspace) {
    return {
      db: runtime.db,
      workspace: runtime.config.workspace,
      sourceRoot: runtime.config.sourceRoot,
    };
  }

  const allDbs = discoverWorkspaces(runtime.config.sourceRoot);
  const target = allDbs.find((bridgeDb) => bridgeDb.workspace === targetWorkspace);
  if (!target) {
    const available = allDbs.map((db) => db.workspace).join(', ');
    return { error: `Workspace "${targetWorkspace}" not found. Available: ${available}` };
  }

  return {
    db: target.db,
    workspace: target.workspace,
    sourceRoot: target.sourceRoot,
  };
}

