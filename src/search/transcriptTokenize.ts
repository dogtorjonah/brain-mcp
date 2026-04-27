/**
 * Identifier-aware tokenizer helpers for FTS5 queries.
 *
 * Transcript search is a mix of natural language ("what did we decide about
 * the embedder?") and literal strings (file paths, tool names, error tokens
 * like "ENOENT", identifier fragments like `runRebirth`). A plain lowercase
 * split would miss camelCase boundaries and paths; a symbol-only tokenizer
 * would strip the natural-language signal.
 *
 * The strategy (mirrored from our internal RAG stack): split camelCase +
 * acronym-boundary, normalise `_`/`-` to spaces, lowercase, drop short
 * stopwords, and emit an OR-joined query so FTS5 returns rows matching ANY
 * of the tokens rather than ALL (BM25 scoring handles the relevance ordering
 * — overly strict AND semantics kills recall on conversational queries).
 */

const FTS_STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'of', 'for', 'to', 'in', 'on',
  'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'must', 'can', 'cant',
  'wont', 'dont', 'isnt', 'arent', 'wasnt', 'werent', 'hasnt', 'hadnt',
  'doesnt', 'didnt', 'wouldnt', 'couldnt', 'shouldnt', 'i', 'me', 'my',
  'we', 'us', 'our', 'you', 'your', 'he', 'she', 'it', 'they', 'them',
  'this', 'that', 'these', 'those', 'there', 'here', 'what', 'which',
  'who', 'whom', 'whose', 'when', 'where', 'why', 'how', 'all', 'any',
  'some', 'no', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
]);

/**
 * Split camelCase + acronym boundaries, normalise _/- to spaces, collapse
 * whitespace. Does NOT lowercase (callers decide — FTS5 tokenizer
 * lowercases via `unicode61`, but our stopword filter matches lowercase).
 */
export function normalizeSearchText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // camelCase → "camel Case"
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // ACRONYMAcronym → "ACRONYM Acronym"
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Prepare a raw user query for FTS5 MATCH. Returns '' if nothing useful
 * remains after stopword/length filtering — caller should skip the BM25
 * path entirely in that case.
 */
export function prepareFtsQuery(raw: string): string {
  const normalized = normalizeSearchText(raw);
  // Drop FTS5-reserved punctuation so we never emit a malformed MATCH expr.
  const cleaned = normalized.replace(/[?!@#$%^&*(){}[\]<>:;"'`,.|\\~/+=]/g, ' ');
  const tokens = cleaned
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1 && !FTS_STOPWORDS.has(t));
  if (tokens.length === 0) return '';
  // OR-semantics: recall-first, BM25 ranks by token overlap density.
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
