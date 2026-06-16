import type { AtlasRuntime } from '../types.js';
import type { AtlasChangelogRecord } from '../db.js';
import {
  searchChangelogFts,
  searchChangelogVector,
} from '../db.js';
import {
  embedAtlasQueryText,
  fuseReciprocalRankResults,
} from '../embeddings.js';
import { trackQuery } from '../queryLog.js';
import { resolveWorkspaceDb } from './bridge.js';
import { searchOneWorkspace, type RankedResult } from './search.js';

/**
 * atlas_query action=ask — six-pack #3.
 *
 * Deterministic "answer assembly" over the two evidence stores Atlas already
 * maintains: file metadata (purpose/blurb/hazards/source-highlight chunks via
 * BM25/FTS search) and changelog history (FTS search with dense retrieval
 * disabled in the standalone build until a real embedding provider exists).
 * No LLM call — the output is a CITED BUNDLE the calling agent
 * synthesizes from: ranked file evidence with hazards and exact-line witness
 * regions, ranked changelog entries with IDs (citable / diffable), and a
 * witnesses pointer for who-to-tap follow-up.
 */

export interface AtlasAskArgs {
  query: string;
  workspace?: string;
  limit?: number;
  format?: 'json' | 'text';
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

const FILE_EVIDENCE_DEFAULT = 5;
const FILE_EVIDENCE_MAX = 10;
const CHANGELOG_EVIDENCE_DEFAULT = 8;
const CHANGELOG_EVIDENCE_MAX = 20;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, max - 3))}...`;
}

/** Hazard entries are canonically string[], but legacy rows can surface structured `{ text }` shapes or stringified JSON. */
function coerceHazardText(hazard: unknown): string | null {
  if (typeof hazard === 'string') {
    const trimmed = hazard.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (hazard && typeof hazard === 'object' && 'text' in hazard && typeof (hazard as { text?: unknown }).text === 'string') {
    const trimmed = (hazard as { text: string }).text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  return null;
}

function fileHazards(record: RankedResult['record']): string[] {
  const raw: unknown[] = Array.isArray(record.hazards) ? record.hazards : [];
  return raw
    .map((hazard) => coerceHazardText(hazard))
    .filter((hazard): hazard is string => hazard !== null);
}

function parseSqliteUtcTimestamp(value: string | null | undefined): Date | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = /(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)
    ? trimmed
    : `${trimmed.replace(' ', 'T')}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatLocalTimestamp(value: string | null | undefined): string {
  const parsed = parseSqliteUtcTimestamp(value);
  return parsed ? parsed.toLocaleString() : 'unknown';
}

async function searchChangelogEvidence(
  runtime: AtlasRuntime,
  db: Parameters<typeof searchChangelogFts>[0],
  workspace: string,
  query: string,
  limit: number,
): Promise<Array<{ record: AtlasChangelogRecord; score: number }>> {
  const candidateLimit = clamp(limit * 4, 20, 100);

  const toFusion = (hits: Array<{ record: AtlasChangelogRecord; score: number; source: 'fts' | 'vector' }>) =>
    hits
      .filter((hit) => hit.record.id > 0)
      .map((hit) => ({
        id: hit.record.id,
        item: hit.record,
        score: hit.score,
        source: hit.source,
      }));

  const bm25 = toFusion(searchChangelogFts(db, workspace, query, candidateLimit));

  let vector: ReturnType<typeof toFusion> = [];
  try {
    const embedding = await embedAtlasQueryText(query, runtime.config);
    vector = toFusion(searchChangelogVector(db, workspace, embedding, candidateLimit));
  } catch {
    vector = [];
  }

  return fuseReciprocalRankResults(bm25, vector)
    .slice(0, limit)
    .map((entry) => ({ record: entry.item, score: entry.score }));
}

function formatFileEvidence(results: RankedResult[]): string[] {
  return results.map((result, index) => {
    const summary = result.record.purpose || result.record.blurb || '(no summary yet)';
    const lines = [`${index + 1}. ${result.file_path} — ${truncate(summary, 220)}`];

    const hazards = fileHazards(result.record);
    if (hazards.length > 0) {
      const firstHazard = hazards[0] ?? '';
      const extra = hazards.length > 1 ? ` (+${hazards.length - 1} more)` : '';
      lines.push(`   hazard: ${truncate(firstHazard, 160)}${extra}`);
    }

    lines.push(`   ↳ atlas_query action=lookup file_path="${result.file_path}"`);
    return lines.join('\n');
  });
}

function formatChangelogEvidence(entries: Array<{ record: AtlasChangelogRecord; score: number }>): string[] {
  return entries.map(({ record }, index) => {
    const lines = [
      `${index + 1}. #${record.id} ${record.file_path} [${record.verification_status}] ${formatLocalTimestamp(record.created_at)}`
      + `${record.breaking_changes ? ' ⚠️ breaking' : ''}`,
      `   ${truncate(record.summary, 300)}`,
      `   ↳ atlas_changelog_diff changelog_id=${record.id} mode="stat"`,
    ];
    return lines.join('\n');
  });
}

export async function runAskTool(runtime: AtlasRuntime, args: AtlasAskArgs): Promise<AtlasToolTextResult> {
  const question = args.query?.trim();
  if (!question) {
    return {
      content: [{
        type: 'text',
        text: 'atlas_query action=ask requires a `query` — a natural-language question, e.g. query="how do rebirth packages capture in-flight edits?".',
      }],
    };
  }

  const resolved = resolveWorkspaceDb(runtime, args.workspace);
  if ('error' in resolved) {
    return { content: [{ type: 'text', text: resolved.error }] };
  }
  const { db, workspace } = resolved;

  const fileLimit = clamp(args.limit ?? FILE_EVIDENCE_DEFAULT, 1, FILE_EVIDENCE_MAX);
  const changelogLimit = clamp(
    args.limit ? args.limit * 2 : CHANGELOG_EVIDENCE_DEFAULT,
    1,
    CHANGELOG_EVIDENCE_MAX,
  );

  const [fileResults, changelogResults] = await Promise.all([
    searchOneWorkspace(runtime, db, workspace, question, fileLimit).then((results) => results.slice(0, fileLimit)),
    searchChangelogEvidence(runtime, db, workspace, question, changelogLimit),
  ]);

  trackQuery(
    question,
    fileResults.map((result) => result.record.id),
    fileResults.map((result) => result.file_path),
  );

  if (fileResults.length === 0 && changelogResults.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No atlas evidence found for "${question}". Try broader phrasing, or atlas_query action=search / action=history query="..." directly.`,
      }],
    };
  }

  if (args.format === 'json') {
    const payload = {
      question,
      workspace,
      files: fileResults.map((result) => ({
        file_path: result.file_path,
        score: result.score,
        purpose: result.record.purpose || null,
        blurb: result.record.blurb || null,
        hazards: fileHazards(result.record),
        witness: null,
      })),
      changelog: changelogResults.map(({ record, score }) => ({
        changelog_id: record.id,
        score,
        file_path: record.file_path,
        created_at: record.created_at,
        summary: record.summary,
        verification_status: record.verification_status,
        breaking_changes: record.breaking_changes,
        author_name: record.author_name,
      })),
      witnesses_pointer: fileResults[0]
        ? `atlas_query action=lookup file_path="${fileResults[0].file_path}" include_cross_refs=true`
        : null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
  }

  const sections: string[] = [
    `# Atlas Ask: "${question}"`,
    '',
    'Cited evidence bundle (BM25/FTS plus any available dense retrieval over file metadata and changelog history). Synthesize your answer from the citations below; follow the ↳ commands for deeper evidence.',
  ];

  if (fileResults.length > 0) {
    sections.push('', `## File evidence (${fileResults.length})`, ...formatFileEvidence(fileResults));
  } else {
    sections.push('', '## File evidence', '(no file-metadata matches — the question may be about history rather than current structure)');
  }

  if (changelogResults.length > 0) {
    sections.push('', `## Changelog evidence (${changelogResults.length})`, ...formatChangelogEvidence(changelogResults));
  } else {
    sections.push('', '## Changelog evidence', '(no changelog matches — the question may be about current structure rather than history)');
  }

  const firstFileResult = fileResults[0];
  if (firstFileResult) {
    sections.push(
      '',
      '## Witnesses',
      `↳ atlas_query action=lookup file_path="${firstFileResult.file_path}" include_cross_refs=true — the File Witnesses section ranks prior readers/editors to tap (tap_instance_messages) for first-hand context.`,
    );
  }

  return { content: [{ type: 'text', text: sections.join('\n') }] };
}
