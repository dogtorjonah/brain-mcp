/**
 * Structure Phase — Deterministic AST Analysis
 *
 * Uses Tree-sitter to extract symbol definitions and structural edges
 * (CALLS, EXTENDS, IMPLEMENTS, HAS_METHOD) from source code.
 *
 * Runs after scan (file discovery) and before summarize (LLM blurbs).
 * Writes to existing `symbols` and `references` tables with provenance='ast'.
 */

import type { AtlasDatabase, AtlasSymbolUpsertInput } from '../db.js';
import { upsertSymbolsForFile } from '../db.js';
import type { ScanFileInfo } from './scan.js';
import { readSourceFile } from './shared.js';
import {
  detectAstLanguage,
  parseSource,
  isTreeSitterAvailable,
  type SupportedAstLanguage,
  type SyntaxNodeLike,
} from './treesitter.js';

// ============================================================================
// PUBLIC TYPES
// ============================================================================

export interface StructureResult {
  symbolsExtracted: number;
  edgesExtracted: number;
  filesProcessed: number;
  filesSkipped: number;
}

export interface AstReferenceInput {
  sourceFile: string;
  targetFile: string;
  sourceSymbolName: string;
  targetSymbolName: string;
  edgeType: string;
  confidence: number;
}

// ============================================================================
// INTERNAL TYPES
// ============================================================================

interface ExtractedSymbol {
  name: string;
  kind: string;
  exported: boolean;
  lineStart: number;
  lineEnd: number;
  filePath: string;
}

interface RawEdge {
  sourceSymbolName: string;
  sourceFilePath: string;
  targetName: string;
  edgeType: 'CALLS' | 'EXTENDS' | 'IMPLEMENTS' | 'HAS_METHOD';
  lineNumber: number;
}

interface SymbolEntry {
  name: string; // canonical full name (e.g., 'ClassName.method')
  filePath: string;
  kind: string;
  exported: boolean;
}

type GlobalSymbolTable = Map<string, SymbolEntry[]>;

// ============================================================================
// MAIN ENTRY POINT
// ============================================================================

/**
 * Run deterministic AST analysis on all supported files.
 *
 * 1. Parse each file with Tree-sitter → extract symbols and raw edges
 * 2. Build global symbol table → resolve cross-file edges
 * 3. Write symbols and AST references to DB
 */
export async function runStructure(
  files: ScanFileInfo[],
  db: AtlasDatabase,
  workspace: string,
  sourceRoot: string,
  onProgress?: (message: string, progress: number) => void,
): Promise<StructureResult> {
  if (!isTreeSitterAvailable()) {
    console.warn('[structure] tree-sitter not available, skipping structural analysis');
    return { symbolsExtracted: 0, edgesExtracted: 0, filesProcessed: 0, filesSkipped: files.length };
  }

  onProgress?.('Starting structural analysis...', 0);

  const allSymbols = new Map<string, ExtractedSymbol[]>();
  const allEdges: RawEdge[] = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  // Phase 1: Parse all files and extract symbols + raw edges
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const lang = detectAstLanguage(file.filePath);

    if (!lang) {
      filesSkipped++;
      continue;
    }

    try {
      const source = await readSourceFile(sourceRoot, file.filePath);
      if (!source) {
        filesSkipped++;
        continue;
      }

      const { symbols, edges } = extractFromTree(
        parseSource(source, lang).rootNode,
        file.filePath,
        lang,
      );

      allSymbols.set(file.filePath, symbols);
      allEdges.push(...edges);
      filesProcessed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[structure] Failed to parse ${file.filePath}: ${msg}`);
      filesSkipped++;
    }

    if (i > 0 && i % 50 === 0) {
      onProgress?.(`Parsed ${i}/${files.length} files...`, (i / files.length) * 50);
    }
  }

  onProgress?.(`Parsed ${filesProcessed} files, writing symbols...`, 50);

  // Phase 2: Write symbols to DB — call for ALL parseable files (even empty) to clear stale symbols
  let totalSymbols = 0;
  for (const [filePath, symbols] of allSymbols) {
    const upsertInputs: AtlasSymbolUpsertInput[] = symbols.map((s) => ({
      workspace,
      file_path: filePath,
      name: s.name,
      kind: s.kind,
      exported: s.exported,
      line_start: s.lineStart,
      line_end: s.lineEnd,
    }));

    upsertSymbolsForFile(db, workspace, filePath, upsertInputs);
    totalSymbols += upsertInputs.length;
  }

  onProgress?.(`Wrote ${totalSymbols} symbols, resolving edges...`, 70);

  // Phase 3: Resolve cross-file edges and write references
  const globalSymbolTable = buildGlobalSymbolTable(allSymbols);
  const importMap = buildImportMap(db, workspace, files);
  const resolvedEdges = resolveEdges(allEdges, globalSymbolTable, importMap);

  // Pass all processed file paths so stale AST rows are cleaned even for zero-edge files
  const processedFiles = Array.from(allSymbols.keys());
  upsertAstReferences(db, workspace, resolvedEdges, processedFiles);

  onProgress?.('Structural analysis complete!', 100);

  return {
    symbolsExtracted: totalSymbols,
    edgesExtracted: resolvedEdges.length,
    filesProcessed,
    filesSkipped,
  };
}

// ============================================================================
// AST EXTRACTION — LANGUAGE DISPATCH
// ============================================================================

interface ExtractionResult {
  symbols: ExtractedSymbol[];
  edges: RawEdge[];
}

function extractFromTree(
  root: SyntaxNodeLike,
  filePath: string,
  language: SupportedAstLanguage,
): ExtractionResult {
  switch (language) {
    case 'python':
      return extractPython(root, filePath);
    case 'go':
      return extractGo(root, filePath);
    case 'rust':
      return extractRust(root, filePath);
    case 'java':
      return extractJava(root, filePath);
    default:
      return extractTypeScriptJavaScript(root, filePath);
  }
}

// ============================================================================
// AST EXTRACTION — TYPESCRIPT / JAVASCRIPT
// ============================================================================

function extractTypeScriptJavaScript(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const edges: RawEdge[] = [];

  function visit(node: SyntaxNodeLike, exported: boolean): void {
    switch (node.type) {
      case 'export_statement': {
        for (const child of node.namedChildren) {
          visit(child, true);
        }
        return;
      }

      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'function',
            exported,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          const body = node.childForFieldName('body');
          if (body) extractCalls(body, nameNode.text, filePath, edges);
        }
        return;
      }

      case 'class_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const className = nameNode.text;
          symbols.push({
            name: className,
            kind: 'class',
            exported,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          extractHeritage(node, className, filePath, edges);

          const body = node.childForFieldName('body');
          if (body) {
            for (const member of body.namedChildren) {
              if (member.type === 'method_definition') {
                const methodName = member.childForFieldName('name');
                if (methodName) {
                  const fullName = `${className}.${methodName.text}`;
                  symbols.push({
                    name: fullName,
                    kind: 'method',
                    exported,
                    lineStart: member.startPosition.row + 1,
                    lineEnd: member.endPosition.row + 1,
                    filePath,
                  });

                  edges.push({
                    sourceSymbolName: className,
                    sourceFilePath: filePath,
                    targetName: fullName,
                    edgeType: 'HAS_METHOD',
                    lineNumber: member.startPosition.row + 1,
                  });

                  const methodBody = member.childForFieldName('body');
                  if (methodBody) extractCalls(methodBody, fullName, filePath, edges);
                }
              }
            }
          }
        }
        return;
      }

      case 'interface_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'interface',
            exported,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });
        }
        return;
      }

      case 'type_alias_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'type',
            exported,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });
        }
        return;
      }

      case 'enum_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          symbols.push({
            name: nameNode.text,
            kind: 'enum',
            exported,
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });
        }
        return;
      }

      case 'lexical_declaration': {
        for (const declarator of node.namedChildren) {
          if (declarator.type === 'variable_declarator') {
            const nameNode = declarator.childForFieldName('name');
            const value = declarator.childForFieldName('value');
            if (nameNode && value) {
              const isFunc = value.type === 'arrow_function' || value.type === 'function';
              symbols.push({
                name: nameNode.text,
                kind: isFunc ? 'function' : 'const',
                exported,
                lineStart: node.startPosition.row + 1,
                lineEnd: node.endPosition.row + 1,
                filePath,
              });

              if (isFunc) {
                const body = value.childForFieldName('body');
                if (body) extractCalls(body, nameNode.text, filePath, edges);
              }
            }
          }
        }
        return;
      }
    }

    // Default: recurse into children
    for (const child of node.namedChildren) {
      visit(child, exported);
    }
  }

  visit(root, false);
  return { symbols, edges };
}

// ---- Heritage extraction (extends / implements) -----------------------------

function extractHeritage(
  classNode: SyntaxNodeLike,
  className: string,
  filePath: string,
  edges: RawEdge[],
): void {
  for (const child of classNode.namedChildren) {
    if (child.type === 'class_heritage') {
      for (const clause of child.namedChildren) {
        if (clause.type === 'extends_clause') {
          const baseClass = clause.namedChildren[0];
          if (baseClass) {
            edges.push({
              sourceSymbolName: className,
              sourceFilePath: filePath,
              targetName: baseClass.text,
              edgeType: 'EXTENDS',
              lineNumber: clause.startPosition.row + 1,
            });
          }
        } else if (clause.type === 'implements_clause') {
          for (const iface of clause.namedChildren) {
            const ifaceName =
              iface.type === 'generic_type'
                ? (iface.childForFieldName('name')?.text ?? iface.text)
                : iface.text;
            edges.push({
              sourceSymbolName: className,
              sourceFilePath: filePath,
              targetName: ifaceName,
              edgeType: 'IMPLEMENTS',
              lineNumber: iface.startPosition.row + 1,
            });
          }
        }
      }
    }
  }
}

// ---- Call extraction --------------------------------------------------------

function extractCalls(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  if (node.type === 'call_expression') {
    const func = node.childForFieldName('function');
    if (func) {
      const calleeName = resolveCalleeName(func);
      if (calleeName && !BUILTIN_CALLS.has(calleeName)) {
        edges.push({
          sourceSymbolName: scopeName,
          sourceFilePath: filePath,
          targetName: calleeName,
          edgeType: 'CALLS',
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  } else if (node.type === 'new_expression') {
    const constructor = node.childForFieldName('constructor');
    if (constructor) {
      const calleeName = resolveCalleeName(constructor);
      if (calleeName) {
        edges.push({
          sourceSymbolName: scopeName,
          sourceFilePath: filePath,
          targetName: calleeName,
          edgeType: 'CALLS',
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }

  // Recurse — skip nested function/class definitions (they have their own scope)
  for (const child of node.namedChildren) {
    if (
      child.type !== 'function_declaration' &&
      child.type !== 'class_declaration' &&
      child.type !== 'arrow_function' &&
      child.type !== 'function'
    ) {
      extractCalls(child, scopeName, filePath, edges);
    }
  }
}

function resolveCalleeName(node: SyntaxNodeLike): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'member_expression') {
    const obj = node.childForFieldName('object');
    const prop = node.childForFieldName('property');
    if (obj && prop) {
      // this.method() or super.method() → just the method name
      if (obj.text === 'this' || obj.text === 'super') {
        return prop.text;
      }
      return `${obj.text}.${prop.text}`;
    }
  }
  return null;
}

const BUILTIN_CALLS = new Set([
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug',
  'console.trace', 'console.dir', 'console.table', 'console.time', 'console.timeEnd',
  'JSON.parse', 'JSON.stringify',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'Array.isArray', 'Array.from', 'Object.keys', 'Object.values', 'Object.entries',
  'Object.assign', 'Object.freeze', 'Object.create',
  'Promise.all', 'Promise.race', 'Promise.resolve', 'Promise.reject', 'Promise.allSettled',
  'Math.max', 'Math.min', 'Math.floor', 'Math.ceil', 'Math.round', 'Math.abs',
  'String', 'Number', 'Boolean', 'BigInt', 'Symbol',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'require', 'import',
]);

// ============================================================================
// AST EXTRACTION — PYTHON
// ============================================================================

function extractPython(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const edges: RawEdge[] = [];

  function visit(node: SyntaxNodeLike, scopeName: string | null): void {
    switch (node.type) {
      case 'function_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const funcName = scopeName ? `${scopeName}.${nameNode.text}` : nameNode.text;
          const isMethod = scopeName !== null;
          symbols.push({
            name: funcName,
            kind: isMethod ? 'method' : 'function',
            exported: !nameNode.text.startsWith('_'),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          if (isMethod && scopeName) {
            edges.push({
              sourceSymbolName: scopeName,
              sourceFilePath: filePath,
              targetName: funcName,
              edgeType: 'HAS_METHOD',
              lineNumber: node.startPosition.row + 1,
            });
          }

          const body = node.childForFieldName('body');
          if (body) extractCallsPython(body, funcName, filePath, edges);
        }
        return;
      }

      case 'class_definition': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const className = nameNode.text;
          symbols.push({
            name: className,
            kind: 'class',
            exported: !className.startsWith('_'),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          // Extract superclasses
          const superclasses = node.childForFieldName('superclasses');
          if (superclasses) {
            for (const arg of superclasses.namedChildren) {
              if (arg.type === 'identifier' || arg.type === 'attribute') {
                edges.push({
                  sourceSymbolName: className,
                  sourceFilePath: filePath,
                  targetName: arg.text,
                  edgeType: 'EXTENDS',
                  lineNumber: arg.startPosition.row + 1,
                });
              }
            }
          }

          // Process class body
          const body = node.childForFieldName('body');
          if (body) {
            for (const child of body.namedChildren) {
              visit(child, className);
            }
          }
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      visit(child, scopeName);
    }
  }

  visit(root, null);
  return { symbols, edges };
}

function extractCallsPython(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  if (node.type === 'call') {
    const func = node.childForFieldName('function');
    if (func) {
      let calleeName: string | null = null;
      if (func.type === 'identifier') {
        calleeName = func.text;
      } else if (func.type === 'attribute') {
        const obj = func.childForFieldName('object');
        const attr = func.childForFieldName('attribute');
        if (obj && attr) {
          calleeName = obj.text === 'self' || obj.text === 'cls'
            ? attr.text
            : `${obj.text}.${attr.text}`;
        }
      }

      if (calleeName && !PYTHON_BUILTINS.has(calleeName)) {
        edges.push({
          sourceSymbolName: scopeName,
          sourceFilePath: filePath,
          targetName: calleeName,
          edgeType: 'CALLS',
          lineNumber: node.startPosition.row + 1,
        });
      }
    }
  }

  for (const child of node.namedChildren) {
    if (child.type !== 'function_definition' && child.type !== 'class_definition') {
      extractCallsPython(child, scopeName, filePath, edges);
    }
  }
}

const PYTHON_BUILTINS = new Set([
  'print', 'len', 'range', 'enumerate', 'zip', 'map', 'filter', 'sorted',
  'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'bytes',
  'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'super', 'property', 'staticmethod', 'classmethod',
  'open', 'input', 'repr', 'id', 'hash', 'abs', 'max', 'min', 'sum',
  'any', 'all', 'next', 'iter', 'reversed', 'round',
]);

// ============================================================================
// AST EXTRACTION — GO
// ============================================================================

function extractGo(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const edges: RawEdge[] = [];

  function visit(node: SyntaxNodeLike): void {
    switch (node.type) {
      case 'function_declaration': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const funcName = nameNode.text;
          symbols.push({
            name: funcName,
            kind: 'function',
            exported: isGoExported(funcName),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          const body = node.childForFieldName('body');
          if (body) extractCallsGo(body, funcName, filePath, edges);
        }
        return;
      }

      case 'method_declaration': {
        const nameNode = node.childForFieldName('name');
        const receiverNode = node.childForFieldName('receiver');
        const receiverType = extractGoReceiverType(receiverNode);
        if (nameNode) {
          const fullName = receiverType ? `${receiverType}.${nameNode.text}` : nameNode.text;
          symbols.push({
            name: fullName,
            kind: 'method',
            exported: isGoExported(nameNode.text),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          if (receiverType) {
            edges.push({
              sourceSymbolName: receiverType,
              sourceFilePath: filePath,
              targetName: fullName,
              edgeType: 'HAS_METHOD',
              lineNumber: node.startPosition.row + 1,
            });
          }

          const body = node.childForFieldName('body');
          if (body) extractCallsGo(body, fullName, filePath, edges);
        }
        return;
      }

      case 'type_declaration': {
        for (const child of node.namedChildren) {
          if (child.type === 'type_spec' || child.type === 'type_alias') {
            const nameNode = child.childForFieldName('name');
            if (!nameNode) continue;
            const typeNode = child.childForFieldName('type');
            const kind =
              typeNode?.type === 'struct_type'
                ? 'struct'
                : typeNode?.type === 'interface_type'
                  ? 'interface'
                  : 'type';

            symbols.push({
              name: nameNode.text,
              kind,
              exported: isGoExported(nameNode.text),
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
              filePath,
            });
          }
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return { symbols, edges };
}

function extractGoReceiverType(receiverNode: SyntaxNodeLike | null): string | null {
  if (!receiverNode) return null;
  for (const child of receiverNode.namedChildren) {
    const typeNode = child.childForFieldName('type');
    if (typeNode) {
      return normalizeTypeName(typeNode.text);
    }
  }
  return null;
}

function extractCallsGo(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  if (node.type === 'call_expression') {
    const func = node.childForFieldName('function');
    const calleeName = func ? resolveGoCalleeName(func) : null;
    if (calleeName) {
      edges.push({
        sourceSymbolName: scopeName,
        sourceFilePath: filePath,
        targetName: calleeName,
        edgeType: 'CALLS',
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  for (const child of node.namedChildren) {
    if (
      child.type !== 'function_declaration' &&
      child.type !== 'method_declaration' &&
      child.type !== 'type_declaration'
    ) {
      extractCallsGo(child, scopeName, filePath, edges);
    }
  }
}

function resolveGoCalleeName(node: SyntaxNodeLike): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'selector_expression') {
    const field = node.childForFieldName('field');
    return field?.text ?? null;
  }
  return null;
}

function isGoExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ============================================================================
// AST EXTRACTION — RUST
// ============================================================================

function extractRust(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const edges: RawEdge[] = [];

  function visit(node: SyntaxNodeLike): void {
    switch (node.type) {
      case 'function_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const funcName = nameNode.text;
          symbols.push({
            name: funcName,
            kind: 'function',
            exported: hasVisibilityModifier(node),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });

          const body = node.childForFieldName('body');
          if (body) extractCallsRust(body, funcName, filePath, edges);
        }
        return;
      }

      case 'struct_item':
      case 'enum_item':
      case 'trait_item': {
        const nameNode = node.childForFieldName('name');
        if (nameNode) {
          const kind = node.type === 'struct_item' ? 'struct' : node.type === 'enum_item' ? 'enum' : 'trait';
          symbols.push({
            name: nameNode.text,
            kind,
            exported: hasVisibilityModifier(node),
            lineStart: node.startPosition.row + 1,
            lineEnd: node.endPosition.row + 1,
            filePath,
          });
        }
        return;
      }

      case 'impl_item': {
        const typeNode = node.childForFieldName('type');
        const ownerName = typeNode ? normalizeTypeName(typeNode.text) : null;
        const traitNode = node.childForFieldName('trait');
        const traitName = traitNode ? normalizeTypeName(traitNode.text) : null;
        if (ownerName && traitName) {
          edges.push({
            sourceSymbolName: ownerName,
            sourceFilePath: filePath,
            targetName: traitName,
            edgeType: 'IMPLEMENTS',
            lineNumber: node.startPosition.row + 1,
          });
        }

        const body = node.childForFieldName('body');
        if (body && ownerName) {
          for (const child of body.namedChildren) {
            if (child.type !== 'function_item') continue;
            const nameNode = child.childForFieldName('name');
            if (!nameNode) continue;

            const fullName = `${ownerName}.${nameNode.text}`;
            symbols.push({
              name: fullName,
              kind: 'method',
              exported: hasVisibilityModifier(child),
              lineStart: child.startPosition.row + 1,
              lineEnd: child.endPosition.row + 1,
              filePath,
            });

            edges.push({
              sourceSymbolName: ownerName,
              sourceFilePath: filePath,
              targetName: fullName,
              edgeType: 'HAS_METHOD',
              lineNumber: child.startPosition.row + 1,
            });

            const methodBody = child.childForFieldName('body');
            if (methodBody) extractCallsRust(methodBody, fullName, filePath, edges);
          }
        }
        return;
      }
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return { symbols, edges };
}

function extractCallsRust(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  if (node.type === 'call_expression') {
    const func = node.childForFieldName('function');
    const calleeName = func ? resolveRustCalleeName(func) : null;
    if (calleeName) {
      edges.push({
        sourceSymbolName: scopeName,
        sourceFilePath: filePath,
        targetName: calleeName,
        edgeType: 'CALLS',
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  for (const child of node.namedChildren) {
    if (
      child.type !== 'function_item' &&
      child.type !== 'struct_item' &&
      child.type !== 'enum_item' &&
      child.type !== 'trait_item' &&
      child.type !== 'impl_item'
    ) {
      extractCallsRust(child, scopeName, filePath, edges);
    }
  }
}

function resolveRustCalleeName(node: SyntaxNodeLike): string | null {
  if (node.type === 'identifier') {
    return node.text;
  }
  if (node.type === 'field_expression') {
    const field = node.childForFieldName('field');
    return field?.text ?? null;
  }
  if (node.type === 'scoped_identifier' || node.type === 'scoped_type_identifier') {
    const nameNode = node.childForFieldName('name');
    return nameNode?.text ?? normalizeTypeName(node.text);
  }
  if (node.type === 'generic_function') {
    const func = node.childForFieldName('function');
    return func ? resolveRustCalleeName(func) : null;
  }
  return null;
}

// ============================================================================
// AST EXTRACTION — JAVA
// ============================================================================

function extractJava(root: SyntaxNodeLike, filePath: string): ExtractionResult {
  const symbols: ExtractedSymbol[] = [];
  const edges: RawEdge[] = [];

  function visit(node: SyntaxNodeLike): void {
    if (extractJavaTypeDeclaration(node, filePath, symbols, edges)) {
        return;
    }

    for (const child of node.namedChildren) {
      visit(child);
    }
  }

  visit(root);
  return { symbols, edges };
}

function extractJavaTypeDeclaration(
  node: SyntaxNodeLike,
  filePath: string,
  symbols: ExtractedSymbol[],
  edges: RawEdge[],
): boolean {
  switch (node.type) {
    case 'class_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const className = nameNode.text;
        symbols.push({
          name: className,
          kind: 'class',
          exported: hasJavaPublicModifier(node),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          filePath,
        });

        extractJavaHeritage(node, className, filePath, edges);
        const body = node.childForFieldName('body');
        if (body) extractJavaBodyMembers(body, className, filePath, symbols, edges);
      }
      return true;
    }

    case 'interface_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const interfaceName = nameNode.text;
        symbols.push({
          name: interfaceName,
          kind: 'interface',
          exported: hasJavaPublicModifier(node),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          filePath,
        });

        const extendsNode = node.childForFieldName('extends_interfaces');
        if (extendsNode) {
          for (const target of collectJavaTypeNames(extendsNode)) {
            edges.push({
              sourceSymbolName: interfaceName,
              sourceFilePath: filePath,
              targetName: target,
              edgeType: 'EXTENDS',
              lineNumber: extendsNode.startPosition.row + 1,
            });
          }
        }

        const body = node.childForFieldName('body');
        if (body) extractJavaBodyMembers(body, interfaceName, filePath, symbols, edges);
      }
      return true;
    }

    case 'enum_declaration': {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const enumName = nameNode.text;
        symbols.push({
          name: enumName,
          kind: 'enum',
          exported: hasJavaPublicModifier(node),
          lineStart: node.startPosition.row + 1,
          lineEnd: node.endPosition.row + 1,
          filePath,
        });

        const interfacesNode = node.childForFieldName('interfaces');
        if (interfacesNode) {
          for (const target of collectJavaTypeNames(interfacesNode)) {
            edges.push({
              sourceSymbolName: enumName,
              sourceFilePath: filePath,
              targetName: target,
              edgeType: 'IMPLEMENTS',
              lineNumber: interfacesNode.startPosition.row + 1,
            });
          }
        }

        const body = node.childForFieldName('body');
        if (body) extractJavaBodyMembers(body, enumName, filePath, symbols, edges);
      }
      return true;
    }

    default:
      return false;
  }
}

function extractJavaHeritage(
  node: SyntaxNodeLike,
  ownerName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  const superclassNode = node.childForFieldName('superclass');
  if (superclassNode) {
    for (const target of collectJavaTypeNames(superclassNode)) {
      edges.push({
        sourceSymbolName: ownerName,
        sourceFilePath: filePath,
        targetName: target,
        edgeType: 'EXTENDS',
        lineNumber: superclassNode.startPosition.row + 1,
      });
    }
  }

  const interfacesNode = node.childForFieldName('interfaces');
  if (interfacesNode) {
    for (const target of collectJavaTypeNames(interfacesNode)) {
      edges.push({
        sourceSymbolName: ownerName,
        sourceFilePath: filePath,
        targetName: target,
        edgeType: 'IMPLEMENTS',
        lineNumber: interfacesNode.startPosition.row + 1,
      });
    }
  }
}

function extractJavaBodyMembers(
  body: SyntaxNodeLike,
  ownerName: string,
  filePath: string,
  symbols: ExtractedSymbol[],
  edges: RawEdge[],
): void {
  if (body.type === 'method_declaration') {
    const nameNode = body.childForFieldName('name');
    if (!nameNode) return;
    const fullName = `${ownerName}.${nameNode.text}`;
    symbols.push({
      name: fullName,
      kind: 'method',
      exported: hasJavaPublicModifier(body),
      lineStart: body.startPosition.row + 1,
      lineEnd: body.endPosition.row + 1,
      filePath,
    });

    edges.push({
      sourceSymbolName: ownerName,
      sourceFilePath: filePath,
      targetName: fullName,
      edgeType: 'HAS_METHOD',
      lineNumber: body.startPosition.row + 1,
    });

    const methodBody = body.childForFieldName('body');
    if (methodBody) extractCallsJava(methodBody, fullName, filePath, edges);
    return;
  }

  for (const child of body.namedChildren) {
    if (extractJavaTypeDeclaration(child, filePath, symbols, edges)) {
      continue;
    }
    extractJavaBodyMembers(child, ownerName, filePath, symbols, edges);
  }
}

function extractCallsJava(
  node: SyntaxNodeLike,
  scopeName: string,
  filePath: string,
  edges: RawEdge[],
): void {
  if (node.type === 'method_invocation') {
    const nameNode = node.childForFieldName('name');
    const objectNode = node.childForFieldName('object');
    const calleeName = nameNode
      ? objectNode && objectNode.text !== 'this' && objectNode.text !== 'super'
        ? `${objectNode.text}.${nameNode.text}`
        : nameNode.text
      : null;
    if (calleeName) {
      edges.push({
        sourceSymbolName: scopeName,
        sourceFilePath: filePath,
        targetName: calleeName,
        edgeType: 'CALLS',
        lineNumber: node.startPosition.row + 1,
      });
    }
  } else if (node.type === 'object_creation_expression') {
    const typeNode = node.childForFieldName('type');
    const calleeName = typeNode ? normalizeTypeName(typeNode.text) : null;
    if (calleeName) {
      edges.push({
        sourceSymbolName: scopeName,
        sourceFilePath: filePath,
        targetName: calleeName,
        edgeType: 'CALLS',
        lineNumber: node.startPosition.row + 1,
      });
    }
  }

  for (const child of node.namedChildren) {
    if (
      child.type !== 'class_declaration' &&
      child.type !== 'interface_declaration' &&
      child.type !== 'enum_declaration' &&
      child.type !== 'method_declaration'
    ) {
      extractCallsJava(child, scopeName, filePath, edges);
    }
  }
}

function collectJavaTypeNames(node: SyntaxNodeLike): string[] {
  const names = new Set<string>();

  function visit(current: SyntaxNodeLike): void {
    if (JAVA_TYPE_NODE_TYPES.has(current.type)) {
      const normalized = normalizeTypeName(current.text);
      if (normalized) names.add(normalized);
    }
    for (const child of current.namedChildren) {
      visit(child);
    }
  }

  visit(node);
  return Array.from(names);
}

const JAVA_TYPE_NODE_TYPES = new Set([
  'type_identifier',
  'generic_type',
  'scoped_type_identifier',
]);

function hasJavaPublicModifier(node: SyntaxNodeLike): boolean {
  return node.namedChildren.some((child) => child.type === 'modifiers' && /\bpublic\b/.test(child.text));
}

// ============================================================================
// AST EXTRACTION — SHARED HELPERS
// ============================================================================

function hasVisibilityModifier(node: SyntaxNodeLike): boolean {
  return node.namedChildren.some((child) => child.type === 'visibility_modifier');
}

function normalizeTypeName(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*&(?:mut\s+)?/, '')
    .replace(/^\s*\*/, '')
    .replace(/\bconst\b/g, '')
    .replace(/\bmut\b/g, '')
    .trim()
    .split(/::|\./)
    .pop()
    ?.replace(/[^\w$]/g, '') ?? text.trim();
}

// ============================================================================
// CROSS-FILE RESOLUTION
// ============================================================================

function buildGlobalSymbolTable(
  allSymbols: Map<string, ExtractedSymbol[]>,
): GlobalSymbolTable {
  const table: GlobalSymbolTable = new Map();

  for (const symbols of allSymbols.values()) {
    for (const sym of symbols) {
      // Store under base name for unqualified lookups (e.g. "doFoo")
      const baseName = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
      if (!table.has(baseName)) table.set(baseName, []);
      table.get(baseName)!.push({ name: sym.name, filePath: sym.filePath, kind: sym.kind, exported: sym.exported });

      // Also store under full name for qualified lookups (e.g. "MyClass.doFoo")
      if (sym.name !== baseName) {
        if (!table.has(sym.name)) table.set(sym.name, []);
        table.get(sym.name)!.push({ name: sym.name, filePath: sym.filePath, kind: sym.kind, exported: sym.exported });
      }
    }
  }

  return table;
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
      map.set(file.filePath, new Set(rows.map((r) => r.target_file)));
    }
  }

  return map;
}

function resolveEdges(
  rawEdges: RawEdge[],
  globalSymbolTable: GlobalSymbolTable,
  importMap: Map<string, Set<string>>,
): AstReferenceInput[] {
  const resolved: AstReferenceInput[] = [];
  const seen = new Set<string>();

  for (const edge of rawEdges) {
    // HAS_METHOD: always same-file, always resolvable
    if (edge.edgeType === 'HAS_METHOD') {
      const key = `${edge.sourceFilePath}|${edge.sourceSymbolName}|${edge.targetName}|HAS_METHOD`;
      if (!seen.has(key)) {
        seen.add(key);
        resolved.push({
          sourceFile: edge.sourceFilePath,
          targetFile: edge.sourceFilePath,
          sourceSymbolName: edge.sourceSymbolName,
          targetSymbolName: edge.targetName,
          edgeType: 'HAS_METHOD',
          confidence: 1.0,
        });
      }
      continue;
    }

    // Resolve target name
    const baseName = edge.targetName.includes('.')
      ? edge.targetName.split('.').pop()!
      : edge.targetName;

    const candidates =
      globalSymbolTable.get(edge.targetName) ?? globalSymbolTable.get(baseName) ?? [];

    if (candidates.length === 0) continue;

    // Priority 1: Same file
    const sameFile = candidates.find((c) => c.filePath === edge.sourceFilePath);
    if (sameFile) {
      addResolved(edge, sameFile.filePath, sameFile.name, 1.0);
      continue;
    }

    // Priority 2: Imported file
    const imports = importMap.get(edge.sourceFilePath);
    if (imports) {
      const importedCandidate = candidates.find((c) => imports.has(c.filePath));
      if (importedCandidate) {
        addResolved(edge, importedCandidate.filePath, importedCandidate.name, 0.9);
        continue;
      }
    }

    // Priority 3: Unique exported match
    const exportedCandidates = candidates.filter((c) => c.exported);
    if (exportedCandidates.length === 1) {
      addResolved(edge, exportedCandidates[0]!.filePath, exportedCandidates[0]!.name, 0.7);
    }
    // Ambiguous: skip to avoid noise
  }

  return resolved;

  function addResolved(edge: RawEdge, targetFile: string, resolvedTargetName: string, confidence: number): void {
    const key = `${edge.sourceFilePath}|${edge.sourceSymbolName}|${targetFile}|${resolvedTargetName}|${edge.edgeType}`;
    if (seen.has(key)) return;
    seen.add(key);
    resolved.push({
      sourceFile: edge.sourceFilePath,
      targetFile,
      sourceSymbolName: edge.sourceSymbolName,
      targetSymbolName: resolvedTargetName,
      edgeType: edge.edgeType,
      confidence,
    });
  }
}

// ============================================================================
// DB PERSISTENCE
// ============================================================================

/**
 * Write AST-sourced references to the references table.
 * Deletes provenance='ast' rows for ALL processed files (not just those with new edges),
 * so stale AST rows are cleaned even when a file resolves to zero edges.
 * LLM-sourced (crossref) references are preserved.
 */
function upsertAstReferences(
  db: AtlasDatabase,
  workspace: string,
  references: AstReferenceInput[],
  processedFiles: string[],
): void {
  // Group new edges by source file
  const bySourceFile = new Map<string, AstReferenceInput[]>();
  for (const ref of references) {
    if (!bySourceFile.has(ref.sourceFile)) bySourceFile.set(ref.sourceFile, []);
    bySourceFile.get(ref.sourceFile)!.push(ref);
  }

  const deleteStmt = db.prepare(
    `DELETE FROM "references" WHERE workspace = ? AND source_file = ? AND provenance = 'ast'`,
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
    // Delete stale AST rows for ALL processed files — even those with zero new edges
    for (const filePath of processedFiles) {
      deleteStmt.run(workspace, filePath);
    }

    // Insert new edges
    for (const [, refs] of bySourceFile) {
      for (const ref of refs) {
        const srcRow = getSymbolIdStmt.get(workspace, ref.sourceFile, ref.sourceSymbolName) as
          | { id: number }
          | undefined;
        const tgtRow = getSymbolIdStmt.get(workspace, ref.targetFile, ref.targetSymbolName) as
          | { id: number }
          | undefined;

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
