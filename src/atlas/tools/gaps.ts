import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasFileRecord, AtlasRuntime } from '../types.js';
import type { AtlasDatabase } from '../db.js';
import { listAtlasFiles, listImportEdges } from '../db.js';
import { discoverWorkspaces } from './bridge.js';
import { toolWithDescription } from './helpers.js';
import {
  includesStructuralSymbolByContext,
  isStructuralSymbolName,
  supportsStructuralImportExportAnalysis,
} from './structuralSymbols.js';

const GAP_TYPES = [
  'loaded_not_used',
  'exported_not_referenced',
  'imported_not_used',
  'installed_not_imported',
  'incomplete_atlas_entry',
] as const;

type GapType =
  | 'loaded_not_used'
  | 'exported_not_referenced'
  | 'imported_not_used'
  | 'installed_not_imported'
  | 'incomplete_atlas_entry';

interface GapFinding {
  gapType: GapType;
  filePath: string;
  subject: string;
  evidence: string[];
  note?: string;
}

interface WorkspaceRuntime {
  db: AtlasDatabase;
  sourceRoot: string;
  workspace: string;
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

function resolveWorkspace(runtime: AtlasRuntime, workspace?: string): WorkspaceRuntime | null {
  if (!workspace || workspace === runtime.config.workspace) {
    return {
      db: runtime.db,
      sourceRoot: runtime.config.sourceRoot,
      workspace: runtime.config.workspace,
    };
  }

  const discovered = discoverWorkspaces(runtime.config.sourceRoot);
  const target = discovered.find((candidate) => candidate.workspace === workspace);
  if (!target) return null;
  return {
    db: target.db,
    sourceRoot: target.sourceRoot,
    workspace: target.workspace,
  };
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
    if (symbols?.[symbol] && symbols[symbol].total_usages > 0) {
      return true;
    }
    const contexts = collectCrossRefTexts(file);
    if (contexts.some((text) => includesStructuralSymbolByContext(text, symbol))) {
      return true;
    }
  }
  return false;
}

function symbolUsedInRow(symbol: string, row: AtlasFileRecord): boolean {
  const symbols = row.cross_refs?.symbols;
  if (symbols?.[symbol] && symbols[symbol].total_usages > 0) return true;
  const contexts = collectCrossRefTexts(row);
  return contexts.some((text) => includesStructuralSymbolByContext(text, symbol));
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
          extracted.push({
            symbol,
            flow,
            strong: pattern.strong,
          });
        }
        match = pattern.regex.exec(flow);
      }
    }
  }

  const dedup = new Map<string, { symbol: string; flow: string; strong: boolean }>();
  for (const item of extracted) {
    const existing = dedup.get(item.symbol);
    if (!existing || (!existing.strong && item.strong)) {
      dedup.set(item.symbol, item);
    }
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

  const candidates = [
    rel,
    `${withoutJsExt}.js`,
    `${withoutJsExt}.ts`,
    withoutJsExt,
    `${withoutJsExt}/index`,
    `${withoutJsExt}/index.js`,
  ];

  return new Set(candidates);
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
      const absolute = path.join(sourceRoot, file.file_path);
      const source = await fs.readFile(absolute, 'utf8');
      for (const pattern of importRegexes) {
        let match: RegExpExecArray | null = pattern.exec(source);
        while (match) {
          const pkg = normalizePackageName(match[1] ?? '');
          if (pkg) imported.add(pkg);
          match = pattern.exec(source);
        }
      }
    } catch {
      // Ignore unreadable files
    }
  }));

  return imported;
}

function formatFinding(finding: GapFinding): string {
  const evidence = finding.evidence.join(' | ');
  const note = finding.note ? `\n  Note: ${finding.note}` : '';
  return `- \`${finding.subject}\` — ${evidence}${note}`;
}

export function registerGapsTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_gaps',
    'Detect structural gaps in the codebase: dead exports no one imports, unused imports, loaded-but-unused data, installed-but-never-imported packages, and incomplete atlas entries with missing metadata (blurb, purpose, cross_refs, hazards, etc.). Can scope to a single file or cluster. Use during cleanup or before refactoring.',
    {
      filePath: z.string().min(1).optional(),
      cluster: z.string().min(1).optional(),
      workspace: z.string().optional(),
      gapTypes: z.array(z.enum(GAP_TYPES)).optional(),
    },
    async (input: unknown) => {
      const {
        filePath,
        cluster,
        workspace,
        gapTypes,
      } = input as {
        filePath?: string;
        cluster?: string;
        workspace?: string;
        gapTypes?: GapType[];
      };
      const target = resolveWorkspace(runtime, workspace);
      if (!target) {
        return {
          content: [{ type: 'text', text: `Workspace "${workspace}" not found.` }],
        };
      }

      const types = gapTypes && gapTypes.length > 0 ? gapTypes : DEFAULT_GAP_TYPES;
      const scopedFiles = getScopeFiles(target.db, target.workspace, filePath, cluster);
      if (scopedFiles.length === 0) {
        return {
          content: [{
            type: 'text',
            text: 'No files matched the requested scope.',
          }],
        };
      }

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
            const usedInSource = symbolUsedInRow(symbol, file);
            const usedDownstream = symbolUsedAnywhere(symbol, downstreamRows);
            if (usedInSource || usedDownstream) continue;

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
            const globallyUsed = symbolUsedAnywhere(symbol, allFiles);
            const totalUsages = direct?.total_usages ?? 0;
            if (totalUsages > 0 || globallyUsed) continue;
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
          if (!sourceText) {
            continue;
          }

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
            for (const name of entry.importedNames) {
              importedIdentifiers.add(name);
            }
          }

          const usedAnyIdentifier = [...importedIdentifiers].some((name) =>
            includesStructuralSymbolByContext(bodyWithoutImports, name));
          const usedAnyTargetSymbol = [...symbolCandidates].some((symbol) =>
            includesStructuralSymbolByContext(bodyWithoutImports, symbol));
          const usedAny = usedAnyIdentifier || usedAnyTargetSymbol;

          if (usedAny) continue;

          const sideEffectLikely = sideEffectImportOnly || symbolCandidates.size === 0;
          findings.push({
            gapType: 'imported_not_used',
            filePath: edge.source_file,
            subject: edge.target_file,
            evidence: [
              `import edge exists: ${edge.source_file} -> ${edge.target_file}`,
              `import bindings found but no local usage in source body`,
            ],
            note: sideEffectLikely
              ? 'suspected: may be intentional side-effect import'
              : undefined,
          });
        }
      }

      if (types.includes('installed_not_imported')) {
        try {
          const packageJsonPath = path.join(target.sourceRoot, 'package.json');
          const packageJsonRaw = await fs.readFile(packageJsonPath, 'utf8');
          const packageJson = JSON.parse(packageJsonRaw) as {
            dependencies?: Record<string, string>;
          };
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

          if (!file.blurb || file.blurb.trim() === '') missing.push('blurb');
          if (!file.purpose || file.purpose.trim() === '') missing.push('purpose');
          if (!file.extraction_model || file.extraction_model === 'scaffold') missing.push('extraction (scaffold or none)');

          const crossRefs = file.cross_refs;
          if (!crossRefs || (typeof crossRefs === 'object' && (!crossRefs.symbols || Object.keys(crossRefs.symbols).length === 0) && !crossRefs.crossref_timestamp)) {
            missing.push('cross_refs');
          }

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

      const totalFindings = findings.length;
      const displayedFindings = findings.slice(0, MAX_FINDINGS);
      const scopeLabel = filePath ?? cluster ?? `${scopedFiles.length} scoped files`;
      const lines: string[] = [];
      lines.push(`## Structural Gaps: ${scopeLabel}`);
      lines.push('');

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
        lines.push(`⚠️ Showing first ${MAX_FINDINGS} of ${totalFindings} findings. Narrow the scope with filePath, cluster, or gapTypes for a complete report.`);
      }

      return {
        content: [{
          type: 'text',
          text: lines.join('\n').trim(),
        }],
      };
    },
  );
}
