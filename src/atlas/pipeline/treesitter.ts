/**
 * Tree-sitter Parser Management
 *
 * Lazy-loads native tree-sitter parsers for supported languages.
 * Uses createRequire for CJS/ESM interop since tree-sitter ships CommonJS.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

const _require = createRequire(import.meta.url);

// ============================================================================
// LANGUAGE SUPPORT
// ============================================================================

export type SupportedAstLanguage =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java';

const EXTENSION_MAP: Record<string, SupportedAstLanguage> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
};

/** Detect AST-parseable language from file extension. Returns null for unsupported. */
export function detectAstLanguage(filePath: string): SupportedAstLanguage | null {
  const ext = path.extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? null;
}

// ============================================================================
// TREE-SITTER TYPE INTERFACES
// ============================================================================

/** Minimal tree-sitter Parser interface (avoids coupling to CJS types) */
interface ParserLike {
  setLanguage(lang: unknown): void;
  parse(source: string): TreeLike;
}

export interface TreeLike {
  rootNode: SyntaxNodeLike;
}

export interface SyntaxNodeLike {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  childCount: number;
  children: SyntaxNodeLike[];
  namedChildren: SyntaxNodeLike[];
  childForFieldName(name: string): SyntaxNodeLike | null;
  parent: SyntaxNodeLike | null;
}

// ============================================================================
// PARSER POOL (lazy, per-language singletons)
// ============================================================================

let _ParserClass: (new () => ParserLike) | null = null;
const _grammars = new Map<string, unknown>();
const _parsers = new Map<string, ParserLike>();

function getParserClass(): new () => ParserLike {
  if (!_ParserClass) {
    _ParserClass = _require('tree-sitter') as new () => ParserLike;
  }
  return _ParserClass;
}

function loadGrammar(lang: SupportedAstLanguage): unknown {
  if (_grammars.has(lang)) return _grammars.get(lang)!;

  let grammar: unknown;
  switch (lang) {
    case 'typescript':
      grammar = _require('tree-sitter-typescript').typescript;
      break;
    case 'tsx':
      grammar = _require('tree-sitter-typescript').tsx;
      break;
    case 'javascript':
      grammar = _require('tree-sitter-javascript');
      break;
    case 'python':
      grammar = _require('tree-sitter-python');
      break;
    case 'go':
      grammar = _require('tree-sitter-go');
      break;
    case 'rust':
      grammar = _require('tree-sitter-rust');
      break;
    case 'java':
      grammar = _require('tree-sitter-java');
      break;
    default:
      throw new Error(`Unsupported AST language: ${lang}`);
  }

  _grammars.set(lang, grammar);
  return grammar;
}

/** Get or create a parser for the given language. Parsers are pooled. */
function getParser(lang: SupportedAstLanguage): ParserLike {
  if (_parsers.has(lang)) return _parsers.get(lang)!;

  const Parser = getParserClass();
  const parser = new Parser();
  parser.setLanguage(loadGrammar(lang));
  _parsers.set(lang, parser);
  return parser;
}

// ============================================================================
// PUBLIC API
// ============================================================================

/** Parse source code into a syntax tree. */
export function parseSource(source: string, language: SupportedAstLanguage): TreeLike {
  const parser = getParser(language);
  return parser.parse(source);
}

/** Check if tree-sitter native bindings are available. */
export function isTreeSitterAvailable(): boolean {
  try {
    _require('tree-sitter');
    return true;
  } catch {
    return false;
  }
}
