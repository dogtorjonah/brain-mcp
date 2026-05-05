import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AtlasDatabase } from '../db.js';
import { replaceReferencesForFile } from '../db.js';
import { resolveRipgrepExecutablePath } from '../../binaryResolution.js';
import type { ScanFileInfo } from './scan.js';

/* ── ripgrep path resolution ────────────────────────────────────────── */

// Delegates env/PATH/common-location/codex-vendored discovery to
// binaryResolution.ts (cross-platform + Windows PATHEXT-aware). Kept
// locally only as a cached wrapper so repeated crossref passes don't
// re-walk the filesystem and so a missing binary is represented as
// `null` (falls back to the native Node.js grep) instead of throwing.
let cachedRgPath: string | null | undefined; // undefined = not yet resolved

function resolveRgPath(): string | null {
  if (cachedRgPath !== undefined) return cachedRgPath;
  try {
    cachedRgPath = resolveRipgrepExecutablePath(
      'Atlas crossref ripgrep tools require `rg`. Install ripgrep or set `RG_BIN`/`RIPGREP_BIN` to an absolute path.',
    );
  } catch {
    cachedRgPath = null;
  }
  return cachedRgPath;
}

/* ── Native grep fallback (zero external deps) ─────────────────────── */

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.next', 'docs', '.brain', '.atlas']);
const SKIP_GLOBS_SUFFIX = ['.d.ts'];

interface CachedSourceFile {
  relPath: string;  // relative to sourceRoot, forward slashes
  lines: string[];
}

/**
 * Pre-loads all TS source files into memory for fast symbol lookups.
 * Built lazily per sourceRoot, reused across all symbols in a crossref run.
 */
class NativeGrepIndex {
  private files: CachedSourceFile[] = [];
  private ready = false;

  constructor(private sourceRoot: string) {}

  load(): void {
    if (this.ready) return;
    const startMs = Date.now();
    this.walkDir(this.sourceRoot, '');
    this.ready = true;
    console.log(`[atlas-crossref] native grep index: ${this.files.length} files loaded in ${Date.now() - startMs}ms`);
  }

  private walkDir(absDir: string, relDir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const absPath = path.join(absDir, entry);
      const relPath = relDir ? `${relDir}/${entry}` : entry;
      let st: ReturnType<typeof statSync> | undefined;
      try {
        st = statSync(absPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        this.walkDir(absPath, relPath);
      } else if (st.isFile()) {
        const ext = path.extname(entry);
        if (!TS_EXTENSIONS.has(ext)) continue;
        if (SKIP_GLOBS_SUFFIX.some((suffix) => entry.endsWith(suffix))) continue;
        try {
          const content = readFileSync(absPath, 'utf8');
          this.files.push({ relPath, lines: content.split('\n') });
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  search(symbolName: string, definingFile: string, contextLines: number): GrepMatchGroup[] {
    this.load();
    const normalizedDef = normalizePath(definingFile);
    const escaped = escapeRegExp(symbolName);
    const pattern = new RegExp(`\\b${escaped}\\b`);
    const groups = new Map<string, GrepMatchGroup>();

    for (const file of this.files) {
      if (normalizePath(file.relPath) === normalizedDef) continue;

      for (let i = 0; i < file.lines.length; i++) {
        const line = file.lines[i] ?? '';
        if (!pattern.test(line)) continue;

        const existing = groups.get(file.relPath) ?? { file: file.relPath, matchCount: 0, lines: [] };
        existing.matchCount += 1;
        // Collect context lines around the match
        const start = Math.max(0, i - contextLines);
        const end = Math.min(file.lines.length - 1, i + contextLines);
        for (let j = start; j <= end; j++) {
          existing.lines.push(file.lines[j] ?? '');
        }
        groups.set(file.relPath, existing);
      }
    }

    return [...groups.values()].sort((left, right) => right.matchCount - left.matchCount || left.file.localeCompare(right.file));
  }
}

// One index per sourceRoot, reused across the whole crossref run
const nativeIndexCache = new Map<string, NativeGrepIndex>();

function getNativeIndex(sourceRoot: string): NativeGrepIndex {
  let index = nativeIndexCache.get(sourceRoot);
  if (!index) {
    index = new NativeGrepIndex(sourceRoot);
    nativeIndexCache.set(sourceRoot, index);
  }
  return index;
}

export interface CrossrefCallSite {
  file: string;
  usage_type: string;
  count: number;
  context: string;
}

export interface CrossrefSymbol {
  type: string;
  call_sites: CrossrefCallSite[];
  total_usages: number;
  blast_radius: string;
}

export interface CrossrefResult {
  symbols: Record<string, CrossrefSymbol>;
  total_exports_analyzed: number;
  total_cross_references: number;
  crossref_model?: string;
  crossref_timestamp?: string;
}

export interface CrossrefOptions {
  sourceRoot: string;
  contextLines?: number;
  maxGrepHits?: number;
  db?: AtlasDatabase;
  workspace?: string;
}

interface ExportedSymbol {
  name: string;
  type: string;
}

interface GrepMatchGroup {
  file: string;
  matchCount: number;
  lines: string[];
}

interface ReferenceUsageRow {
  target_symbol_name: string;
  target_symbol_kind: string;
  source_file: string | null;
  edge_type: string | null;
  usage_count: number | null;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeContextLines(lines: string[], maxLength = 240): string {
  const compact = lines
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function inferUsageType(symbolName: string, lines: string[]): string {
  const joined = lines.join('\n');
  const symbol = escapeRegExp(symbolName);
  if (new RegExp(`\\bfrom\\s+['"][^'"]*['"]`).test(joined) && joined.includes(symbolName)) {
    return 'import';
  }
  if (new RegExp(`\\bexport\\s*\\{[^}]*\\b${symbol}\\b[^}]*\\}`).test(joined)) {
    return 're-export';
  }
  if (new RegExp(`\\bnew\\s+${symbol}\\b`).test(joined) || new RegExp(`\\b${symbol}\\s*\\(`).test(joined)) {
    return 'call';
  }
  if (new RegExp(`\\btypeof\\s+${symbol}\\b`).test(joined) || new RegExp(`:\\s*${symbol}\\b`).test(joined)) {
    return 'type-reference';
  }
  return 'reference';
}

function evaluateBlastRadius(uniqueConsumerFiles: number): string {
  if (uniqueConsumerFiles <= 1) {
    return 'low';
  }
  if (uniqueConsumerFiles <= 5) {
    return 'medium';
  }
  if (uniqueConsumerFiles <= 15) {
    return 'high';
  }
  return 'critical';
}

export function extractExportedSymbols(sourceText: string): ExportedSymbol[] {
  const discovered = new Map<string, ExportedSymbol>();
  const add = (name: string, type: string): void => {
    const normalized = name.trim();
    if (!normalized || normalized === 'default') {
      return;
    }
    if (!discovered.has(normalized)) {
      discovered.set(normalized, { name: normalized, type });
    }
  };

  const patterns: Array<{ regex: RegExp; type: string }> = [
    { regex: /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g, type: 'function' },
    { regex: /\bexport\s+class\s+([A-Za-z_$][\w$]*)/g, type: 'class' },
    { regex: /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/g, type: 'interface' },
    { regex: /\bexport\s+type\s+([A-Za-z_$][\w$]*)/g, type: 'type' },
    { regex: /\bexport\s+enum\s+([A-Za-z_$][\w$]*)/g, type: 'enum' },
    { regex: /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, type: 'value' },
    { regex: /\bexport\s+namespace\s+([A-Za-z_$][\w$]*)/g, type: 'namespace' },
  ];

  for (const { regex, type } of patterns) {
    for (const match of sourceText.matchAll(regex)) {
      const name = match[1];
      if (name) add(name, type);
    }
  }

  for (const match of sourceText.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    const entries = match[1]?.split(',') ?? [];
    for (const entry of entries) {
      const [sourceName, aliasName] = entry.split(/\s+as\s+/i).map((part) => part.trim());
      if (sourceName) add(aliasName || sourceName, 're-export');
    }
  }

  return [...discovered.values()];
}

function getDeterministicExportedSymbols(
  file: ScanFileInfo,
  sourceText: string,
  db?: AtlasDatabase,
  workspace?: string,
): ExportedSymbol[] {
  if (db && workspace) {
    const rows = db.prepare(
      `SELECT name, kind
       FROM symbols
       WHERE workspace = ? AND file_path = ? AND exported = 1
       ORDER BY name ASC`,
    ).all(workspace, file.filePath) as Array<{ name: string; kind: string }>;

    if (rows.length > 0) {
      const dedupe = new Map<string, ExportedSymbol>();
      for (const row of rows) {
        const name = String(row.name ?? '').trim();
        if (!name) continue;
        if (!dedupe.has(name)) {
          dedupe.set(name, { name, type: String(row.kind ?? 'unknown') });
        }
      }
      return [...dedupe.values()];
    }
  }

  if (Array.isArray(file.exports) && file.exports.length > 0) {
    const dedupe = new Map<string, ExportedSymbol>();
    for (const entry of file.exports) {
      const name = String(entry.name ?? '').trim();
      if (!name) continue;
      if (!dedupe.has(name)) {
        dedupe.set(name, { name, type: String(entry.type ?? 'unknown') });
      }
    }
    if (dedupe.size > 0) {
      return [...dedupe.values()];
    }
  }

  return extractExportedSymbols(sourceText);
}

function runGrep(symbolName: string, sourceRoot: string, definingFile: string, contextLines: number): GrepMatchGroup[] {
  const rgPath = resolveRgPath();
  if (!rgPath) {
    // Fall back to native Node.js grep — slower but zero dependencies
    return getNativeIndex(sourceRoot).search(symbolName, definingFile, contextLines);
  }

  try {
    const output = execFileSync(rgPath, [
      '--json',
      '-n',
      '-w',
      '-F',
      '-C',
      String(contextLines),
      '--glob',
      '**/*.ts',
      '--glob',
      '**/*.tsx',
      '--glob',
      '**/*.mts',
      '--glob',
      '**/*.cts',
      '--glob',
      '!**/node_modules/**',
      '--glob',
      '!**/dist/**',
      '--glob',
      '!**/.git/**',
      '--glob',
      '!**/*.d.ts',
      '--glob',
      '!**/.next/**',
      '--glob',
      '!**/docs/**',
      '--glob',
      '!**/*.md',
      '--glob',
      '!**/*.json',
      '--glob',
      '!**/.brain/**',
      '--glob',
      '!**/.atlas/**',
      symbolName,
      '.',
    ], {
      cwd: sourceRoot,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60000,
    });

    const groups = new Map<string, GrepMatchGroup>();
    const normalizedDefiningFile = normalizePath(definingFile);

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string } } };
      try {
        event = JSON.parse(trimmed) as typeof event;
      } catch {
        continue;
      }

      if (!event.type || !event.data?.path?.text || !event.data.lines?.text) {
        continue;
      }

      if (event.type !== 'match' && event.type !== 'context') {
        continue;
      }

      const file = normalizePath(event.data.path.text);
      if (file === normalizedDefiningFile) {
        continue;
      }

      const existing = groups.get(file) ?? { file, matchCount: 0, lines: [] };
      existing.lines.push(event.data.lines.text.trimEnd());
      if (event.type === 'match') {
        existing.matchCount += 1;
      }
      groups.set(file, existing);
    }

    return [...groups.values()].sort((left, right) => right.matchCount - left.matchCount || left.file.localeCompare(right.file));
  } catch (error) {
    const code = typeof error === 'object' && error && 'status' in error ? (error as { status?: number }).status : undefined;
    if (code === 1) {
      return [];
    }
    const syscall = typeof error === 'object' && error && 'syscall' in error ? (error as { syscall?: string }).syscall : undefined;
    const signal = typeof error === 'object' && error && 'signal' in error ? (error as { signal?: string }).signal : undefined;
    const errCode = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined;
    console.warn(
      `[atlas-crossref] rg lookup failed for symbol="${symbolName}" file="${definingFile}" `
      + `(status=${String(code ?? 'n/a')} code=${String(errCode ?? 'n/a')} signal=${String(signal ?? 'n/a')} syscall=${String(syscall ?? 'n/a')})`,
    );
    return [];
  }
}

function buildFallbackCallSites(symbolName: string, groups: GrepMatchGroup[], maxGrepHits: number): CrossrefCallSite[] {
  return groups
    .slice(0, maxGrepHits)
    .map((group) => ({
      file: group.file,
      usage_type: inferUsageType(symbolName, group.lines),
      count: group.matchCount,
      context: normalizeContextLines(group.lines),
    }))
    .filter((site) => site.count > 0);
}

function listDeterministicUsages(
  db: AtlasDatabase,
  workspace: string,
  filePath: string,
): ReferenceUsageRow[] {
  return db.prepare(
    `SELECT
       s.name AS target_symbol_name,
       s.kind AS target_symbol_kind,
       r.source_file AS source_file,
       r.edge_type AS edge_type,
       SUM(r.usage_count) AS usage_count
     FROM symbols s
     LEFT JOIN "references" r
       ON r.workspace = s.workspace
      AND r.target_symbol_id = s.id
      AND r.edge_type IN ('CALLS', 'DATA_FLOWS_TO', 'PRODUCES', 'CONSUMES', 'TRIGGERS')
      AND r.source_file != s.file_path
     WHERE s.workspace = ?
       AND s.file_path = ?
       AND s.exported = 1
     GROUP BY s.id, r.source_file, r.edge_type
     ORDER BY s.name ASC, r.source_file ASC, r.edge_type ASC`,
  ).all(workspace, filePath) as ReferenceUsageRow[];
}

function groupUsagesBySymbol(rows: ReferenceUsageRow[]): Map<string, ReferenceUsageRow[]> {
  const grouped = new Map<string, ReferenceUsageRow[]>();
  for (const row of rows) {
    const symbolName = String(row.target_symbol_name ?? '').trim();
    if (!symbolName) continue;
    if (!grouped.has(symbolName)) grouped.set(symbolName, []);
    grouped.get(symbolName)!.push(row);
  }
  return grouped;
}

function mapEdgeTypeToUsageType(edgeType: string): string {
  switch (edgeType) {
    case 'CALLS':
      return 'call';
    case 'DATA_FLOWS_TO':
      return 'data-flow';
    case 'PRODUCES':
      return 'produces';
    case 'CONSUMES':
      return 'consumes';
    case 'TRIGGERS':
      return 'triggers';
    default:
      return 'reference';
  }
}

function buildDeterministicCallSites(
  rows: ReferenceUsageRow[],
  grepByFile: Map<string, GrepMatchGroup>,
): CrossrefCallSite[] {
  const grouped = new Map<string, CrossrefCallSite>();

  for (const row of rows) {
    const file = String(row.source_file ?? '').trim();
    const edgeType = String(row.edge_type ?? '').trim();
    if (!file || !edgeType) continue;

    const usageType = mapEdgeTypeToUsageType(edgeType);
    const key = `${file}\u0000${usageType}`;
    const existing = grouped.get(key) ?? {
      file,
      usage_type: usageType,
      count: 0,
      context: '',
    };
    const count = typeof row.usage_count === 'number' && Number.isFinite(row.usage_count)
      ? Math.max(1, Math.floor(row.usage_count))
      : 1;
    existing.count += count;
    grouped.set(key, existing);
  }

  const callSites = [...grouped.values()].sort((a, b) => b.count - a.count || a.file.localeCompare(b.file));
  for (const site of callSites) {
    const grepGroup = grepByFile.get(site.file);
    site.context = grepGroup
      ? normalizeContextLines(grepGroup.lines)
      : `deterministic ${site.usage_type} reference`;
  }
  return callSites;
}

function buildHeuristicCrossRef(
  symbolName: string,
  symbolType: string,
  usageRows: ReferenceUsageRow[],
  grepGroups: GrepMatchGroup[],
  maxGrepHits: number,
): CrossrefSymbol {
  const grepByFile = new Map(grepGroups.map((group) => [group.file, group]));
  const deterministicCallSites = buildDeterministicCallSites(usageRows, grepByFile);

  const callSites = deterministicCallSites.length > 0
    ? deterministicCallSites
    : buildFallbackCallSites(symbolName, grepGroups, maxGrepHits);

  const uniqueConsumerFiles = new Set(callSites.map((site) => site.file)).size;
  const totalUsages = callSites.reduce((sum, site) => sum + site.count, 0);

  return {
    type: symbolType,
    call_sites: callSites,
    total_usages: totalUsages,
    blast_radius: evaluateBlastRadius(uniqueConsumerFiles),
  };
}

export function persistCrossRefs(
  db: import('../db.js').AtlasDatabase,
  workspace: string,
  filePath: string,
  crossRefs: CrossrefResult,
): void {
  db.prepare(
    `UPDATE atlas_files
     SET cross_refs = ?, updated_at = CURRENT_TIMESTAMP
     WHERE workspace = ? AND file_path = ?`,
  ).run(JSON.stringify(crossRefs), workspace, filePath);
  replaceReferencesForFile(db, workspace, filePath, crossRefs);
}

export async function runCrossref(
  files: ScanFileInfo[],
  options: CrossrefOptions,
): Promise<Record<string, CrossrefResult>> {
  const result: Record<string, CrossrefResult> = {};
  const contextLines = options.contextLines ?? 2;
  const maxGrepHits = options.maxGrepHits ?? 10;

  const rgPath = resolveRgPath();
  if (!rgPath) {
    console.warn(
      '[atlas-crossref] ripgrep (rg) not found — using native Node.js grep fallback (slower but works)\n'
      + '  For faster crossref: brew install ripgrep | apt install ripgrep | cargo install ripgrep\n'
      + '  Or set RG_BIN=/path/to/rg environment variable.',
    );
  } else {
    console.log(`[atlas-crossref] rg resolved: ${rgPath} | sourceRoot: ${options.sourceRoot} | files: ${files.length}`);
  }

  for (const file of files) {
    const sourceText = await readFile(file.absolutePath, 'utf8');
    const exportedSymbols = getDeterministicExportedSymbols(file, sourceText, options.db, options.workspace);
    const usageRows = options.db && options.workspace
      ? listDeterministicUsages(options.db, options.workspace, file.filePath)
      : [];
    const usageRowsBySymbol = groupUsagesBySymbol(usageRows);
    const symbols: Record<string, CrossrefSymbol> = {};

    for (const exportedSymbol of exportedSymbols) {
      const grepGroups = runGrep(exportedSymbol.name, options.sourceRoot, file.filePath, contextLines);
      const symbolRows = usageRowsBySymbol.get(exportedSymbol.name) ?? [];
      symbols[exportedSymbol.name] = buildHeuristicCrossRef(
        exportedSymbol.name,
        exportedSymbol.type,
        symbolRows,
        grepGroups,
        maxGrepHits,
      );
    }

    const crossRefs: CrossrefResult = {
      symbols,
      total_exports_analyzed: exportedSymbols.length,
      total_cross_references: Object.values(symbols).reduce((sum, symbol) => sum + symbol.total_usages, 0),
      crossref_model: 'heuristic',
      crossref_timestamp: new Date().toISOString(),
    };

    result[file.filePath] = crossRefs;

  }

  return result;
}
