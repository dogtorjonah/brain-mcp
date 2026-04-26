/**
 * Tiered completeness scoring for atlas_commit responses.
 *
 * Background: a single flat "fill rate" over all 9 identity fields punishes
 * tiny config files and lets 2K-line subsystems coast on a blurb + purpose.
 * Tiering by LOC sets expectations agents can actually meet:
 *  - tiny files only need a blurb,
 *  - large files must include source_highlights so future agents have a fast
 *    way in without rereading 1500+ lines.
 *
 * The scorer returns BOTH a tier-relative required-fill rate AND the legacy
 * 9-field overall rate so callers can show whichever framing matches the UI.
 */

export type AtlasFileTier = 'tiny' | 'small' | 'medium' | 'large' | 'huge';

export const ALL_IDENTITY_FIELDS = [
  'purpose',
  'blurb',
  'patterns',
  'hazards',
  'conventions',
  'key_types',
  'data_flows',
  'public_api',
  'source_highlights',
] as const;

export type IdentityField = (typeof ALL_IDENTITY_FIELDS)[number];

export interface TierRequirements {
  tier: AtlasFileTier;
  required: IdentityField[];
  recommended: IdentityField[];
  rationale: string;
}

export function tierForLoc(loc: number): AtlasFileTier {
  if (!Number.isFinite(loc) || loc <= 0) return 'small';
  if (loc <= 50) return 'tiny';
  if (loc <= 200) return 'small';
  if (loc <= 600) return 'medium';
  if (loc <= 1500) return 'large';
  return 'huge';
}

export function requirementsForTier(tier: AtlasFileTier): TierRequirements {
  switch (tier) {
    case 'tiny':
      return {
        tier,
        required: ['blurb'],
        recommended: ['purpose'],
        rationale: 'Tiny files (≤50 LOC) usually only need a one-line blurb.',
      };
    case 'small':
      return {
        tier,
        required: ['blurb', 'purpose'],
        recommended: ['hazards', 'patterns'],
        rationale: 'Small files (≤200 LOC) need blurb + purpose so search and lookups can summarize them.',
      };
    case 'medium':
      return {
        tier,
        required: ['blurb', 'purpose', 'hazards'],
        recommended: ['patterns', 'key_types', 'data_flows'],
        rationale: 'Medium files (≤600 LOC) almost always have at least one correctness hazard worth recording.',
      };
    case 'large':
      return {
        tier,
        required: ['blurb', 'purpose', 'hazards', 'patterns', 'source_highlights'],
        recommended: ['key_types', 'data_flows', 'public_api'],
        rationale: 'Large files (≤1500 LOC) must record source_highlights — future agents cannot reread 1000+ lines just to orient.',
      };
    case 'huge':
      return {
        tier,
        required: ['blurb', 'purpose', 'hazards', 'patterns', 'source_highlights', 'key_types'],
        recommended: ['data_flows', 'public_api', 'conventions'],
        rationale: 'Huge files (>1500 LOC) need full structural metadata — they are load-bearing and expensive to reread.',
      };
  }
}

export interface CompletenessScore {
  tier: AtlasFileTier;
  loc: number;
  required: IdentityField[];
  recommended: IdentityField[];
  filled: IdentityField[];
  missingRequired: IdentityField[];
  missingRecommended: IdentityField[];
  requiredFillRate: number;
  overallFillRate: number;
  rationale: string;
}

export function computeCompleteness(
  loc: number,
  filledFields: ReadonlySet<string>,
): CompletenessScore {
  const tier = tierForLoc(loc);
  const { required, recommended, rationale } = requirementsForTier(tier);
  const filled = ALL_IDENTITY_FIELDS.filter((f) => filledFields.has(f));
  const missingRequired = required.filter((f) => !filledFields.has(f));
  const missingRecommended = recommended.filter((f) => !filledFields.has(f));
  const requiredFillRate = required.length === 0
    ? 1
    : (required.length - missingRequired.length) / required.length;
  const overallFillRate = filled.length / ALL_IDENTITY_FIELDS.length;
  return {
    tier,
    loc: Number.isFinite(loc) && loc > 0 ? Math.round(loc) : 0,
    required,
    recommended,
    filled,
    missingRequired,
    missingRecommended,
    requiredFillRate,
    overallFillRate,
    rationale,
  };
}
