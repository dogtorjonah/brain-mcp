import { z } from 'zod';
import { coercedOptionalBoolean } from '../../zodHelpers.js';

export interface NormalizedAtlasCommitSourceHighlight {
  id: number;
  label?: string;
  startLine: number;
  endLine: number;
  content: string;
}

export interface NormalizedAtlasCommitPublicApiEntry {
  name: string;
  type: string;
  signature?: string;
  description?: string;
}

/**
 * Canonical atlas_commit payload after input healing.
 *
 * The Atlas MCP server is the source of truth for this shape.
 * Callers may send compatibility aliases or shorthand forms, but the commit
 * implementation should consume only this normalized representation.
 */
export interface NormalizedAtlasCommitPayload {
  file_path: string;
  changelog_entry?: string;
  summary?: string;
  patterns_added?: string[];
  patterns_removed?: string[];
  hazards_added?: string[];
  hazards_removed?: string[];
  cluster?: string;
  breaking_changes?: boolean;
  commit_sha?: string;
  author_instance_id?: string;
  author_engine?: string;
  author_name?: string;
  review_entry_id?: string;
  quiet?: boolean;
  purpose?: string;
  public_api?: NormalizedAtlasCommitPublicApiEntry[];
  conventions?: string[];
  key_types?: string[];
  data_flows?: string[];
  hazards?: string[];
  patterns?: string[];
  dependencies?: Record<string, unknown>;
  blurb?: string;
  source_highlights?: NormalizedAtlasCommitSourceHighlight[];
}

const stringListInputSchema = z.union([z.array(z.string()), z.string()]);
const publicApiLooseEntrySchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  id: z.union([z.string(), z.number()]).optional(),
  type: z.string().optional(),
  kind: z.string().optional(),
  signature: z.string().optional(),
  description: z.string().optional(),
  summary: z.string().optional(),
});
const sourceHighlightLooseEntrySchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  label: z.string().optional(),
  title: z.string().optional(),
  startLine: z.union([z.number(), z.string()]).optional(),
  start_line: z.union([z.number(), z.string()]).optional(),
  start: z.union([z.number(), z.string()]).optional(),
  endLine: z.union([z.number(), z.string()]).optional(),
  end_line: z.union([z.number(), z.string()]).optional(),
  end: z.union([z.number(), z.string()]).optional(),
  content: z.string().optional(),
  text: z.string().optional(),
  snippet: z.string().optional(),
});

/**
 * Input boundary schema:
 * - canonical fields remain documented and preferred
 * - compatibility aliases/shorthand forms are accepted for healing
 * - output must still be normalized through normalizeAtlasCommitPayload()
 */
export const atlasCommitInputSchema = {
  file_path: z.string().min(1),
  filePath: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  filepath: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  path: z.string().min(1).optional().describe('Compatibility alias for file_path.'),
  changelog_entry: z.string().min(10).describe(
    'REQUIRED. What you changed and why (1-2 sentences, min 10 chars). This becomes the changelog entry visible under "Recent Changes" in atlas_query lookups. Describe YOUR EDIT, not the file itself — use purpose/blurb for file identity.',
  ),
  summary: z.string().min(1).optional().describe('Deprecated alias for changelog_entry. Use changelog_entry instead.'),
  change_summary: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  changeSummary: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  rationale: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  description: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  what: z.string().min(1).optional().describe('Compatibility alias for changelog_entry.'),
  patterns_added: stringListInputSchema.optional(),
  patternsAdded: stringListInputSchema.optional().describe('Compatibility alias for patterns_added.'),
  new_patterns: stringListInputSchema.optional().describe('Compatibility alias for patterns_added.'),
  newPatterns: stringListInputSchema.optional().describe('Compatibility alias for patterns_added.'),
  added_patterns: stringListInputSchema.optional().describe('Compatibility alias for patterns_added.'),
  patterns_removed: stringListInputSchema.optional(),
  patternsRemoved: stringListInputSchema.optional().describe('Compatibility alias for patterns_removed.'),
  removed_patterns: stringListInputSchema.optional().describe('Compatibility alias for patterns_removed.'),
  hazards_added: stringListInputSchema.optional(),
  hazardsAdded: stringListInputSchema.optional().describe('Compatibility alias for hazards_added.'),
  new_hazards: stringListInputSchema.optional().describe('Compatibility alias for hazards_added.'),
  added_hazards: stringListInputSchema.optional().describe('Compatibility alias for hazards_added.'),
  hazards_removed: stringListInputSchema.optional(),
  hazardsRemoved: stringListInputSchema.optional().describe('Compatibility alias for hazards_removed.'),
  removed_hazards: stringListInputSchema.optional().describe('Compatibility alias for hazards_removed.'),
  pattern: stringListInputSchema.optional().describe('Compatibility alias for patterns (singular form).'),
  hazard: stringListInputSchema.optional().describe('Compatibility alias for hazards (singular form).'),
  risks: stringListInputSchema.optional().describe('Compatibility alias for hazards.'),
  cluster: z.string().optional(),
  breaking_changes: z.union([z.boolean(), z.string()]).optional(),
  breakingChanges: z.union([z.boolean(), z.string()]).optional().describe('Compatibility alias for breaking_changes.'),
  commit_sha: z.string().optional(),
  author_instance_id: z.string().optional(),
  author_engine: z.string().optional(),
  author_name: z.string().optional(),
  review_entry_id: z.string().optional(),
  quiet: coercedOptionalBoolean.describe('Controls response verbosity (default true — compact one-line response). Set false to get verbose feedback with coverage warnings, changelog hints, and flush reminders.'),
  purpose: z.string().min(30).describe(
    'REQUIRED. Timeless 1-2 sentence description of what this file does and why it exists (30-600 chars). NOT a changelog. Should still be true tomorrow, next month, next year. Example: "Routes generation jobs to the correct processor based on document type and section target."',
  ),
  public_api: z.union([z.array(publicApiLooseEntrySchema), z.record(z.string(), z.unknown()), z.string(), z.array(z.string())]).optional(),
  publicApi: z.union([z.array(publicApiLooseEntrySchema), z.record(z.string(), z.unknown()), z.string(), z.array(z.string())]).optional().describe('Compatibility alias for public_api.'),
  conventions: stringListInputSchema.optional(),
  key_types: stringListInputSchema.optional(),
  keyTypes: stringListInputSchema.optional().describe('Compatibility alias for key_types.'),
  data_flows: stringListInputSchema.optional(),
  dataFlows: stringListInputSchema.optional().describe('Compatibility alias for data_flows.'),
  hazards: stringListInputSchema.optional(),
  patterns: stringListInputSchema.optional(),
  dependencies: z.record(z.string(), z.unknown()).optional(),
  blurb: z.string().min(20).describe(
    'REQUIRED. Tweet-length file identity, 20-280 chars. Used in compact neighbor listings and search results. Describes what the file IS, not what changed. Example: "Job generation router dispatching to section-specific processors".',
  ),
  source_highlights: z.union([z.array(sourceHighlightLooseEntrySchema), z.record(z.string(), z.unknown()), z.string()]).optional(),
  sourceHighlights: z.union([z.array(sourceHighlightLooseEntrySchema), z.record(z.string(), z.unknown()), z.string()]).optional().describe('Compatibility alias for source_highlights.'),
} satisfies z.ZodRawShape;

function toTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonIfString<T = unknown>(value: T): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

// Per-entry length cap for pattern/hazard/convention/key_type/data_flow strings.
// Borrowed from vet-soap's sanitizer pattern (clamp-after-parse). Prevents an
// agent from pasting a paragraph as a single "pattern" entry and polluting
// stored metadata. 200 chars is generous for a label — patterns like
// "singleton with lazy init" fit comfortably.
const LIST_ENTRY_MAX_CHARS = 200;
// Blurb/purpose length caps. Blurb is tweet-length display; purpose is 1-2
// sentences. Clamps here catch agents who pass a changelog where a blurb
// belongs — silent truncation with ellipsis keeps the stored row tidy.
const BLURB_MAX_CHARS = 280;
const PURPOSE_MAX_CHARS = 600;

function clampListEntry(entry: string): string {
  if (entry.length <= LIST_ENTRY_MAX_CHARS) return entry;
  return entry.slice(0, LIST_ENTRY_MAX_CHARS - 1) + '…';
}

function dedupeStrings(entries: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function toStringList(value: unknown): string[] | undefined {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) {
    const normalized = parsed
      .map((entry) => (typeof entry === 'string' ? entry.trim() : String(entry ?? '').trim()))
      .filter((entry) => entry.length > 0)
      .map(clampListEntry);
    if (normalized.length === 0) return undefined;
    return dedupeStrings(normalized);
  }
  if (typeof parsed !== 'string') return undefined;
  const text = parsed.trim();
  if (!text) return undefined;
  const normalized = text
    .split(/\r?\n|[,;]/g)
    .map((entry) => entry.replace(/^[-*]\s+/, '').trim())
    .filter((entry) => entry.length > 0)
    .map(clampListEntry);
  if (normalized.length === 0) return undefined;
  return dedupeStrings(normalized);
}

function clampText(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

function mergeStringListInputs(...values: unknown[]): unknown {
  // When multiple alias forms of the same list field arrive (e.g. `pattern` +
  // `patterns`), concatenate rather than picking one. Agents occasionally fill
  // both the singular and plural form with different items.
  const collected: string[] = [];
  let sawAny = false;
  for (const value of values) {
    if (value === undefined) continue;
    sawAny = true;
    const list = toStringList(value);
    if (list) collected.push(...list);
  }
  if (!sawAny) return undefined;
  if (collected.length === 0) return undefined;
  // Deduplicate while preserving order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of collected) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

function normalizePublicApi(value: unknown): NormalizedAtlasCommitPublicApiEntry[] | undefined {
  const parsed = parseJsonIfString(value);
  if (Array.isArray(parsed)) {
    const normalized = parsed
      .map((entry) => {
        if (typeof entry === 'string') {
          const name = entry.trim();
          return name ? { name, type: 'value' } : null;
        }
        if (!entry || typeof entry !== 'object') return null;
        const record = entry as Record<string, unknown>;
        const name = toTrimmedString(record.name ?? record.symbol ?? record.id);
        if (!name) return null;
        const apiEntry: NormalizedAtlasCommitPublicApiEntry = {
          name,
          type: toTrimmedString(record.type ?? record.kind) ?? 'value',
        };
        const signature = toTrimmedString(record.signature);
        if (signature) apiEntry.signature = signature;
        const description = toTrimmedString(record.description ?? record.summary);
        if (description) apiEntry.description = description;
        return apiEntry;
      })
      .filter((entry): entry is NormalizedAtlasCommitPublicApiEntry => Boolean(entry));
    return normalized.length > 0 ? normalized : undefined;
  }
  if (parsed && typeof parsed === 'object') {
    return normalizePublicApi([parsed]);
  }
  const list = toStringList(parsed);
  if (!list) return undefined;
  return list.map((name) => ({ name, type: 'value' }));
}

function normalizeSourceHighlights(value: unknown): NormalizedAtlasCommitSourceHighlight[] | undefined {
  const parsed = parseJsonIfString(value);
  const input = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
  const normalized = input
    .map((entry, index) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      const content = toTrimmedString(record.content ?? record.text ?? record.snippet);
      if (!content) return null;

      const startRaw = record.startLine ?? record.start_line ?? record.start;
      const endRaw = record.endLine ?? record.end_line ?? record.end;
      const startLine = typeof startRaw === 'number' ? startRaw : Number(startRaw);
      const endLine = typeof endRaw === 'number' ? endRaw : Number(endRaw);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) return null;
      if (startLine < 1 || endLine < 1) return null;

      const idRaw = record.id;
      const parsedId = typeof idRaw === 'number' ? idRaw : Number(idRaw);
      const id = Number.isFinite(parsedId) && parsedId >= 1 ? Math.floor(parsedId) : index + 1;

      const highlight: NormalizedAtlasCommitSourceHighlight = {
        id,
        content,
        startLine: Math.floor(startLine),
        endLine: Math.floor(endLine),
      };
      const label = toTrimmedString(record.label ?? record.title);
      if (label) highlight.label = label;
      return highlight;
    })
    .filter((entry): entry is NormalizedAtlasCommitSourceHighlight => Boolean(entry));
  return normalized.length > 0 ? normalized : undefined;
}

const CANONICAL_OUTPUT_KEYS = [
  'file_path',
  'changelog_entry',
  'summary',
  'patterns_added',
  'patterns_removed',
  'hazards_added',
  'hazards_removed',
  'cluster',
  'breaking_changes',
  'commit_sha',
  'author_instance_id',
  'author_engine',
  'author_name',
  'review_entry_id',
  'quiet',
  'purpose',
  'public_api',
  'conventions',
  'key_types',
  'data_flows',
  'hazards',
  'patterns',
  'dependencies',
  'blurb',
  'source_highlights',
] as const;

export function normalizeAtlasCommitPayload(input: Record<string, unknown>): NormalizedAtlasCommitPayload {
  const payload: Record<string, unknown> = { ...input };

  const aliasPairs: Array<[canonical: string, alias: string]> = [
    ['file_path', 'filePath'],
    ['file_path', 'filepath'],
    ['file_path', 'path'],
    ['changelog_entry', 'change_summary'],
    ['changelog_entry', 'changeSummary'],
    ['changelog_entry', 'rationale'],
    ['changelog_entry', 'description'],
    ['changelog_entry', 'what'],
    ['breaking_changes', 'breakingChanges'],
    ['key_types', 'keyTypes'],
    ['data_flows', 'dataFlows'],
    ['public_api', 'publicApi'],
    ['source_highlights', 'sourceHighlights'],
    ['patterns_added', 'patternsAdded'],
    ['patterns_removed', 'patternsRemoved'],
    ['hazards_added', 'hazardsAdded'],
    ['hazards_removed', 'hazardsRemoved'],
    ['author_name', 'authorName'],
  ];
  for (const [canonical, alias] of aliasPairs) {
    if (payload[canonical] === undefined && payload[alias] !== undefined) {
      payload[canonical] = payload[alias];
    }
  }

  // Singular + "new/added/removed_*" aliases MERGE into their plural canonical
  // form rather than overwrite — agents sometimes populate both.
  const mergedPatternsAdded = mergeStringListInputs(
    payload.patterns_added,
    payload.new_patterns,
    payload.newPatterns,
    payload.added_patterns,
  );
  if (mergedPatternsAdded !== undefined) payload.patterns_added = mergedPatternsAdded;

  const mergedPatternsRemoved = mergeStringListInputs(
    payload.patterns_removed,
    payload.removed_patterns,
  );
  if (mergedPatternsRemoved !== undefined) payload.patterns_removed = mergedPatternsRemoved;

  const mergedHazardsAdded = mergeStringListInputs(
    payload.hazards_added,
    payload.new_hazards,
    payload.added_hazards,
  );
  if (mergedHazardsAdded !== undefined) payload.hazards_added = mergedHazardsAdded;

  const mergedHazardsRemoved = mergeStringListInputs(
    payload.hazards_removed,
    payload.removed_hazards,
  );
  if (mergedHazardsRemoved !== undefined) payload.hazards_removed = mergedHazardsRemoved;

  const mergedPatterns = mergeStringListInputs(payload.patterns, payload.pattern);
  if (mergedPatterns !== undefined) payload.patterns = mergedPatterns;

  const mergedHazards = mergeStringListInputs(payload.hazards, payload.hazard, payload.risks);
  if (mergedHazards !== undefined) payload.hazards = mergedHazards;

  const filePath = toTrimmedString(payload.file_path);
  if (filePath) payload.file_path = filePath;

  const changelogEntry = toTrimmedString(payload.changelog_entry) ?? toTrimmedString(payload.summary);
  if (changelogEntry) {
    payload.changelog_entry = changelogEntry;
    if (!toTrimmedString(payload.summary)) payload.summary = changelogEntry;
  }

  // Clamp agent-provided blurb/purpose to sane display lengths. Agents
  // occasionally paste a full changelog where a blurb belongs; silent
  // truncation with ellipsis keeps the stored row tidy without rejecting the
  // commit. Auto-derived blurb is clamped separately below via BLURB_MAX_CHARS.
  const blurb = clampText(toTrimmedString(payload.blurb), BLURB_MAX_CHARS);
  if (blurb) payload.blurb = blurb;

  const purpose = clampText(toTrimmedString(payload.purpose), PURPOSE_MAX_CHARS);
  if (purpose) payload.purpose = purpose;

  const authorInstanceId = toTrimmedString(payload.author_instance_id);
  if (authorInstanceId) payload.author_instance_id = authorInstanceId;

  const authorEngine = toTrimmedString(payload.author_engine);
  if (authorEngine) payload.author_engine = authorEngine;

  const authorName = toTrimmedString(payload.author_name);
  if (authorName) payload.author_name = authorName;

  for (const key of ['patterns_added', 'patterns_removed', 'hazards_added', 'hazards_removed', 'conventions', 'key_types', 'data_flows', 'hazards', 'patterns'] as const) {
    const normalized = toStringList(payload[key]);
    if (normalized) payload[key] = normalized;
  }

  if (payload.public_api !== undefined) {
    payload.public_api = normalizePublicApi(payload.public_api) ?? [];
  }

  if (payload.source_highlights !== undefined) {
    payload.source_highlights = normalizeSourceHighlights(payload.source_highlights) ?? [];
  }

  const rawBreakingChanges = payload.breaking_changes;
  if (typeof rawBreakingChanges === 'string') {
    const folded = rawBreakingChanges.trim().toLowerCase();
    if (folded === 'true' || folded === 'yes' || folded === '1') payload.breaking_changes = true;
    else if (folded === 'false' || folded === 'no' || folded === '0') payload.breaking_changes = false;
  }

  const normalized: Partial<NormalizedAtlasCommitPayload> = {};
  for (const key of CANONICAL_OUTPUT_KEYS) {
    if (payload[key] !== undefined) {
      normalized[key] = payload[key] as never;
    }
  }
  return normalized as NormalizedAtlasCommitPayload;
}

