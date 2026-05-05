import { describe, it, expect } from 'vitest';
import { resolveScope, applySiloFilter, type BrainSearchScope } from '../../src/search/scopeResolver.js';

describe('scopeResolver: resolveScope all 7 scopes', () => {
  it('self → identity-filtered transcripts only', () => {
    const config = resolveScope('self');
    expect(config.silos).toEqual(['transcripts']);
    expect(config.filterByIdentity).toBe(true);
    expect(config.filterBySession).toBe(false);
    expect(config.filterByProject).toBe(false);
    expect(config.includeAtlas).toBe(false);
  });

  it('session → session-filtered transcripts only', () => {
    const config = resolveScope('session');
    expect(config.silos).toEqual(['transcripts']);
    expect(config.filterByIdentity).toBe(false);
    expect(config.filterBySession).toBe(true);
    expect(config.filterByProject).toBe(false);
    expect(config.includeAtlas).toBe(false);
  });

  it('workspace → 4 silos + project filter + atlas', () => {
    const config = resolveScope('workspace');
    expect(config.silos).toHaveLength(4);
    expect(config.silos).toContain('transcripts');
    expect(config.silos).toContain('atlas_files');
    expect(config.silos).toContain('atlas_changelog');
    expect(config.silos).toContain('source_highlights');
    expect(config.filterByProject).toBe(true);
    expect(config.includeAtlas).toBe(true);
    expect(config.filterByIdentity).toBe(false);
    expect(config.filterBySession).toBe(false);
  });

  it('identity → 4 silos + identity filter + atlas', () => {
    const config = resolveScope('identity');
    expect(config.silos).toHaveLength(4);
    expect(config.filterByIdentity).toBe(true);
    expect(config.includeAtlas).toBe(true);
    expect(config.filterByProject).toBe(false);
  });

  it('atlas → no transcripts, 3 atlas silos only', () => {
    const config = resolveScope('atlas');
    expect(config.silos).toHaveLength(3);
    expect(config.silos).not.toContain('transcripts');
    expect(config.silos).toContain('atlas_files');
    expect(config.silos).toContain('atlas_changelog');
    expect(config.silos).toContain('source_highlights');
    expect(config.includeAtlas).toBe(true);
  });

  it('transcripts → transcripts only, no filters', () => {
    const config = resolveScope('transcripts');
    expect(config.silos).toEqual(['transcripts']);
    expect(config.filterByIdentity).toBe(false);
    expect(config.filterBySession).toBe(false);
    expect(config.filterByProject).toBe(false);
    expect(config.includeAtlas).toBe(false);
  });

  it('all → 4 silos, no filters, atlas included', () => {
    const config = resolveScope('all');
    expect(config.silos).toHaveLength(4);
    expect(config.filterByIdentity).toBe(false);
    expect(config.filterBySession).toBe(false);
    expect(config.filterByProject).toBe(false);
    expect(config.includeAtlas).toBe(true);
  });

  it('all 7 scopes return distinct configs', () => {
    const scopes: BrainSearchScope[] = ['self', 'session', 'workspace', 'identity', 'atlas', 'transcripts', 'all'];
    const configs = scopes.map(s => JSON.stringify(resolveScope(s)));
    const unique = new Set(configs);
    expect(unique.size).toBe(7);
  });
});

describe('scopeResolver: applySiloFilter', () => {
  it('filters available silos to requested subset', () => {
    const available = ['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights'];
    const requested = ['atlas_files', 'source_highlights'];
    const result = applySiloFilter(available, requested);
    expect(result).toEqual(['atlas_files', 'source_highlights']);
  });

  it('returns empty if no requested silos match', () => {
    const result = applySiloFilter(['transcripts'], ['atlas_files']);
    expect(result).toEqual([]);
  });

  it('returns all available if all requested', () => {
    const available = ['transcripts', 'atlas_files'];
    const result = applySiloFilter(available, ['transcripts', 'atlas_files']);
    expect(result).toEqual(['transcripts', 'atlas_files']);
  });

  it('returns empty if requested is empty', () => {
    const available = ['transcripts', 'atlas_files'];
    const result = applySiloFilter(available, []);
    expect(result).toEqual([]);
  });

  it('returns only available silos when requested is superset', () => {
    const available = ['transcripts', 'atlas_files'];
    const result = applySiloFilter(available, ['transcripts', 'atlas_files', 'atlas_changelog', 'source_highlights']);
    expect(result).toEqual(['transcripts', 'atlas_files']);
  });
});
