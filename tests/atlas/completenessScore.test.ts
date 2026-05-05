import { describe, it, expect } from 'vitest';
import { tierForLoc, computeCompleteness, requirementsForTier } from '../../src/atlas/completenessScore.js';

describe('completenessScore: tierForLoc', () => {
  it('0 loc → small (fallback)', () => {
    expect(tierForLoc(0)).toBe('small');
  });

  it('1 loc → tiny', () => {
    expect(tierForLoc(1)).toBe('tiny');
  });

  it('50 loc → tiny (boundary)', () => {
    expect(tierForLoc(50)).toBe('tiny');
  });

  it('51 loc → small (boundary)', () => {
    expect(tierForLoc(51)).toBe('small');
  });

  it('200 loc → small (boundary)', () => {
    expect(tierForLoc(200)).toBe('small');
  });

  it('201 loc → medium (boundary)', () => {
    expect(tierForLoc(201)).toBe('medium');
  });

  it('600 loc → medium (boundary)', () => {
    expect(tierForLoc(600)).toBe('medium');
  });

  it('601 loc → large (boundary)', () => {
    expect(tierForLoc(601)).toBe('large');
  });

  it('1500 loc → large (boundary)', () => {
    expect(tierForLoc(1500)).toBe('large');
  });

  it('1501 loc → huge (boundary)', () => {
    expect(tierForLoc(1501)).toBe('huge');
  });

  it('NaN → small (fallback)', () => {
    expect(tierForLoc(NaN)).toBe('small');
  });

  it('Infinity → small (fallback, not finite)', () => {
    expect(tierForLoc(Infinity)).toBe('small');
  });

  it('-1 → small (fallback)', () => {
    expect(tierForLoc(-1)).toBe('small');
  });
});

describe('completenessScore: computeCompleteness', () => {
  const ALL = new Set(['purpose', 'blurb', 'patterns', 'hazards', 'conventions', 'key_types', 'data_flows', 'public_api', 'source_highlights']);

  it('all 9 fields filled, LOC=100 → requiredFillRate=1.0, overallFillRate=1.0', () => {
    const score = computeCompleteness(100, ALL);
    expect(score.tier).toBe('small');
    expect(score.requiredFillRate).toBe(1.0);
    expect(score.overallFillRate).toBe(1.0);
    expect(score.missingRequired).toEqual([]);
    expect(score.filled).toHaveLength(9);
  });

  it('no fields filled, LOC=100 → requiredFillRate=0.0, overallFillRate=0.0', () => {
    const score = computeCompleteness(100, new Set());
    expect(score.requiredFillRate).toBe(0.0);
    expect(score.overallFillRate).toBe(0.0);
    expect(score.missingRequired).toEqual(['blurb', 'purpose']);
    expect(score.filled).toEqual([]);
  });

  it('blurb+purpose filled (exact required for small), LOC=100 → requiredFillRate=1.0', () => {
    const score = computeCompleteness(100, new Set(['blurb', 'purpose']));
    expect(score.tier).toBe('small');
    expect(score.requiredFillRate).toBe(1.0);
    expect(score.overallFillRate).toBeCloseTo(2 / 9);
    expect(score.missingRequired).toEqual([]);
  });

  it('tiny file with only blurb → requiredFillRate=1.0', () => {
    const score = computeCompleteness(30, new Set(['blurb']));
    expect(score.tier).toBe('tiny');
    expect(score.requiredFillRate).toBe(1.0);
    expect(score.missingRequired).toEqual([]);
  });

  it('huge file missing source_highlights → requiredFillRate=5/6', () => {
    // huge required: blurb, purpose, hazards, patterns, source_highlights, key_types
    // filled all except source_highlights
    const filled = new Set(['blurb', 'purpose', 'hazards', 'patterns', 'key_types']);
    const score = computeCompleteness(2000, filled);
    expect(score.tier).toBe('huge');
    expect(score.requiredFillRate).toBeCloseTo(5 / 6);
    expect(score.missingRequired).toEqual(['source_highlights']);
  });

  it('LOC=0 or negative → rounded to 0, tier=small', () => {
    const score0 = computeCompleteness(0, new Set(['blurb']));
    expect(score0.loc).toBe(0);
    expect(score0.tier).toBe('small');

    const scoreNeg = computeCompleteness(-50, new Set(['blurb']));
    expect(scoreNeg.loc).toBe(0);
    expect(scoreNeg.tier).toBe('small');
  });
});

describe('completenessScore: requirementsForTier', () => {
  it('tiny requires only blurb', () => {
    const req = requirementsForTier('tiny');
    expect(req.required).toEqual(['blurb']);
    expect(req.recommended).toContain('purpose');
  });

  it('huge requires 6 fields', () => {
    const req = requirementsForTier('huge');
    expect(req.required).toHaveLength(6);
    expect(req.required).toEqual(['blurb', 'purpose', 'hazards', 'patterns', 'source_highlights', 'key_types']);
  });

  it('medium requires blurb, purpose, hazards', () => {
    const req = requirementsForTier('medium');
    expect(req.required).toEqual(['blurb', 'purpose', 'hazards']);
  });

  it('every tier returns non-empty required, recommended, rationale', () => {
    for (const tier of ['tiny', 'small', 'medium', 'large', 'huge'] as const) {
      const req = requirementsForTier(tier);
      expect(req.required.length).toBeGreaterThan(0);
      expect(req.recommended.length).toBeGreaterThan(0);
      expect(req.rationale.length).toBeGreaterThan(0);
    }
  });

  it('required and recommended are disjoint for every tier', () => {
    for (const tier of ['tiny', 'small', 'medium', 'large', 'huge'] as const) {
      const req = requirementsForTier(tier);
      const intersection = req.required.filter(f => req.recommended.includes(f));
      expect(intersection).toEqual([]);
    }
  });
});
