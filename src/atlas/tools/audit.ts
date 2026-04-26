import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import type { AtlasDatabase, AtlasReferenceRecord } from '../db.js';
import { listAtlasFiles, listImportEdges, listReferences, queryAtlasChangelog } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import {
  includesStructuralSymbolByContext,
  isStructuralSymbolName,
  supportsStructuralImportExportAnalysis,
} from './structuralSymbols.js';

type OutputFormat = 'json' | 'text';
type AuditAction = 'gaps' | 'smells' | 'hotspots';

const GAP_TYPES = [
  'loaded_not_used',
  'exported_not_referenced',
  'imported_not_used',
  'installed_not_imported',
  'incomplete_atlas_entry',
] as const;

type GapType = (typeof GAP_TYPES)[number];

interface RuntimeDbContext {
  db: AtlasDatabase;
  workspace: string;
  sourceRoot: string;
}

interface GapFinding {
  gapType: GapType;
  filePath: string;
  subject: string;
  evidence: string[];
  note?: string;
}

interface SmellBreakdown {
  smell: string;
  points: number;
  reason: string;
}

interface SmellResult {
  file_path: string;
  cluster: string | null;
  purpose: string;
  severity: number;
  metrics: {
    loc: number;
    fan_in: number;
    fan_out: number;
    cycle_size: number;
    change_count: number;
    hazards_count: number;
    reference_usage: number;
  };
  breakdown: SmellBreakdown[];
}

const DEFAULT_GAP_TYPES: GapType[] = [...GAP_TYPES];

const GAP_LABELS: Record<GapType, string> = {
  loaded_not_used: 'loaded_not_used',
  exported_not_referenced: 'exported_not_referenced',
  imported_not_used: 'imported_not_used',
  installed_not_imported: 'installed_not_imported',
  incomplete_atlas_entry: 'incomplete_atlas_entry',
};

const MAX_FINDINGS = 200;
const IDENTIFIER_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'if', 'in', 'into', 'is',
  'it', 'its', 'of', 'on', 'only', 'or', 'out', 'the', 'their', 'then', 'this', 'to',
  'used', 'uses', 'using', 'value', 'values', 'when', 'with',
]);

function resolveDbContext(runtime: AtlasRuntime, workspace?: string): RuntimeDbContext | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return {
      db: runtime.db,
      workspace: runtime.config.workspace,
      sourceRoot: runtime.config.sourceRoot,
    };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((entry) => entry.workspace === workspace);
  if (!target) return null;
  return {
    db: target.db,
    workspace: target.workspace,
    sourceRoot: target.sourceRoot,
  };
}

function resolveFormat(format?: string): OutputFormat {
  return format === 'json' ? 'json' : 'text';
}

function textContent(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function formatOutput(format: OutputFormat, payload: Record<string, unknown>, text: string) {
  return format === 'json' ? JSON.stringify(payload, null, 2) : text;
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function shouldExcludePath(filePath: string, includeTestFiles: boolean): boolean {
  if (includeTestFiles) return false;
  const p = normalizePath(filePath);
  if (
    p.includes('/__tests__/') ||
    p.includes('/__mocks__/') ||
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/spec/') ||
    p.includes('/fixtures/')
  ) {
    return true;
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

function normalizeMetric(value: number, maxValue: number): number {
  if (maxValue <= 0) return 0;
  return Math.max(0, Math.min(1, value / maxValue));
}

function daysSince(timestamp: string | null): number {
  if (!timestamp) return 0;
  const parsed = Date.parse(timestamp);
  if (Number.isNaN(parsed)) return 0;
  return Math.max(0, (Date.now() - parsed) / (24 * 60 * 60 * 1000));
}

function buildAdjacency(
  edges: Array<{ source_file: string; target_file: string }>,
  nodeSet: Set<string>,
): { outgoing: Map<string, string[]>; incoming: Map<string, string[]> } {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodeSet) {
    outgoing.set(node, []);
    incoming.set(node, []);
  }

  const seen = new Set<string>();
  for (const edge of edges) {
    const src = normalizePath(edge.source_file);
    const dst = normalizePath(edge.target_file);
    if (!nodeSet.has(src) || !nodeSet.has(dst)) continue;
    const key = `${src}=>${dst}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outgoing.get(src)?.push(dst);
    incoming.get(dst)?.push(src);
  }

  return { outgoing, incoming };
}

function buildSccSizeByNode(outgoing: Map<string, string[]>): Map<string, number> {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccSize = new Map<string, number>();
  let idx = 0;

  const strongConnect = (node: string): void => {
    index.set(node, idx);
    low.set(node, idx);
    idx += 1;
    stack.push(node);
    onStack.add(node);

    for (const neighbor of outgoing.get(node) ?? []) {
      if (!index.has(neighbor)) {
        strongConnect(neighbor);
        low.set(node, Math.min(low.get(node) ?? 0, low.get(neighbor) ?? 0));
      } else if (onStack.has(neighbor)) {
        low.set(node, Math.min(low.get(node) ?? 0, index.get(neighbor) ?? 0));
      }
    }

    if ((low.get(node) ?? -1) === (index.get(node) ?? -2)) {
      const component: string[] = [];
      while (stack.length > 0) {
        const top = stack.pop();
        if (!top) break;
        onStack.delete(top);
        component.push(top);
        if (top === node) break;
      }
      for (const member of component) sccSize.set(member, component.length);
    }
  };

  for (const node of outgoing.keys()) {
    if (!index.has(node)) strongConnect(node);
  }

  return sccSize;
}

function aggregateReferenceUsage(
  references: AtlasReferenceRecord[],
  nodeSet: Set<string>,
): Map<string, number> {
  const usage = new Map<string, number>();
  for (const ref of references) {
    const src = normalizePath(ref.source_file);
    const dst = normalizePath(ref.target_file);
    const count = Number(ref.usage_count ?? 1);
    if (nodeSet.has(src)) usage.set(src, (usage.get(src) ?? 0) + count);
    if (nodeSet.has(dst)) usage.set(dst, (usage.get(dst) ?? 0) + count);
  }
  return usage;
}

function getScopeFiles(
  db: AtlasDatabase,
  workspace: string,
  filePath?: string,
  cluster?: string,
): AtlasFileRecord[] {
  const files = listAtlasFiles(db, workspace);
  return files.filter((file) => {
    if (filePath && file.file_path !== filePath) return false;
    if (cluster && file.cluster !== cluster) return false;
    return true;
  });
}

function collectCrossRefTexts(row: AtlasFileRecord): string[] {
  if (!row.cross_refs?.symbols) return [];
  const texts: string[] = [];
  for (const info of Object.values(row.cross_refs.symbols)) {
    for (const site of info.call_sites ?? []) {
      if (site.context) texts.push(site.context);
    }
  }
  return texts;
}

function symbolUsedAnywhere(symbol: string, files: AtlasFileRecord[]): boolean {
  for (const file of files) {
    const symbols = file.cross_refs?.symbols;
    if (symbols?.[symbol] && symbols[symbol].total_usages > 0) return true;
    if (collectCrossRefTexts(file).some((text) => includesStructuralSymbolByContext(text, symbol))) return true;
  }
  return false;
}

function symbolUsedInRow(symbol: string, row: AtlasFileRecord): boolean {
  const symbols = row.cross_refs?.symbols;
  if (symbols?.[symbol] && symbols[symbol].total_usages > 0) return true;
  return collectCrossRefTexts(row).some((text) => includesStructuralSymbolByContext(text, symbol));
}

function getConsumersByFile(
  workspace: string,
  sourceFile: string,
  edges: Array<{ workspace: string; source_file: string; target_file: string }>,
): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.workspace !== workspace) continue;
    const bucket = reverse.get(edge.target_file) ?? [];
    bucket.push(edge.source_file);
    reverse.set(edge.target_file, bucket);
  }

  const seen = new Set<string>();
  const queue = [...(reverse.get(sourceFile) ?? [])];
  while (queue.length > 0) {
    const file = queue.shift();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const caller of reverse.get(file) ?? []) {
      if (!seen.has(caller)) queue.push(caller);
    }
  }
  return seen;
}

function isLikelyCodeIdentifier(symbol: string, quoted: boolean): boolean {
  if (!symbol) return false;
  if (quoted) return symbol.length >= 2;
  if (symbol.length < 4) return false;
  const lower = symbol.toLowerCase();
  if (IDENTIFIER_STOP_WORDS.has(lower)) return false;
  if (/^[a-z]+$/.test(symbol)) return false;
  return (
    /^[A-Z][A-Za-z0-9_$]*$/.test(symbol)
    || /^[a-z]+[A-Z][A-Za-z0-9_$]*$/.test(symbol)
    || /^[A-Z][A-Z0-9_]*$/.test(symbol)
  );
}

function extractLoadedSymbols(dataFlows: string[]): Array<{ symbol: string; flow: string; strong: boolean }> {
  const extracted: Array<{ symbol: string; flow: string; strong: boolean }> = [];
  const patterns = [
    {
      regex: /\b(?:derive|derives|derived|load|loads|loaded|fetch|fetches|fetched)\s+`([A-Za-z_$][\w$]*)`/gi,
      strong: true,
      quoted: true,
    },
    {
      regex: /\b(?:derive|derives|derived|load|loads|loaded|fetch|fetches|fetched)\s+([A-Za-z_$][\w$]*)/gi,
      strong: true,
      quoted: false,
    },
    {
      regex: /`([A-Za-z_$][\w$]*)`/g,
      strong: false,
      quoted: true,
    },
  ];

  for (const flow of dataFlows) {
    if (!flow || typeof flow !== 'string') continue;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null = pattern.regex.exec(flow);
      while (match) {
        const symbol = (match[1] ?? '').trim();
        if (isLikelyCodeIdentifier(symbol, pattern.quoted)) {
          extracted.push({ symbol, flow, strong: pattern.strong });
        }
        match = pattern.regex.exec(flow);
      }
    }
  }

  const dedup = new Map<string, { symbol: string; flow: string; strong: boolean }>();
  for (const item of extracted) {
    const existing = dedup.get(item.symbol);
    if (!existing || (!existing.strong && item.strong)) dedup.set(item.symbol, item);
  }
  return [...dedup.values()];
}

function normalizePackageName(specifier: string): string {
  if (!specifier || specifier.startsWith('.') || specifier.startsWith('/')) return '';
  if (specifier.startsWith('node:')) return '';
  if (specifier.startsWith('@')) {
    const [scope, pkg] = specifier.split('/');
    if (!scope || !pkg) return '';
    return `${scope}/${pkg}`;
  }
  const [pkg] = specifier.split('/');
  return pkg || '';
}

function stripImportAndRequireStatements(sourceText: string): string {
  return sourceText
    .replace(/^\s*import[\s\S]*?;?\s*$/gm, '')
    .replace(/^\s*const\s+[\w${}\s,]+\s*=\s*require\([^)]*\);?\s*$/gm, '');
}

interface ParsedImport {
  specifier: string;
  importedNames: string[];
  sideEffectOnly: boolean;
}

function parseImports(sourceText: string): ParsedImport[] {
  const parsed: ParsedImport[] = [];
  const staticImportRegex = /import\s+([^'";]+?)\s+from\s+['"]([^'"]+)['"]/g;
  let staticMatch: RegExpExecArray | null = staticImportRegex.exec(sourceText);
  while (staticMatch) {
    const clause = (staticMatch[1] ?? '').trim();
    const specifier = (staticMatch[2] ?? '').trim();
    const importedNames: string[] = [];

    const namespaceMatch = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
    if (namespaceMatch?.[1]) importedNames.push(namespaceMatch[1]);

    const defaultMatch = clause.match(/^([A-Za-z_$][\w$]*)/);
    if (defaultMatch?.[1] && !clause.startsWith('{') && !clause.startsWith('*')) {
      importedNames.push(defaultMatch[1]);
    }

    const namedMatch = clause.match(/\{([^}]+)\}/);
    if (namedMatch?.[1]) {
      const names = namedMatch[1]
        .split(',')
        .map((segment) => segment.trim())
        .filter(Boolean)
        .map((segment) => {
          const aliasMatch = segment.match(/\s+as\s+([A-Za-z_$][\w$]*)$/);
          if (aliasMatch?.[1]) return aliasMatch[1];
          return segment.replace(/\s+/g, '');
        });
      importedNames.push(...names);
    }

    parsed.push({
      specifier,
      importedNames: [...new Set(importedNames)],
      sideEffectOnly: importedNames.length === 0,
    });
    staticMatch = staticImportRegex.exec(sourceText);
  }

  const sideEffectImportRegex = /import\s+['"]([^'"]+)['"]/g;
  let sideEffectMatch: RegExpExecArray | null = sideEffectImportRegex.exec(sourceText);
  while (sideEffectMatch) {
    parsed.push({
      specifier: (sideEffectMatch[1] ?? '').trim(),
      importedNames: [],
      sideEffectOnly: true,
    });
    sideEffectMatch = sideEffectImportRegex.exec(sourceText);
  }

  const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let requireMatch: RegExpExecArray | null = requireRegex.exec(sourceText);
  while (requireMatch) {
    parsed.push({
      specifier: (requireMatch[1] ?? '').trim(),
      importedNames: [],
      sideEffectOnly: true,
    });
    requireMatch = requireRegex.exec(sourceText);
  }

  return parsed;
}

function buildCandidateSpecifiers(sourceFilePath: string, targetFilePath: string): Set<string> {
  const sourceDir = path.posix.dirname(sourceFilePath.replace(/\\/g, '/'));
  const target = targetFilePath.replace(/\\/g, '/');
  let rel = path.posix.relative(sourceDir, target);
  if (!rel.startsWith('.')) rel = `./${rel}`;

  const withoutTsExt = rel.replace(/\.(tsx?|mts|cts)$/i, '');
  const withoutJsExt = withoutTsExt.replace(/\.(jsx?|mjs|cjs)$/i, '');

  return new Set([
    rel,
    `${withoutJsExt}.js`,
    `${withoutJsExt}.ts`,
    withoutJsExt,
    `${withoutJsExt}/index`,
    `${withoutJsExt}/index.js`,
  ]);
}

async function readSourceText(sourceRoot: string, filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(sourceRoot, filePath), 'utf8');
  } catch {
    return null;
  }
}

async function collectImportedPackages(sourceRoot: string, files: AtlasFileRecord[]): Promise<Set<string>> {
  const imported = new Set<string>();
  const importRegexes = [
    /from\s+['"]([^'"]+)['"]/g,
    /import\(\s*['"]([^'"]+)['"]\s*\)/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  await Promise.all(files.map(async (file) => {
    try {
      const source = await fs.readFile(path.join(sourceRoot, file.file_path), 'utf8');
      for (const pattern of importRegexes) {
        let match: RegExpExecArray | null = pattern.exec(source);
        while (match) {
          const pkg = normalizePackageName(match[1] ?? '');
          if (pkg) imported.add(pkg);
          match = pattern.exec(source);
        }
      }
    } catch {
      // Ignore unreadable files.
    }
  }));

  return imported;
}

function formatFinding(finding: GapFinding): string {
  const evidence = finding.evidence.join(' | ');
  const note = finding.note ? `\n  Note: ${finding.note}` : '';
  return `- \`${finding.subject}\` — ${evidence}${note}`;
}

async function runGapsAction(
  runtime: AtlasRuntime,
  args: {
    workspace?: string;
    cluster?: string;
    file_path?: string;
    filePath?: string;
    gap_types?: GapType[];
    gapTypes?: GapType[];
    format?: 'json' | 'text';
  },
) {
  const filePath = args.file_path ?? args.filePath;
  const gapTypes = args.gap_types ?? args.gapTypes;
  const target = resolveDbContext(runtime, args.workspace);
  if (!target) return textContent(`Workspace "${args.workspace}" not found.`);

  const types = gapTypes && gapTypes.length > 0 ? gapTypes : DEFAULT_GAP_TYPES;
  const scopedFiles = getScopeFiles(target.db, target.workspace, filePath, args.cluster);
  if (scopedFiles.length === 0) return textContent('No files matched the requested scope.');

  const allFiles = listAtlasFiles(target.db, target.workspace);
  const fileMap = new Map(allFiles.map((file) => [file.file_path, file]));
  const scopedSet = new Set(scopedFiles.map((file) => file.file_path));
  const edges = listImportEdges(target.db, target.workspace);
  const findings: GapFinding[] = [];
  const sourceCache = new Map<string, string | null>();

  if (types.includes('loaded_not_used')) {
    for (const file of scopedFiles) {
      const loadedSymbols = extractLoadedSymbols(file.data_flows ?? []);
      if (loadedSymbols.length === 0) continue;
      const downstream = getConsumersByFile(target.workspace, file.file_path, edges);
      const downstreamRows = [...downstream]
        .map((name) => fileMap.get(name))
        .filter((row): row is AtlasFileRecord => Boolean(row));

      for (const symbolEntry of loadedSymbols) {
        const symbol = symbolEntry.symbol;
        if (symbolUsedInRow(symbol, file) || symbolUsedAnywhere(symbol, downstreamRows)) continue;
        findings.push({
          gapType: 'loaded_not_used',
          filePath: file.file_path,
          subject: symbol,
          evidence: [
            `data_flows mentions "${symbolEntry.flow}"`,
            `0 references across ${downstreamRows.length} downstream files`,
          ],
        });
      }
    }
  }

  if (types.includes('exported_not_referenced')) {
    for (const file of scopedFiles) {
      if (!supportsStructuralImportExportAnalysis(file.file_path)) continue;
      const exports = file.exports ?? [];
      const symbols = file.cross_refs?.symbols ?? {};
      for (const exported of exports) {
        const symbol = String(exported.name ?? '').trim();
        if (!isStructuralSymbolName(symbol)) continue;
        const direct = symbols[symbol];
        if ((direct?.total_usages ?? 0) > 0 || symbolUsedAnywhere(symbol, allFiles)) continue;
        findings.push({
          gapType: 'exported_not_referenced',
          filePath: file.file_path,
          subject: symbol,
          evidence: [
            `export "${symbol}" has 0 call_sites`,
            'symbol not found in workspace cross_refs contexts',
          ],
          note: 'May be intentionally internal or future-facing.',
        });
      }
    }
  }

  if (types.includes('imported_not_used')) {
    for (const edge of edges) {
      if (!scopedSet.has(edge.source_file)) continue;
      const source = fileMap.get(edge.source_file);
      const targetFile = fileMap.get(edge.target_file);
      if (!source || !targetFile) continue;
      if (!supportsStructuralImportExportAnalysis(edge.source_file)) continue;

      const symbolCandidates = new Set<string>();
      if (supportsStructuralImportExportAnalysis(targetFile.file_path)) {
        for (const exp of targetFile.exports ?? []) {
          const name = String(exp.name ?? '').trim();
          if (isStructuralSymbolName(name)) symbolCandidates.add(name);
        }
      }
      for (const keyType of targetFile.key_types ?? []) {
        if (typeof keyType === 'object' && keyType && 'name' in keyType && typeof keyType.name === 'string') {
          const name = keyType.name.trim();
          if (isStructuralSymbolName(name)) symbolCandidates.add(name);
        }
      }

      if (!sourceCache.has(edge.source_file)) {
        sourceCache.set(edge.source_file, await readSourceText(target.sourceRoot, edge.source_file));
      }
      const sourceText = sourceCache.get(edge.source_file);
      if (!sourceText) continue;

      const imports = parseImports(sourceText);
      const candidateSpecifiers = buildCandidateSpecifiers(edge.source_file, edge.target_file);
      const relevantImports = imports.filter((entry) => candidateSpecifiers.has(entry.specifier));
      if (relevantImports.length === 0) continue;

      const bodyWithoutImports = stripImportAndRequireStatements(sourceText);
      const importedIdentifiers = new Set<string>();
      let sideEffectImportOnly = false;
      for (const entry of relevantImports) {
        if (entry.sideEffectOnly) {
          sideEffectImportOnly = true;
          continue;
        }
        for (const name of entry.importedNames) importedIdentifiers.add(name);
      }

      const usedAnyIdentifier = [...importedIdentifiers].some((name) => includesStructuralSymbolByContext(bodyWithoutImports, name));
      const usedAnyTargetSymbol = [...symbolCandidates].some((symbol) => includesStructuralSymbolByContext(bodyWithoutImports, symbol));
      if (usedAnyIdentifier || usedAnyTargetSymbol) continue;

      const sideEffectLikely = sideEffectImportOnly || symbolCandidates.size === 0;
      findings.push({
        gapType: 'imported_not_used',
        filePath: edge.source_file,
        subject: edge.target_file,
        evidence: [
          `import edge exists: ${edge.source_file} -> ${edge.target_file}`,
          'import bindings found but no local usage in source body',
        ],
        note: sideEffectLikely ? 'suspected: may be intentional side-effect import' : undefined,
      });
    }
  }

  if (types.includes('installed_not_imported')) {
    try {
      const packageJsonRaw = await fs.readFile(path.join(target.sourceRoot, 'package.json'), 'utf8');
      const packageJson = JSON.parse(packageJsonRaw) as { dependencies?: Record<string, string> };
      const declared = new Set(Object.keys(packageJson.dependencies ?? {}));
      const importedPackages = await collectImportedPackages(target.sourceRoot, allFiles);

      for (const dependency of declared) {
        if (importedPackages.has(dependency)) continue;
        findings.push({
          gapType: 'installed_not_imported',
          filePath: 'package.json',
          subject: dependency,
          evidence: [
            'dependency declared in package.json',
            'no import/require usage found across atlas-indexed source files',
          ],
        });
      }
    } catch {
      findings.push({
        gapType: 'installed_not_imported',
        filePath: 'package.json',
        subject: '(unreadable package.json)',
        evidence: ['failed to parse package.json; skipped dependency gap check'],
      });
    }
  }

  if (types.includes('incomplete_atlas_entry')) {
    for (const file of scopedFiles) {
      const missing: string[] = [];

      // Check semantic metadata fields
      if (!file.blurb || file.blurb.trim() === '') missing.push('blurb');
      if (!file.purpose || file.purpose.trim() === '') missing.push('purpose');
      if (!file.extraction_model || file.extraction_model === 'scaffold') missing.push('extraction (scaffold or none)');

      // Check cross_refs completeness
      const crossRefs = file.cross_refs;
      if (!crossRefs || (typeof crossRefs === 'object' && (!crossRefs.symbols || Object.keys(crossRefs.symbols).length === 0) && !crossRefs.crossref_timestamp)) {
        missing.push('cross_refs');
      }

      // Check structural metadata — empty arrays indicate fields never populated
      if ((file.hazards?.length ?? 0) === 0) missing.push('hazards');
      if ((file.conventions?.length ?? 0) === 0) missing.push('conventions');
      if ((file.key_types?.length ?? 0) === 0) missing.push('key_types');
      if ((file.data_flows?.length ?? 0) === 0) missing.push('data_flows');

      if (missing.length === 0) continue;

      const totalChecked = 8;

      findings.push({
        gapType: 'incomplete_atlas_entry',
        filePath: file.file_path,
        subject: file.file_path,
        evidence: [
          `missing: ${missing.join(', ')}`,
          `${missing.length}/${totalChecked} metadata fields empty`,
        ],
        note: file.extraction_model
          ? `last extraction by ${file.extraction_model}`
          : 'never extracted',
      });
    }
  }

  const out = resolveFormat(args.format);
  const totalFindings = findings.length;
  const displayedFindings = findings.slice(0, MAX_FINDINGS);
  const scopeLabel = filePath ?? args.cluster ?? `${scopedFiles.length} scoped files`;
  const lines: string[] = [`## Structural Gaps: ${scopeLabel}`, ''];
  for (const type of types) {
    const totalTypeFindings = findings.filter((finding) => finding.gapType === type);
    const displayedTypeFindings = displayedFindings.filter((finding) => finding.gapType === type);
    const heading = totalFindings > MAX_FINDINGS
      ? `### ${GAP_LABELS[type]} (${displayedTypeFindings.length} shown of ${totalTypeFindings.length} found)`
      : `### ${GAP_LABELS[type]} (${totalTypeFindings.length} found)`;
    lines.push(heading);
    if (displayedTypeFindings.length === 0) {
      lines.push('- none');
    } else {
      for (const finding of displayedTypeFindings) {
        lines.push(`File: ${finding.filePath}`);
        lines.push(formatFinding(finding));
      }
    }
    lines.push('');
  }

  if (totalFindings > MAX_FINDINGS) {
    lines.push(`⚠️ Showing first ${MAX_FINDINGS} of ${totalFindings} findings. Narrow the scope with file_path, cluster, or gap_types for a complete report.`);
  }

  const content: Array<{ type: 'text'; text: string }> = [{
    type: 'text',
    text: formatOutput(out, {
      ok: true,
      workspace: target.workspace,
      cluster: args.cluster ?? null,
      file_path: filePath ?? null,
      gap_types: types,
      results: displayedFindings,
      summary: {
        total_findings: totalFindings,
        shown_findings: displayedFindings.length,
        truncated: totalFindings > MAX_FINDINGS,
      },
    }, lines.join('\n').trim()),
  }];
  if (findings.some((finding) => finding.gapType === 'exported_not_referenced')) {
    content.push({
      type: 'text',
      text: '💡 Consider removing unused exports, or run `atlas_admin action=reindex phase=crossref` if they might be stale cross-refs.',
    });
  }
  if (findings.some((finding) => finding.gapType === 'incomplete_atlas_entry')) {
    content.push({
      type: 'text',
      text: '💡 Run `atlas_admin action=reindex` to populate missing metadata, or use `atlas_commit` after editing files to fill in blurb/purpose.',
    });
  }
  return { content };
}

async function runSmellsAction(
  runtime: AtlasRuntime,
  args: {
    workspace?: string;
    cluster?: string;
    min_severity?: number;
    minSeverity?: number;
    limit?: number;
    include_test_files?: boolean;
    includeTestFiles?: boolean;
    format?: 'json' | 'text';
  },
) {
  const context = resolveDbContext(runtime, args.workspace);
  if (!context) return textContent(`Workspace "${args.workspace}" not found.`);

  const out = resolveFormat(args.format);
  const min = Math.max(1, Math.min(10, Math.floor(args.min_severity ?? args.minSeverity ?? 3)));
  const maxResults = Math.max(1, Math.min(100, Math.floor(args.limit ?? 20)));
  const includeTests = args.include_test_files ?? args.includeTestFiles ?? false;

  const rows = listAtlasFiles(context.db, context.workspace)
    .filter((row) => !args.cluster || row.cluster === args.cluster)
    .filter((row) => !shouldExcludePath(row.file_path, includeTests));

  if (rows.length === 0) {
    const text = 'No atlas files matched the current smell filters.';
    return textContent(formatOutput(out, { ok: false, workspace: context.workspace, cluster: args.cluster ?? null, message: text }, text));
  }

  const nodeSet = new Set(rows.map((row) => normalizePath(row.file_path)));
  const { outgoing, incoming } = buildAdjacency(listImportEdges(context.db, context.workspace), nodeSet);
  const sccSizeByNode = buildSccSizeByNode(outgoing);

  const changelog = queryAtlasChangelog(context.db, { workspace: context.workspace, limit: 50000 });
  const churnByPath = new Map<string, number>();
  for (const entry of changelog) {
    const p = normalizePath(entry.file_path);
    if (!nodeSet.has(p)) continue;
    churnByPath.set(p, (churnByPath.get(p) ?? 0) + 1);
  }

  const referenceUsage = aggregateReferenceUsage(listReferences(context.db, context.workspace), nodeSet);
  const maxReferenceUsage = Math.max(0, ...referenceUsage.values());
  const referenceThreshold = maxReferenceUsage > 0 ? maxReferenceUsage * 0.75 : Number.POSITIVE_INFINITY;

  const results: SmellResult[] = rows
    .map((row) => {
      const filePath = normalizePath(row.file_path);
      const breakdown: SmellBreakdown[] = [];
      const fanIn = incoming.get(filePath)?.length ?? 0;
      const fanOut = outgoing.get(filePath)?.length ?? 0;
      const coupling = fanIn + fanOut;
      const cycleSize = sccSizeByNode.get(filePath) ?? 1;
      const changeCount = churnByPath.get(filePath) ?? 0;
      const hazardsCount = row.hazards?.length ?? 0;
      const usage = referenceUsage.get(filePath) ?? 0;

      if (row.loc > 500) breakdown.push({ smell: 'size', points: 2, reason: `loc ${row.loc}` });
      if (row.loc > 1000) breakdown.push({ smell: 'size', points: 2, reason: `very large file (${row.loc} LOC)` });
      if (coupling > 20) breakdown.push({ smell: 'coupling', points: 3, reason: `fan-in + fan-out = ${coupling}` });
      if (coupling > 40) breakdown.push({ smell: 'coupling', points: 1, reason: `extreme coupling (${coupling})` });
      if (cycleSize > 1) breakdown.push({ smell: 'cycle', points: 3, reason: `in ${cycleSize}-node cycle` });
      if (cycleSize >= 5) breakdown.push({ smell: 'cycle', points: 1, reason: `large cycle (${cycleSize})` });
      if (changeCount > 5) breakdown.push({ smell: 'churn', points: 2, reason: `churn ${changeCount}` });
      if (changeCount > 10) breakdown.push({ smell: 'churn', points: 1, reason: `heavy churn ${changeCount}` });
      if (hazardsCount > 3) breakdown.push({ smell: 'hazards', points: 2, reason: `${hazardsCount} hazards` });
      if (hazardsCount > 6) breakdown.push({ smell: 'hazards', points: 1, reason: `high hazard count ${hazardsCount}` });
      if (usage >= referenceThreshold && Number.isFinite(referenceThreshold)) {
        breakdown.push({ smell: 'reference_usage', points: 1, reason: `reference usage ${usage}` });
      }

      const severity = Math.min(10, breakdown.reduce((sum, item) => sum + item.points, 0));
      return {
        file_path: row.file_path,
        cluster: row.cluster ?? null,
        purpose: row.purpose || row.blurb || '',
        severity,
        metrics: {
          loc: row.loc ?? 0,
          fan_in: fanIn,
          fan_out: fanOut,
          cycle_size: cycleSize,
          change_count: changeCount,
          hazards_count: hazardsCount,
          reference_usage: usage,
        },
        breakdown,
      };
    })
    .filter((entry) => entry.severity >= min)
    .sort((a, b) =>
      b.severity - a.severity ||
      (b.metrics.fan_in + b.metrics.fan_out) - (a.metrics.fan_in + a.metrics.fan_out) ||
      b.metrics.change_count - a.metrics.change_count,
    )
    .slice(0, maxResults);

  if (results.length === 0) {
    const text = `No smells found at severity >= ${min}.`;
    return textContent(formatOutput(out, { ok: false, workspace: context.workspace, cluster: args.cluster ?? null, min_severity: min, results: [], message: text }, text));
  }

  const text = [
    `## Atlas Smells (${results.length})`,
    '',
    ...results.map((entry) => `- ${entry.severity}/10 ${entry.file_path} | ${entry.breakdown.map((item) => item.reason).join('; ')}`),
  ].join('\n');

  const content: Array<{ type: 'text'; text: string }> = [{
    type: 'text',
    text: formatOutput(out, {
      ok: true,
      workspace: context.workspace,
      cluster: args.cluster ?? null,
      min_severity: min,
      include_test_files: includeTests,
      results,
      summary: {
        result_count: results.length,
        max_severity: results[0]?.severity ?? 0,
      },
    }, text),
  }];
  content.push({
    type: 'text',
    text: '💡 For high-coupling or high-severity files, run `atlas_graph action=impact file_path=...` before refactoring to measure blast radius.',
  });

  return { content };
}

async function runHotspotsAction(
  runtime: AtlasRuntime,
  args: {
    workspace?: string;
    cluster?: string;
    since?: string;
    include_test_files?: boolean;
    includeTestFiles?: boolean;
    limit?: number;
    top_n?: number;
    topN?: number;
    weights?: Record<string, number>;
    risk_weights?: Record<string, number>;
    format?: 'json' | 'text';
  },
) {
  const context = resolveDbContext(runtime, args.workspace);
  if (!context) return textContent(`Workspace "${args.workspace}" not found.`);

  const includeTests = args.include_test_files ?? args.includeTestFiles ?? false;
  const maxResults = Math.max(1, Math.min(args.limit ?? args.top_n ?? args.topN ?? 20, 200));
  const mergedWeights = {
    hazards: 0.28,
    fan_in: 0.2,
    fan_out: 0.12,
    churn: 0.18,
    breaking: 0.1,
    loc: 0.07,
    stale_days: 0.05,
    ...(args.weights ?? {}),
    ...(args.risk_weights ?? {}),
  };

  const rows = listAtlasFiles(context.db, context.workspace)
    .filter((row) => !args.cluster || row.cluster === args.cluster)
    .filter((row) => includeTests || !shouldExcludePath(row.file_path, false));

  if (rows.length === 0) {
    return textContent('No atlas files matched the current hotspot filters.');
  }

  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const edge of listImportEdges(context.db, context.workspace)) {
    fanOut.set(edge.source_file, (fanOut.get(edge.source_file) ?? 0) + 1);
    fanIn.set(edge.target_file, (fanIn.get(edge.target_file) ?? 0) + 1);
  }

  const changelog = queryAtlasChangelog(context.db, {
    workspace: context.workspace,
    cluster: args.cluster,
    since: args.since,
    limit: 5000,
  });
  const churnByFile = new Map<string, { churn: number; breaking: number }>();
  for (const entry of changelog) {
    const current = churnByFile.get(entry.file_path) ?? { churn: 0, breaking: 0 };
    current.churn += 1;
    if (entry.breaking_changes) current.breaking += 1;
    churnByFile.set(entry.file_path, current);
  }

  const metrics = rows.map((row) => ({
    file_path: row.file_path,
    cluster: row.cluster ?? null,
    purpose: row.purpose || row.blurb || '',
    metrics: {
      hazards_count: row.hazards.length,
      fan_in: fanIn.get(row.file_path) ?? 0,
      fan_out: fanOut.get(row.file_path) ?? 0,
      churn_count: churnByFile.get(row.file_path)?.churn ?? 0,
      breaking_count: churnByFile.get(row.file_path)?.breaking ?? 0,
      loc: row.loc ?? 0,
      stale_days: daysSince(row.last_extracted),
    },
  }));

  const maxima = metrics.reduce((acc, entry) => ({
    fan_in: Math.max(acc.fan_in, entry.metrics.fan_in),
    fan_out: Math.max(acc.fan_out, entry.metrics.fan_out),
    churn_count: Math.max(acc.churn_count, entry.metrics.churn_count),
  }), {
    fan_in: 0,
    fan_out: 0,
    churn_count: 0,
  });

  const results = metrics.map((entry) => {
    const normalized = {
      hazards: Math.min(entry.metrics.hazards_count / 5, 1),
      fan_in: normalizeMetric(entry.metrics.fan_in, maxima.fan_in),
      fan_out: normalizeMetric(entry.metrics.fan_out, maxima.fan_out),
      churn: normalizeMetric(entry.metrics.churn_count, maxima.churn_count),
      breaking: Math.min(entry.metrics.breaking_count / 3, 1),
      loc: Math.min(entry.metrics.loc / 800, 1),
      stale_days: Math.min(entry.metrics.stale_days / 30, 1),
    };

    const weighted = [
      { label: entry.metrics.hazards_count > 0 ? `${entry.metrics.hazards_count} hazards` : '', score: normalized.hazards * mergedWeights.hazards },
      { label: entry.metrics.fan_in > 0 ? `fan-in ${entry.metrics.fan_in}` : '', score: normalized.fan_in * mergedWeights.fan_in },
      { label: entry.metrics.fan_out > 0 ? `fan-out ${entry.metrics.fan_out}` : '', score: normalized.fan_out * mergedWeights.fan_out },
      { label: entry.metrics.churn_count > 0 ? `churn ${entry.metrics.churn_count}` : '', score: normalized.churn * mergedWeights.churn },
      { label: entry.metrics.breaking_count > 0 ? `breaking ${entry.metrics.breaking_count}` : '', score: normalized.breaking * mergedWeights.breaking },
      { label: entry.metrics.loc > 0 ? `loc ${entry.metrics.loc}` : '', score: normalized.loc * mergedWeights.loc },
      { label: entry.metrics.stale_days > 0 ? `stale ${entry.metrics.stale_days.toFixed(1)}d` : '', score: normalized.stale_days * mergedWeights.stale_days },
    ].filter((item) => item.score > 0 && item.label);

    return {
      file_path: entry.file_path,
      cluster: entry.cluster,
      purpose: entry.purpose,
      risk_score: weighted.reduce((sum, item) => sum + item.score, 0),
      top_reasons: weighted.sort((a, b) => b.score - a.score).slice(0, 3).map((item) => item.label),
      metrics: entry.metrics,
    };
  })
    .sort((a, b) => b.risk_score - a.risk_score || b.metrics.fan_in - a.metrics.fan_in || b.metrics.churn_count - a.metrics.churn_count)
    .slice(0, maxResults);

  const lines = [
    '## Atlas Hotspots',
    '',
    ...results.map((entry) => `- ${entry.file_path} | score=${entry.risk_score.toFixed(3)} | ${entry.top_reasons.join(', ') || 'no strong signals'}`),
    '',
    '### Summary',
    `- Workspace: ${context.workspace}`,
    `- Results: ${results.length}`,
  ];

  return {
    content: [
      {
        type: 'text',
        text: formatOutput(resolveFormat(args.format), {
          ok: true,
          workspace: context.workspace,
          filters: {
            cluster: args.cluster ?? null,
            since: args.since ?? null,
            include_test_files: includeTests,
            limit: maxResults,
          },
          weights: mergedWeights,
          results,
          summary: {
            result_count: results.length,
            max_risk_score: results[0]?.risk_score ?? 0,
          },
        }, lines.join('\n')),
      },
      {
        type: 'text',
        text: '💡 For hotspot files, run `atlas_query action=lookup file_path=...` to get full context before refactoring.',
      },
    ],
  };
}

export function registerAuditTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_audit',
    [
      'Quality and risk scanner — use atlas_audit to find what needs attention instead of manually reviewing files.',
      '',
      'Actions: gaps finds dead code and incomplete atlas entries — exported-but-unreferenced, imported-but-unused, loaded-but-unused artifacts, installed-but-not-imported packages, and files with hollow atlas records (missing blurb, purpose, hazards, etc.); smells ranks files by combined maintainability signals; hotspots ranks files by risk using churn, coupling, hazards, and reference activity.',
      '',
      'Use gaps with gapTypes=["incomplete_atlas_entry"] to find which files still need agent enrichment via atlas_commit. Use hotspots before investing review time. Use smells to find high-friction files worth redesigning. Scope by cluster to focus on one subsystem.',
    ].join('\n'),
    {
      action: z.enum(['gaps', 'smells', 'hotspots']),
      workspace: z.string().optional(),
      cluster: z.string().optional(),
      limit: z.coerce.number().int().optional(),
      format: z.enum(['json', 'text']).optional(),
      include_test_files: coercedOptionalBoolean,
      includeTestFiles: coercedOptionalBoolean,
      file_path: z.string().optional(),
      filePath: z.string().optional(),
      gap_types: z.array(z.enum(GAP_TYPES)).optional(),
      gapTypes: z.array(z.enum(GAP_TYPES)).optional(),
      min_severity: z.coerce.number().int().optional(),
      minSeverity: z.coerce.number().int().optional(),
      since: z.string().optional(),
      top_n: z.coerce.number().int().optional(),
      topN: z.coerce.number().int().optional(),
      weights: z.record(z.string(), z.number()).optional(),
      risk_weights: z.record(z.string(), z.number()).optional(),
    },
    async (input: unknown) => {
      const args = input as {
        action: AuditAction;
        workspace?: string;
        cluster?: string;
        limit?: number;
        format?: 'json' | 'text';
        include_test_files?: boolean;
        includeTestFiles?: boolean;
        file_path?: string;
        filePath?: string;
        gap_types?: GapType[];
        gapTypes?: GapType[];
        min_severity?: number;
        minSeverity?: number;
        since?: string;
        top_n?: number;
        topN?: number;
        weights?: Record<string, number>;
        risk_weights?: Record<string, number>;
      };

      switch (args.action) {
        case 'gaps':
          return runGapsAction(runtime, args);
        case 'smells':
          return runSmellsAction(runtime, args);
        case 'hotspots':
          return runHotspotsAction(runtime, args);
      }
    },
  );
}
