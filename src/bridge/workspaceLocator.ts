import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

export const BRAIN_ATLAS_DIR = '.brain';
export const ATLAS_DB_FILENAME = 'atlas.sqlite';

export interface DiscoveredRoot {
  /** Derived workspace name (slugified dir basename). */
  workspace: string;
  /** Absolute path to the repo root. */
  sourceRoot: string;
  /** True if a brain-mcp Atlas DB exists at this root. */
  indexed: boolean;
  /** Preferred atlas sqlite path for new brain-mcp writes. */
  dbPath: string;
  /** Existing DB path when indexed. */
  existingDbPath: string | null;
  /** True if this root has a .git entry (file or directory). */
  hasGit: boolean;
}

function getScanDirs(currentSourceRoot: string): Set<string> {
  const scanDirs = new Set<string>();
  scanDirs.add(path.dirname(currentSourceRoot));
  const homeDir = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir().trim();
  if (homeDir) scanDirs.add(homeDir);
  return scanDirs;
}

export function slugifyWorkspaceName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
}

export function preferredAtlasDbPath(sourceRoot: string): string {
  return path.join(sourceRoot, BRAIN_ATLAS_DIR, ATLAS_DB_FILENAME);
}

export function resolveExistingAtlasDbPath(sourceRoot: string): { dbPath: string } | null {
  const brainPath = preferredAtlasDbPath(sourceRoot);
  if (fs.existsSync(brainPath)) return { dbPath: brainPath };
  return null;
}

export function getWritableAtlasPathForRoot(sourceRoot: string): string {
  return resolveExistingAtlasDbPath(sourceRoot)?.dbPath ?? preferredAtlasDbPath(sourceRoot);
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

        const existing = resolveExistingAtlasDbPath(childPath);
        const gitPath = path.join(childPath, '.git');
        const hasGit = fs.existsSync(gitPath);
        const indexed = existing != null;

        if (!indexed && !hasGit) continue;

        seen.add(childPath);
        results.push({
          workspace: slugifyWorkspaceName(path.basename(childPath)),
          sourceRoot: childPath,
          indexed,
          dbPath: preferredAtlasDbPath(childPath),
          existingDbPath: existing?.dbPath ?? null,
          hasGit,
        });
      }
    } catch {
      // Ignore unreadable scan roots.
    }
  }

  results.sort((a, b) => {
    if (a.indexed !== b.indexed) return a.indexed ? -1 : 1;
    return a.workspace.localeCompare(b.workspace);
  });

  return results;
}
