import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getAtlasFile, listImportedBy, populateFts, upsertFileRecord } from './db.js';
import { runCrossref } from './pipeline/crossref.js';
import type { ScanFileInfo } from './pipeline/scan.js';
import type { AtlasFileRecord, AtlasRuntime } from './types.js';

const WATCH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.md']);
const DEBOUNCE_MS = 5_000;
const IGNORED_PARTS = new Set(['.brain', '.atlas', '.git', 'dist', 'node_modules']);

function toWorkspacePath(root: string, absolutePath: string): string | null {
  const relative = path.relative(root, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep).join('/');
}

function isIgnoredPath(absolutePath: string): boolean {
  const parts = absolutePath.split(path.sep);
  return parts.some((part) => IGNORED_PARTS.has(part));
}

function isWatchedFile(absolutePath: string): boolean {
  return WATCH_EXTENSIONS.has(path.extname(absolutePath).toLowerCase());
}

function hashSource(sourceText: string): string {
  return createHash('sha1').update(sourceText).digest('hex');
}

function toScanFileInfo(record: AtlasFileRecord, rootDir: string): ScanFileInfo {
  return {
    filePath: record.file_path,
    absolutePath: path.join(rootDir, record.file_path),
    directory: path.dirname(record.file_path).split(path.sep).join('/'),
    cluster: record.cluster ?? 'unknown',
    loc: record.loc,
    fileHash: record.file_hash ?? '',
    imports: [],
    exports: record.exports as ScanFileInfo['exports'],
  };
}

function markDependentCrossRefsStale(runtime: AtlasRuntime, workspace: string, filePath: string): void {
  const dependents = listImportedBy(runtime.db, workspace, filePath);
  for (const dependent of dependents) {
    runtime.db.prepare(
      `UPDATE atlas_files
       SET cross_refs = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE workspace = ?
         AND file_path = ?`,
    ).run(workspace, dependent);
    const dependentRow = runtime.db.prepare(
      'SELECT id FROM atlas_files WHERE workspace = ? AND file_path = ? LIMIT 1',
    ).get(workspace, dependent) as { id?: number } | undefined;
    if (dependentRow?.id != null) {
      populateFts(runtime.db, dependentRow.id);
    }
    console.log(`[atlas-watch] marked cross_refs stale: ${dependent} <- ${filePath}`);
  }
}

async function refreshFile(runtime: AtlasRuntime, absolutePath: string): Promise<void> {
  if (isIgnoredPath(absolutePath) || !isWatchedFile(absolutePath)) {
    return;
  }

  const filePath = toWorkspacePath(runtime.config.sourceRoot, absolutePath);
  if (!filePath) {
    return;
  }

  const record = getAtlasFile(runtime.db, runtime.config.workspace, filePath);
  if (!record) {
    console.log(`[atlas-watch] skip ${filePath}: no atlas row yet`);
    return;
  }

  const sourceText = await readFile(absolutePath, 'utf8');
  const fileHash = hashSource(sourceText);
  const loc = sourceText.split(/\r?\n/).length;

  console.log(`[atlas-watch] refreshing ${filePath}`);

  // Heuristic-only: re-run crossref (deterministic, no LLM).
  // Semantic fields (blurb, purpose, patterns, etc.) are preserved from
  // prior atlas_commit writes — they'll be updated by agents organically.
  const xrefs = await runCrossref([
    toScanFileInfo(record, runtime.config.sourceRoot),
  ], {
    sourceRoot: runtime.config.sourceRoot,
    db: runtime.db,
    workspace: runtime.config.workspace,
  });
  const crossRefs = xrefs[filePath] ?? {
    symbols: {},
    total_exports_analyzed: record.exports.length,
    total_cross_references: 0,
  };

  upsertFileRecord(runtime.db, {
    workspace: record.workspace,
    file_path: record.file_path,
    file_hash: fileHash,
    cluster: record.cluster,
    loc,
    blurb: record.blurb,
    purpose: record.purpose,
    public_api: record.public_api,
    exports: record.exports as ScanFileInfo['exports'],
    patterns: record.patterns,
    dependencies: record.dependencies,
    data_flows: record.data_flows,
    key_types: record.key_types,
    hazards: record.hazards,
    conventions: record.conventions,
    cross_refs: crossRefs,
    source_highlights: record.source_highlights ?? [],
    language: record.language,
    extraction_model: 'heuristic',
    last_extracted: new Date().toISOString(),
  });

  markDependentCrossRefsStale(runtime, runtime.config.workspace, filePath);
  console.log(`[atlas-watch] refreshed ${filePath}`);
}

export function startAtlasWatcher(runtime: AtlasRuntime): () => void {
  const watchers = new Map<string, fs.FSWatcher>();
  const timers = new Map<string, NodeJS.Timeout>();
  const visitedDirs = new Set<string>();

  const schedule = (absolutePath: string): void => {
    if (!absolutePath || isIgnoredPath(absolutePath) || !isWatchedFile(absolutePath)) {
      return;
    }

    const existing = timers.get(absolutePath);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      timers.delete(absolutePath);
      void refreshFile(runtime, absolutePath).catch((error: unknown) => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        console.error(`[atlas-watch] refresh failed for ${absolutePath}: ${message}`);
      });
    }, DEBOUNCE_MS);

    timers.set(absolutePath, timer);
  };

  const registerDirectory = (directory: string): void => {
    const absoluteDir = path.resolve(directory);
    if (visitedDirs.has(absoluteDir) || isIgnoredPath(absoluteDir)) {
      return;
    }
    visitedDirs.add(absoluteDir);

    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        registerDirectory(path.join(absoluteDir, entry.name));
      }
    }

    const watcher = fs.watch(absoluteDir, (eventType, filename) => {
      if (!filename) {
        return;
      }

      const relative = String(filename);
      const absolutePath = path.join(absoluteDir, relative);
      if (eventType === 'rename' && fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
        registerDirectory(absolutePath);
        return;
      }

      schedule(absolutePath);
    });

    watchers.set(absoluteDir, watcher);
  };

  registerDirectory(runtime.config.sourceRoot);
  console.log(`[atlas-watch] watching ${runtime.config.sourceRoot}`);

  return () => {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();

    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();
    visitedDirs.clear();
  };
}
