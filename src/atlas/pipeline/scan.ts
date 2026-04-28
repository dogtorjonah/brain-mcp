import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AtlasDatabase, AtlasImportEdgeRecord } from '../db.js';
import {
  replaceImportEdges,
  upsertFileRecord,
  upsertScanRecord,
  upsertSymbolsForFile,
} from '../db.js';
import { createPhaseProgressReporter } from './progress.js';

export interface ScanExportEntry {
  name: string;
  type: 'function' | 'class' | 'type' | 'interface' | 'const' | 'enum' | 'default' | 'unknown';
}

export interface ScanFileInfo {
  filePath: string;
  absolutePath: string;
  directory: string;
  cluster: string;
  loc: number;
  fileHash: string;
  imports: string[];
  exports: ScanExportEntry[];
}

export interface ScanResult {
  workspace: string;
  rootDir: string;
  files: ScanFileInfo[];
  importEdges: AtlasImportEdgeRecord[];
  missingFiles: string[];
}

const EXCLUDE_DIRS = new Set([
  'node_modules', 'dist', '.git', '.next', '__tests__', 'tests', 'test',
  '.brain', '.atlas', '.turbo', '.cache', 'coverage', 'build', 'out', '.vercel', '.voxxo-swarm',
  '.svelte-kit', '.nuxt', '.output',
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sql',
  '.py',
  '.go', '.rs', '.java', '.kt', '.swift',
  '.vue', '.svelte',
  '.md',
]);

const EXT_TO_LANGUAGE: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript',
  '.sql': 'sql',
  '.py': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.vue': 'vue', '.svelte': 'svelte',
  '.md': 'markdown',
};

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? 'unknown';
}

// Category prefixes for common src/ directory conventions.
// Only affects display names — no files are excluded.
const CATEGORY_PREFIXES: Record<string, string> = {
  components: 'ui',
  stores: 'store',
};

function assignCluster(relativePath: string): string {
  // All markdown files → docs
  if (relativePath.endsWith('.md')) {
    return 'docs';
  }

  const parts = relativePath.split('/');

  // Non-src top-level directories → misc-{dir}
  if (parts[0] !== 'src') {
    return parts[0] ? `misc-${parts[0]}` : 'root';
  }

  // File directly in src/ (e.g. src/utils.ts) → core
  if (parts.length <= 2) {
    return 'core';
  }

  const category = parts[1] ?? ''; // components, lib, stores, app, hooks, services, types, ...
  const domain = parts[2] ?? '';   // audio, jobs, records, hospitalBoard, api, ...

  // src/app/api/{domain}/... → api-{domain}
  const apiDomain = parts[3];
  if (category === 'app' && domain === 'api' && apiDomain) {
    return `api-${apiDomain}`;
  }

  // src/app/{page}/... → page-{page}  (non-api app routes)
  if (category === 'app') {
    return domain ? `page-${domain}` : 'page';
  }

  // Resolve display prefix: components→ui, stores→store, else keep raw name
  const prefix = (category && CATEGORY_PREFIXES[category]) ?? category;

  // Leaf categories with no meaningful subdomain (hooks, services, types)
  // src/hooks/useFoo.ts → hooks
  if (!domain || parts.length === 3) {
    // If there's a domain subfolder, include it; otherwise just the prefix
    return domain ? `${prefix}-${domain}` : prefix;
  }

  // Standard two-level cluster: prefix-domain
  // src/components/audio/... → ui-audio
  // src/stores/nativeRecording/... → store-nativeRecording
  // src/lib/jobs/... → lib-jobs
  return `${prefix}-${domain}`;
}

async function discoverFiles(dir: string, files: string[] = []): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) {
      continue;
    }

    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await discoverFiles(absolutePath, files);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      continue;
    }

    files.push(absolutePath);
  }
  return files;
}

function toWorkspacePath(root: string, filePath: string): string | null {
  const absoluteRoot = path.resolve(root);
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(absoluteRoot, filePath);
  const relative = path.relative(absoluteRoot, absolutePath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return relative.replaceAll(path.sep, '/');
}

function isIgnoredWorkspacePath(filePath: string): boolean {
  return filePath.split('/').some((part) => EXCLUDE_DIRS.has(part));
}

function isAllowedWorkspaceFile(filePath: string): boolean {
  return ALLOWED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

async function collectTargetFiles(
  rootDir: string,
  targetPaths: string[],
): Promise<{ sourceFiles: string[]; missingFiles: string[]; selectedSourceFiles: string[] }> {
  const sourceFiles: string[] = [];
  const missingFiles: string[] = [];
  const selectedSourceFiles: string[] = [];
  const seenFiles = new Set<string>();
  const seenMissing = new Set<string>();

  for (const targetPath of targetPaths) {
    const workspacePath = toWorkspacePath(rootDir, targetPath.trim());
    if (!workspacePath || isIgnoredWorkspacePath(workspacePath)) {
      continue;
    }

    const absolutePath = path.join(rootDir, workspacePath);
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(absolutePath);
    } catch {
      if (!seenMissing.has(workspacePath)) {
        missingFiles.push(workspacePath);
        seenMissing.add(workspacePath);
      }
      continue;
    }

    if (stat.isDirectory()) {
      const discovered = await discoverFiles(absolutePath);
      for (const file of discovered) {
        const relative = path.relative(rootDir, file).replaceAll(path.sep, '/');
        if (seenFiles.has(relative)) {
          continue;
        }
        sourceFiles.push(file);
        selectedSourceFiles.push(relative);
        seenFiles.add(relative);
      }
      continue;
    }

    if (!stat.isFile() || !isAllowedWorkspaceFile(workspacePath)) {
      continue;
    }
    if (seenFiles.has(workspacePath)) {
      continue;
    }
    sourceFiles.push(absolutePath);
    selectedSourceFiles.push(workspacePath);
    seenFiles.add(workspacePath);
  }

  return { sourceFiles, missingFiles, selectedSourceFiles };
}

function extractImports(content: string): string[] {
  const imports = new Set<string>();
  const regex = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const importPath = match[1];
    if (importPath) {
      imports.add(importPath);
    }
  }
  return [...imports];
}

function extractExports(content: string): ScanExportEntry[] {
  const exports: ScanExportEntry[] = [];

  for (const match of content.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'function' });
    }
  }
  for (const match of content.matchAll(/export\s+class\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'class' });
    }
  }
  for (const match of content.matchAll(/export\s+interface\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'interface' });
    }
  }
  for (const match of content.matchAll(/export\s+type\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'type' });
    }
  }
  for (const match of content.matchAll(/export\s+const\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'const' });
    }
  }
  for (const match of content.matchAll(/export\s+enum\s+(\w+)/g)) {
    const name = match[1];
    if (name) {
      exports.push({ name, type: 'enum' });
    }
  }
  if (/export\s+default/.test(content)) {
    exports.push({ name: 'default', type: 'default' });
  }

  return exports;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveRelativeImport(filePath: string, importPath: string, projectRoot: string): Promise<string | null> {
  const fileDir = path.dirname(filePath);
  let resolved = path.resolve(fileDir, importPath);

  const candidates = [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    path.join(resolved, 'index.ts'),
    path.join(resolved, 'index.tsx'),
  ];

  if (resolved.endsWith('.js')) {
    candidates.unshift(resolved.replace(/\.js$/, '.ts'));
    candidates.unshift(resolved.replace(/\.js$/, '.tsx'));
  }

  for (const candidate of candidates) {
    if (candidate.startsWith(projectRoot) && await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

export async function runScan(
  sourceRoot: string,
  workspace: string,
  db: AtlasDatabase,
  options?: { force?: boolean; targetPaths?: string[] },
): Promise<ScanResult> {
  const absoluteRoot = path.resolve(sourceRoot);
  const targetScan = options?.targetPaths && options.targetPaths.length > 0
    ? await collectTargetFiles(absoluteRoot, options.targetPaths)
    : null;
  const sourceFiles = targetScan?.sourceFiles ?? await discoverFiles(absoluteRoot);
  const files: ScanFileInfo[] = [];
  const importEdges: AtlasImportEdgeRecord[] = [];
  const progress = createPhaseProgressReporter([{
    key: 'scan',
    label: 'Import graph',
    total: sourceFiles.length,
  }]);

  for (const absolutePath of sourceFiles) {
    progress.begin('scan');
    const content = await fs.readFile(absolutePath, 'utf8');
    const relativePath = path.relative(absoluteRoot, absolutePath).replaceAll(path.sep, '/');
    const imports = extractImports(content);
    const exports = extractExports(content);
    const cluster = assignCluster(relativePath);
    const loc = content.split(/\r?\n/).length;
    const fileHash = hashContent(content);
    const resolvedImports: string[] = [];
    for (const importPath of imports) {
      const resolved = await resolveRelativeImport(absolutePath, importPath, absoluteRoot);
      if (!resolved) {
        continue;
      }
      resolvedImports.push(path.relative(absoluteRoot, resolved).replaceAll(path.sep, '/'));
    }

    for (const target_file of resolvedImports) {
      importEdges.push({
        workspace,
        source_file: relativePath,
        target_file,
      });
    }

    const fileInfo: ScanFileInfo = {
      filePath: relativePath,
      absolutePath,
      directory: path.dirname(relativePath).replaceAll(path.sep, '/'),
      cluster,
      loc,
      fileHash,
      imports: resolvedImports,
      exports,
    };
    files.push(fileInfo);

    if (options?.force) {
      // --force (nuclear): wipe all AI fields so resume after a killed force run
      // never produces a franken-atlas with mixed old+new extraction data.
      upsertFileRecord(db, {
        workspace,
        file_path: relativePath,
        file_hash: fileHash,
        cluster,
        loc,
        public_api: [],
        exports,
        patterns: [],
        dependencies: { imports: resolvedImports, imported_by: [] },
        data_flows: [],
        key_types: [],
        hazards: [],
        conventions: [],
        language: detectLanguage(relativePath),
        blurb: '',
        purpose: '',
        extraction_model: null,
        last_extracted: null,
        cross_refs: null,
      });
    } else {
      // Resume-safe: only update structural fields, preserve existing AI data.
      upsertScanRecord(db, {
        workspace,
        file_path: relativePath,
        file_hash: fileHash,
        cluster,
        loc,
        exports,
        dependencies: { imports: resolvedImports, imported_by: [] },
        language: detectLanguage(relativePath),
      });
    }

    upsertSymbolsForFile(
      db,
      workspace,
      relativePath,
      exports.map((entry) => ({
        workspace,
        file_path: relativePath,
        name: entry.name,
        kind: entry.type,
        exported: true,
      })),
    );

    progress.complete('scan');
  }

  replaceImportEdges(db, workspace, importEdges, targetScan?.selectedSourceFiles);
  progress.finish(`scan complete: ${files.length} files, ${importEdges.length} edges`);

  return {
    workspace,
    rootDir: absoluteRoot,
    files,
    importEdges,
    missingFiles: targetScan?.missingFiles ?? [],
  };
}
