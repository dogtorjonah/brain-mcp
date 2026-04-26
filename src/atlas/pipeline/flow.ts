/**
 * Flow Phase — Deterministic AST Flow Heuristics
 *
 * Uses Tree-sitter to extract higher-level data-flow and control-flow edges
 * from TypeScript/JavaScript files after the structure phase has populated symbols.
 *
 * Writes a separate AST edge namespace to `references`:
 *   - DATA_FLOWS_TO
 *   - PRODUCES
 *   - CONSUMES
 *   - TRIGGERS
 */

import type { AtlasDatabase } from '../db.js';
import type { ScanFileInfo } from './scan.js';
import { readSourceFile } from './shared.js';
import {
  detectAstLanguage,
  isTreeSitterAvailable,
  parseSource,
  type SupportedAstLanguage,
  type SyntaxNodeLike,
} from './treesitter.js';

export interface FlowResult {
  edgesExtracted: number;
  filesProcessed: number;
  filesSkipped: number;
}

interface FlowReferenceInput {
  sourceFile: string;
  targetFile: string;
  sourceSymbolName: string;
  targetSymbolName: string;
  edgeType: FlowEdgeType;
  confidence: number;
}

type FlowEdgeType = 'DATA_FLOWS_TO' | 'PRODUCES' | 'CONSUMES' | 'TRIGGERS';

interface RawFlowEdge {
  sourceName: string;
  targetName: string;
  evidenceFile: string;
  edgeType: FlowEdgeType;
  confidence: number;
}

interface EmittedEvent {
  eventName: string;
  sourceName: string;
  evidenceFile: string;
}

interface EventListener {
  eventName: string;
  handlerName: string;
  evidenceFile: string;
}

interface SymbolEntry {
  name: string;
  filePath: string;
  exported: boolean;
}

type GlobalSymbolTable = Map<string, SymbolEntry[]>;

interface ExtractionResult {
  edges: RawFlowEdge[];
  emittedEvents: EmittedEvent[];
  listeners: EventListener[];
}

const FLOW_EDGE_TYPES: FlowEdgeType[] = ['DATA_FLOWS_TO', 'PRODUCES', 'CONSUMES', 'TRIGGERS'];

const CALLBACK_TRIGGER_PROPS = new Set([
  'then',
  'catch',
  'finally',
  'use',
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'map',
  'filter',
  'forEach',
  'reduce',
]);

const EVENT_EMITTER_PROPS = new Set(['emit']);
const EVENT_LISTENER_PROPS = new Set(['on', 'once', 'addEventListener']);
const TIMER_CALLS = new Set(['setTimeout', 'setInterval']);
const NESTED_SCOPE_TYPES = new Set([
  'function_declaration',
  'class_declaration',
  'arrow_function',
  'function',
  'method_definition',
]);

export async function runFlow(
  files: ScanFileInfo[],
  db: AtlasDatabase,
  workspace: string,
  sourceRoot: string,
  onProgress?: (message: string, progress: number) => void,
): Promise<FlowResult> {
  if (!isTreeSitterAvailable()) {
    console.warn('[flow] tree-sitter not available, skipping flow analysis');
    return { edgesExtracted: 0, filesProcessed: 0, filesSkipped: files.length };
  }

  onProgress?.('Starting flow analysis...', 0);

  const rawEdges: RawFlowEdge[] = [];
  const emittedEvents: EmittedEvent[] = [];
  const listeners: EventListener[] = [];
  const processedFiles: string[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!;
    const lang = detectAstLanguage(file.filePath);
    if (!isSupportedFlowLanguage(lang)) {
      filesSkipped += 1;
      continue;
    }

    try {
      const source = await readSourceFile(sourceRoot, file.filePath);
      if (!source) {
        filesSkipped += 1;
        continue;
      }

      const extraction = extractFlowFromTree(
        parseSource(source, lang).rootNode,
        file.filePath,
      );

      rawEdges.push(...extraction.edges);
      emittedEvents.push(...extraction.emittedEvents);
      listeners.push(...extraction.listeners);
      processedFiles.push(file.filePath);
      filesProcessed += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[flow] Failed to parse ${file.filePath}: ${msg}`);
      filesSkipped += 1;
    }

    if (i > 0 && i % 50 === 0) {
      onProgress?.(`Parsed ${i}/${files.length} files...`, (i / files.length) * 50);
    }
  }

  onProgress?.('Resolving flow edges...', 60);

  const globalSymbolTable = buildGlobalSymbolTable(db, workspace);
  const importMap = buildImportMap(db, workspace, files);
  rawEdges.push(...resolveEventEdges(emittedEvents, listeners));

  const resolved = resolveFlowEdges(rawEdges, globalSymbolTable, importMap);
  upsertAstFlowReferences(db, workspace, resolved, processedFiles);

  onProgress?.('Flow analysis complete!', 100);

  return {
    edgesExtracted: resolved.length,
    filesProcessed,
    filesSkipped,
  };
}

function isSupportedFlowLanguage(
  language: SupportedAstLanguage | null,
): language is 'typescript' | 'tsx' | 'javascript' {
  return language === 'typescript' || language === 'tsx' || language === 'javascript';
}

function extractFlowFromTree(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const edges: RawFlowEdge[] = [];
  const emittedEvents: EmittedEvent[] = [];
  const listeners: EventListener[] = [];

  function visit(node: SyntaxNodeLike, exported: boolean): void {
    switch (node.type) {
      case 'export_statement':
        for (const child of node.namedChildren) {
          visit(child, true);
        }
        return;
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (nameNode && body) {
          analyzeScope(body, nameNode.text, filePath, getParameterNames(node), edges, emittedEvents, listeners);
        }
        return;
      }
      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        const body = node.childForFieldName('body');
        if (nameNode && body) {
          const className = nameNode.text;
          for (const member of body.namedChildren) {
            if (member.type !== 'method_definition') continue;
            const methodName = member.childForFieldName('name');
            const methodBody = member.childForFieldName('body');
            if (methodName && methodBody) {
              analyzeScope(
                methodBody,
                `${className}.${methodName.text}`,
                filePath,
                getParameterNames(member),
                edges,
                emittedEvents,
                listeners,
              );
            }
          }
        }
        return;
      }
      case 'lexical_declaration': {
        for (const declarator of node.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const nameNode = declarator.childForFieldName('name');
          const value = declarator.childForFieldName('value');
          if (!nameNode || !value) continue;
          const isFunction = value.type === 'arrow_function' || value.type === 'function';
          if (!isFunction) continue;
          const body = value.childForFieldName('body');
          if (!body) continue;
          analyzeScope(body, nameNode.text, filePath, getParameterNames(value), edges, emittedEvents, listeners);
        }
        return;
      }
      default:
        break;
    }

    for (const child of node.namedChildren) {
      visit(child, exported);
    }
  }

  visit(root, false);
  return { edges, emittedEvents, listeners };
}

function analyzeScope(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  params: Set<string>,
  edges: RawFlowEdge[],
  emittedEvents: EmittedEvent[],
  listeners: EventListener[],
): void {
  const variableOrigins = new Map<string, string>();

  function walk(current: SyntaxNodeLike): void {
    if (current.type === 'variable_declarator') {
      const nameNode = current.childForFieldName('name');
      const valueNode = current.childForFieldName('value');
      if (nameNode && valueNode && nameNode.type === 'identifier') {
        const producer = resolveProducerName(valueNode, variableOrigins);
        if (producer) {
          variableOrigins.set(nameNode.text, producer);
        }
      }
    }

    if (current.type === 'assignment_expression') {
      const left = current.childForFieldName('left');
      const right = current.childForFieldName('right');
      if (left && right && left.type === 'identifier') {
        const producer = resolveProducerName(right, variableOrigins);
        if (producer) {
          variableOrigins.set(left.text, producer);
        }
      }
    }

    if (current.type === 'return_statement') {
      const returned = current.namedChildren[0] ?? null;
      if (returned) {
        edges.push({
          sourceName: scopeName,
          targetName: scopeName,
          evidenceFile: filePath,
          edgeType: 'PRODUCES',
          confidence: 0.8,
        });
        const producer = resolveProducerName(returned, variableOrigins);
        if (producer) {
          edges.push({
            sourceName: producer,
            targetName: scopeName,
            evidenceFile: filePath,
            edgeType: 'DATA_FLOWS_TO',
            confidence: 0.8,
          });
        }
      }
    }

    if (current.type === 'call_expression') {
      handleCallExpression(current, scopeName, filePath, params, variableOrigins, edges, emittedEvents, listeners);
    }

    for (const child of current.namedChildren) {
      if (NESTED_SCOPE_TYPES.has(child.type)) continue;
      walk(child);
    }
  }

  walk(node);
}

function handleCallExpression(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  params: Set<string>,
  variableOrigins: Map<string, string>,
  edges: RawFlowEdge[],
  emittedEvents: EmittedEvent[],
  listeners: EventListener[],
): void {
  const func = node.childForFieldName('function');
  const argsNode = node.childForFieldName('arguments');
  if (!func || !argsNode) return;

  const calleeName = resolveCalleeName(func);
  const memberProp = resolveMemberProperty(func);
  const args = argsNode.namedChildren;

  if (calleeName) {
    for (const arg of args) {
      if (arg.type === 'identifier' && params.has(arg.text)) {
        edges.push({
          sourceName: scopeName,
          targetName: calleeName,
          evidenceFile: filePath,
          edgeType: 'CONSUMES',
          confidence: 0.8,
        });
      }

      const producer = resolveProducerName(arg, variableOrigins);
      if (producer && producer !== calleeName) {
        edges.push({
          sourceName: producer,
          targetName: calleeName,
          evidenceFile: filePath,
          edgeType: 'DATA_FLOWS_TO',
          confidence: 0.8,
        });
      }
    }
  }

  if (memberProp && EVENT_EMITTER_PROPS.has(memberProp)) {
    const eventName = resolveStringLiteral(args[0] ?? null);
    if (eventName) {
      emittedEvents.push({ eventName, sourceName: scopeName, evidenceFile: filePath });
    }
  }

  if (memberProp && EVENT_LISTENER_PROPS.has(memberProp)) {
    const eventName = resolveStringLiteral(args[0] ?? null);
    const handlerName = resolveCallbackName(args[1] ?? null);
    if (eventName && handlerName) {
      listeners.push({ eventName, handlerName, evidenceFile: filePath });
    }
  }

  const directCallee = calleeName ?? null;
  if ((memberProp && CALLBACK_TRIGGER_PROPS.has(memberProp)) || (directCallee && TIMER_CALLS.has(directCallee))) {
    for (const arg of args) {
      const callbackName = resolveCallbackName(arg);
      if (!callbackName) continue;
      edges.push({
        sourceName: scopeName,
        targetName: callbackName,
        evidenceFile: filePath,
        edgeType: 'TRIGGERS',
        confidence: 0.8,
      });
    }
  }
}

function getParameterNames(node: SyntaxNodeLike): Set<string> {
  const params = new Set<string>();
  const paramNode = node.childForFieldName('parameters');
  if (!paramNode) return params;
  collectIdentifiers(paramNode, params);
  return params;
}

function collectIdentifiers(node: SyntaxNodeLike, out: Set<string>): void {
  if (node.type === 'identifier') {
    out.add(node.text);
  }
  for (const child of node.namedChildren) {
    collectIdentifiers(child, out);
  }
}

function resolveProducerName(
  node: SyntaxNodeLike | null,
  variableOrigins: Map<string, string>,
): string | null {
  if (!node) return null;
  if (node.type === 'identifier') {
    return variableOrigins.get(node.text) ?? null;
  }
  if (node.type === 'call_expression') {
    const func = node.childForFieldName('function');
    return func ? resolveCalleeName(func) : null;
  }
  if (node.type === 'await_expression' || node.type === 'parenthesized_expression') {
    return resolveProducerName(node.namedChildren[0] ?? null, variableOrigins);
  }
  return null;
}

function resolveCalleeName(node: SyntaxNodeLike): string | null {
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    const object = node.childForFieldName('object');
    const property = node.childForFieldName('property');
    if (object && property) {
      if (object.text === 'this' || object.text === 'super') {
        return property.text;
      }
      return `${object.text}.${property.text}`;
    }
  }
  return null;
}

function resolveMemberProperty(node: SyntaxNodeLike): string | null {
  if (node.type !== 'member_expression') return null;
  return node.childForFieldName('property')?.text ?? null;
}

function resolveCallbackName(node: SyntaxNodeLike | null): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') return resolveCalleeName(node);
  return null;
}

function resolveStringLiteral(node: SyntaxNodeLike | null): string | null {
  if (!node) return null;
  if (node.type === 'string' || node.type === 'string_fragment') {
    return stripQuotes(node.text);
  }
  if (node.type === 'template_string' && node.namedChildren.length === 1) {
    return stripQuotes(node.text);
  }
  return null;
}

function stripQuotes(text: string): string {
  return text.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

function resolveEventEdges(
  emittedEvents: EmittedEvent[],
  listeners: EventListener[],
): RawFlowEdge[] {
  const edges: RawFlowEdge[] = [];
  for (const emitted of emittedEvents) {
    for (const listener of listeners) {
      if (emitted.eventName !== listener.eventName) continue;
      edges.push({
        sourceName: emitted.sourceName,
        targetName: listener.handlerName,
        evidenceFile: emitted.evidenceFile,
        edgeType: 'TRIGGERS',
        confidence: 0.8,
      });
    }
  }
  return edges;
}

function buildGlobalSymbolTable(
  db: AtlasDatabase,
  workspace: string,
): GlobalSymbolTable {
  const table: GlobalSymbolTable = new Map();
  const rows = db.prepare(
    'SELECT file_path, name, exported FROM symbols WHERE workspace = ?',
  ).all(workspace) as Array<{ file_path: string; name: string; exported: number | boolean }>;

  for (const row of rows) {
    const entry: SymbolEntry = {
      name: row.name,
      filePath: row.file_path,
      exported: Boolean(row.exported),
    };
    const baseName = row.name.includes('.') ? row.name.split('.').pop()! : row.name;
    pushSymbolEntry(table, baseName, entry);
    if (row.name !== baseName) {
      pushSymbolEntry(table, row.name, entry);
    }
  }

  return table;
}

function pushSymbolEntry(
  table: GlobalSymbolTable,
  key: string,
  entry: SymbolEntry,
): void {
  if (!table.has(key)) table.set(key, []);
  table.get(key)!.push(entry);
}

function buildImportMap(
  db: AtlasDatabase,
  workspace: string,
  files: ScanFileInfo[],
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const stmt = db.prepare(
    'SELECT target_file FROM import_edges WHERE workspace = ? AND source_file = ?',
  );

  for (const file of files) {
    const rows = stmt.all(workspace, file.filePath) as Array<{ target_file: string }>;
    if (rows.length > 0) {
      map.set(file.filePath, new Set(rows.map((row) => row.target_file)));
    }
  }

  return map;
}

function resolveFlowEdges(
  rawEdges: RawFlowEdge[],
  globalSymbolTable: GlobalSymbolTable,
  importMap: Map<string, Set<string>>,
): FlowReferenceInput[] {
  const seen = new Set<string>();
  const resolved: FlowReferenceInput[] = [];

  for (const edge of rawEdges) {
    const source = resolveSymbol(edge.sourceName, edge.evidenceFile, globalSymbolTable, importMap);
    const target = resolveSymbol(edge.targetName, edge.evidenceFile, globalSymbolTable, importMap);
    if (!source || !target) continue;

    const key = `${source.filePath}|${source.name}|${target.filePath}|${target.name}|${edge.edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    resolved.push({
      sourceFile: source.filePath,
      targetFile: target.filePath,
      sourceSymbolName: source.name,
      targetSymbolName: target.name,
      edgeType: edge.edgeType,
      confidence: edge.confidence,
    });
  }

  return resolved;
}

function resolveSymbol(
  name: string,
  evidenceFile: string,
  globalSymbolTable: GlobalSymbolTable,
  importMap: Map<string, Set<string>>,
): SymbolEntry | null {
  const candidates = globalSymbolTable.get(name);
  if (!candidates || candidates.length === 0) return null;

  const imported = importMap.get(evidenceFile) ?? new Set<string>();

  const sameFile = candidates.find((candidate) => candidate.filePath === evidenceFile);
  if (sameFile) return sameFile;

  const importedCandidate = candidates.find((candidate) => imported.has(candidate.filePath));
  if (importedCandidate) return importedCandidate;

  const exportedCandidate = candidates.find((candidate) => candidate.exported);
  if (exportedCandidate) return exportedCandidate;

  return candidates[0] ?? null;
}

function upsertAstFlowReferences(
  db: AtlasDatabase,
  workspace: string,
  references: FlowReferenceInput[],
  processedFiles: string[],
): void {
  const bySourceFile = new Map<string, FlowReferenceInput[]>();
  for (const ref of references) {
    if (!bySourceFile.has(ref.sourceFile)) bySourceFile.set(ref.sourceFile, []);
    bySourceFile.get(ref.sourceFile)!.push(ref);
  }

  const deleteStmt = db.prepare(
    `DELETE FROM "references"
      WHERE workspace = ?
        AND source_file = ?
        AND provenance = 'ast'
        AND edge_type IN ('DATA_FLOWS_TO', 'PRODUCES', 'CONSUMES', 'TRIGGERS')`,
  );
  const getSymbolIdStmt = db.prepare(
    'SELECT id FROM symbols WHERE workspace = ? AND file_path = ? AND name = ? LIMIT 1',
  );
  const insertStmt = db.prepare(
    `INSERT INTO "references" (
       workspace, source_symbol_id, target_symbol_id, edge_type, source_file, target_file,
       usage_count, confidence, provenance, last_verified, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'ast', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  );

  const tx = db.transaction(() => {
    for (const filePath of processedFiles) {
      deleteStmt.run(workspace, filePath);
    }

    for (const refs of bySourceFile.values()) {
      for (const ref of refs) {
        const srcRow = getSymbolIdStmt.get(workspace, ref.sourceFile, ref.sourceSymbolName) as { id: number } | undefined;
        const tgtRow = getSymbolIdStmt.get(workspace, ref.targetFile, ref.targetSymbolName) as { id: number } | undefined;

        insertStmt.run(
          workspace,
          srcRow?.id ?? null,
          tgtRow?.id ?? null,
          ref.edgeType,
          ref.sourceFile,
          ref.targetFile,
          ref.confidence,
        );
      }
    }
  });

  tx();
}
