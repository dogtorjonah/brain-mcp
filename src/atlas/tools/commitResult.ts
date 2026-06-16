import type { AutoSyncDriftStats } from './hazardsAutoSync.js';
import type { CompletenessScore } from '../completenessScore.js';

export type AtlasCommitResultStatus =
  | 'committed'
  | 'duplicate_suppressed'
  | 'claim_conflict'
  | 'rejected'
  | 'preflight_passed'
  | 'preflight_failed';
export type AtlasCommitIdempotencyStatus = 'recorded' | 'duplicate_suppressed' | 'not_checked';
export type AtlasCommitVerificationStatus = 'pending' | 'verified' | 'needs_review';

export interface AtlasCommitCompletenessResult {
  tier: CompletenessScore['tier'];
  loc: number;
  required: CompletenessScore['required'];
  recommended: CompletenessScore['recommended'];
  filled: CompletenessScore['filled'];
  missing_required: CompletenessScore['missingRequired'];
  missing_recommended: CompletenessScore['missingRecommended'];
  required_fill_rate: number;
  overall_fill_rate: number;
  rationale: string;
}

export interface AtlasCommitHazardsDriftResult {
  legacy_to_structured: number;
  structured_to_legacy: number;
  stable: number;
  already_aligned: number;
  total_orphans_healed: number;
  healed: boolean;
}

export interface AtlasCommitVerificationResult {
  status: AtlasCommitVerificationStatus;
  evidence?: string;
}

export interface AtlasCommitStructuredResult {
  status: AtlasCommitResultStatus;
  changelog_id?: number;
  file_path: string;
  updated_fields: string[];
  completeness?: AtlasCommitCompletenessResult;
  missing_fields: string[];
  hazards_drift: AtlasCommitHazardsDriftResult;
  verification_state: AtlasCommitVerificationResult;
  idempotency_status: AtlasCommitIdempotencyStatus;
  warnings: string[];
  human_summary: string;
}

export interface BuildAtlasCommitStructuredResultInput {
  status: AtlasCommitResultStatus;
  changelogId?: number;
  filePath: string;
  updatedFields?: readonly string[];
  completeness?: CompletenessScore;
  missingFields?: readonly string[];
  hazardsDriftStats?: AutoSyncDriftStats;
  verification?: {
    status: Exclude<AtlasCommitVerificationStatus, 'pending'>;
    evidence?: string;
  };
  idempotencyStatus?: AtlasCommitIdempotencyStatus;
  warnings?: readonly string[];
  humanSummary: string;
}

function normalizeHazardsDrift(
  stats: AutoSyncDriftStats | undefined,
): AtlasCommitHazardsDriftResult {
  const legacyToStructured = stats?.legacyOrphansAdded ?? 0;
  const structuredToLegacy = stats?.structuredOrphansAdded ?? 0;
  return {
    legacy_to_structured: legacyToStructured,
    structured_to_legacy: structuredToLegacy,
    stable: stats?.duplicatesCollapsed ?? 0,
    already_aligned: stats?.duplicatesCollapsed ?? 0,
    total_orphans_healed: legacyToStructured + structuredToLegacy,
    healed: legacyToStructured + structuredToLegacy > 0,
  };
}

function normalizeCompleteness(
  completeness: CompletenessScore | undefined,
): AtlasCommitCompletenessResult | undefined {
  if (!completeness) return undefined;
  return {
    tier: completeness.tier,
    loc: completeness.loc,
    required: [...completeness.required],
    recommended: [...completeness.recommended],
    filled: [...completeness.filled],
    missing_required: [...completeness.missingRequired],
    missing_recommended: [...completeness.missingRecommended],
    required_fill_rate: completeness.requiredFillRate,
    overall_fill_rate: completeness.overallFillRate,
    rationale: completeness.rationale,
  };
}

export function buildAtlasCommitStructuredResult(
  input: BuildAtlasCommitStructuredResultInput,
): AtlasCommitStructuredResult {
  const verificationState: AtlasCommitVerificationResult = input.verification
    ? {
        status: input.verification.status,
        ...(input.verification.evidence ? { evidence: input.verification.evidence } : {}),
      }
    : { status: 'pending' };

  return {
    status: input.status,
    ...(input.changelogId !== undefined ? { changelog_id: input.changelogId } : {}),
    file_path: input.filePath,
    updated_fields: [...(input.updatedFields ?? [])],
    completeness: normalizeCompleteness(input.completeness),
    missing_fields: [...(input.missingFields ?? [])],
    hazards_drift: normalizeHazardsDrift(input.hazardsDriftStats),
    verification_state: verificationState,
    idempotency_status: input.idempotencyStatus ?? 'not_checked',
    warnings: [...(input.warnings ?? [])],
    human_summary: input.humanSummary,
  };
}

export function formatAtlasCommitStructuredResult(
  result: AtlasCommitStructuredResult,
): string {
  return `atlas_commit_result: ${JSON.stringify(result)}`;
}
