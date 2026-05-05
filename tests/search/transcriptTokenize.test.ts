import { describe, it, expect } from 'vitest';
import { normalizeSearchText, prepareFtsQuery } from '../../src/search/transcriptTokenize.js';

describe('transcriptTokenize: normalizeSearchText', () => {
  it('helloWorld → "hello World"', () => {
    expect(normalizeSearchText('helloWorld')).toBe('hello World');
  });

  it('getHTTPResponse → "get HTTP Response" (acronym boundary)', () => {
    expect(normalizeSearchText('getHTTPResponse')).toBe('get HTTP Response');
  });

  it('snake_case-var → "snake case var"', () => {
    expect(normalizeSearchText('snake_case-var')).toBe('snake case var');
  });

  it('already spaced text → unchanged', () => {
    expect(normalizeSearchText('already spaced text')).toBe('already spaced text');
  });

  it('ABC (all caps) → "ABC" (no split)', () => {
    expect(normalizeSearchText('ABC')).toBe('ABC');
  });

  it('ABCxyz → "AB Cxyz" (acronym-then-lowercase)', () => {
    expect(normalizeSearchText('ABCxyz')).toBe('AB Cxyz');
  });

  it('multiple underscores → single space', () => {
    expect(normalizeSearchText('foo__bar')).toBe('foo bar');
  });

  it('mixed camelCase and snake_case', () => {
    expect(normalizeSearchText('myFunc_name_here')).toBe('my Func name here');
  });
});

describe('transcriptTokenize: prepareFtsQuery', () => {
  it('simple query → OR-joined quoted tokens', () => {
    const result = prepareFtsQuery('hello world');
    expect(result).toBe('"hello" OR "world"');
  });

  it('drops stopwords', () => {
    const result = prepareFtsQuery('the quick brown fox');
    // "the" is a stopword, "quick", "brown", "fox" remain
    expect(result).not.toContain('"the"');
    expect(result).toContain('"quick"');
    expect(result).toContain('"brown"');
    expect(result).toContain('"fox"');
  });

  it('drops single-char tokens', () => {
    const result = prepareFtsQuery('a b cd');
    expect(result).toBe('"cd"');
  });

  it('strips punctuation', () => {
    const result = prepareFtsQuery('find auth@middleware');
    expect(result).toContain('"find"');
    expect(result).toContain('"middleware"');
    expect(result).not.toContain('@');
  });

  it('empty/stopword-only query → empty string', () => {
    expect(prepareFtsQuery('the an is')).toBe('');
  });

  it('camelCase query split before lowercasing', () => {
    const result = prepareFtsQuery('brainSearch');
    // normalizeSearchText splits → "brain Search"
    // then lowercased → "brain" OR "search"
    expect(result).toContain('"brain"');
    expect(result).toContain('"search"');
  });

  it('mixed punctuation and camelCase → clean OR-joined output', () => {
    const result = prepareFtsQuery('getHTTPResponse_from:auth@service');
    // normalizeSearchText splits camelCase/acronyms → "get HTTP Response from auth service"
    // punctuation (:, @) stripped → "from" is a stopword and dropped
    // final tokens: get, http, response, auth, service
    expect(result).toContain('"get"');
    expect(result).toContain('"http"');
    expect(result).toContain('"response"');
    expect(result).toContain('"auth"');
    expect(result).toContain('"service"');
    expect(result).not.toContain(':');
    expect(result).not.toContain('@');
    expect(result).not.toContain('_');
    // 'from' is an FTS stopword — should be absent
    expect(result).not.toContain('"from"');
  });
});
