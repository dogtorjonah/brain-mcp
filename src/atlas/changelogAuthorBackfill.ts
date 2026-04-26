import fs from 'node:fs';
import path from 'node:path';

import {
  backfillAtlasChangelogAuthors,
  mapChangelogRecord,
  type AtlasChangelogAuthorBackfillInput,
  type AtlasChangelogRecord,
  type AtlasDatabase,
} from './db.js';
import { normalizeAtlasCommitPayload } from './tools/commitPayload.js';
import type { LocalCanonicalEvent } from '../persistence/localCanonicalEvents.js';
import { loadAllLocalInstances } from '../persistence/localInstances.js';
import { readLocalArchivedInstancesPage } from '../persistence/localArchiveLibrary.js';
import { readAllLocalMessages, type LocalMessage } from '../persistence/localMessages.js';
import { getDataRoot, readEntries } from '../persistence/localStore.js';

type BackfillSource = 'messages' | 'canonical_events';

interface InstanceIdentity {
  instanceId: string;
  authorName: string | null;
  authorEngine: string | null;
}

interface AtlasCommitCallIdentity {
  filePath: string;
  summary: string;
}

export interface AtlasChangelogAuthorBackfillCandidate {
  changelogId: number;
  filePath: string;
  summary: string;
  authorInstanceId: string;
  authorEngine: string | null;
  authorName: string | null;
  source: BackfillSource;
}

export interface AtlasChangelogAuthorBackfillRunOptions {
  apply?: boolean;
}

export interface AtlasChangelogAuthorBackfillAuthorStat {
  instanceId: string;
  authorName: string | null;
  authorEngine: string | null;
  rows: number;
}

export interface AtlasChangelogAuthorBackfillResult {
  dataRoot: string;
  messageFilesScanned: number;
  eventFilesScanned: number;
  candidateCount: number;
  distinctRowIds: number;
  candidatesBySource: Record<BackfillSource, number>;
  matchedRows: number;
  eligibleRows: number;
  updatedRows: number;
  skippedMissingRows: number;
  skippedRowMismatch: number;
  skippedAlreadyAttributed: number;
  skippedInsufficientAuthorData: number;
  unresolvedIdentityCount: number;
  updatedAuthors: AtlasChangelogAuthorBackfillAuthorStat[];
}

function isBlank(value: string | null | undefined): boolean {
  return value == null || value.trim().length === 0;
}

function normalizeComparableText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function isAtlasCommitToolName(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return value === 'atlas_commit' || value.endsWith('__atlas_commit');
}

function extractChangelogId(text: string | null): number | null {
  if (!text) return null;
  const match = text.match(/#(\d+)\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractToolUseIdFromMessage(message: LocalMessage): string | null {
  const input = message.ti;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const toolUseId = (input as { toolUseId?: unknown }).toolUseId;
    if (typeof toolUseId === 'string' && toolUseId.trim().length > 0) {
      return toolUseId.trim();
    }
  }
  return message.id.endsWith(':result')
    ? message.id.slice(0, -':result'.length)
    : null;
}

function extractToolCallIdentity(input: unknown): AtlasCommitCallIdentity | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const normalized = normalizeAtlasCommitPayload(input as Record<string, unknown>);
  if (!normalized.file_path || !normalized.summary) return null;
  return {
    filePath: normalized.file_path,
    summary: normalized.summary,
  };
}

function loadAllArchivedIdentities(): InstanceIdentity[] {
  const rows: InstanceIdentity[] = [];
  let offset = 0;
  for (;;) {
    const page = readLocalArchivedInstancesPage({ limit: 200, offset });
    for (const row of page.rows) {
      rows.push({
        instanceId: row.id,
        authorName: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim() : null,
        authorEngine: typeof row.engine === 'string' && row.engine.trim().length > 0 ? row.engine.trim() : null,
      });
    }
    if (!page.hasMore || page.nextOffset == null) break;
    offset = page.nextOffset;
  }
  return rows;
}

function buildIdentityIndex(): Map<string, InstanceIdentity> {
  const identities = new Map<string, InstanceIdentity>();
  for (const instance of loadAllLocalInstances()) {
    identities.set(instance.id, {
      instanceId: instance.id,
      authorName: typeof instance.name === 'string' && instance.name.trim().length > 0 ? instance.name.trim() : null,
      authorEngine: typeof instance.engine === 'string' && instance.engine.trim().length > 0 ? instance.engine.trim() : null,
    });
  }
  for (const archived of loadAllArchivedIdentities()) {
    if (!identities.has(archived.instanceId)) {
      identities.set(archived.instanceId, archived);
    }
  }
  return identities;
}

function listJsonlKeys(category: string): string[] {
  try {
    const dir = path.join(getDataRoot(), category);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => name.slice(0, -'.jsonl'.length))
      .sort();
  } catch {
    return [];
  }
}

function resolveIdentity(
  identityIndex: Map<string, InstanceIdentity>,
  instanceId: string,
  fallbackEngine: string | null,
): InstanceIdentity {
  const existing = identityIndex.get(instanceId);
  if (!existing) {
    return {
      instanceId,
      authorName: null,
      authorEngine: fallbackEngine,
    };
  }
  return {
    instanceId,
    authorName: existing.authorName,
    authorEngine: existing.authorEngine ?? fallbackEngine,
  };
}

function addCandidate(
  candidatesByRowId: Map<number, AtlasChangelogAuthorBackfillCandidate[]>,
  candidate: AtlasChangelogAuthorBackfillCandidate,
): void {
  const existing = candidatesByRowId.get(candidate.changelogId) ?? [];
  const comparablePath = normalizeComparableText(candidate.filePath);
  const comparableSummary = normalizeComparableText(candidate.summary);
  const duplicateIndex = existing.findIndex((entry) =>
    entry.source === candidate.source
    && entry.authorInstanceId === candidate.authorInstanceId
    && normalizeComparableText(entry.filePath) === comparablePath
    && normalizeComparableText(entry.summary) === comparableSummary,
  );
  if (duplicateIndex >= 0) {
    const prior = existing[duplicateIndex]!;
    const priorScore = (prior.authorName ? 2 : 0) + (prior.authorEngine ? 1 : 0);
    const candidateScore = (candidate.authorName ? 2 : 0) + (candidate.authorEngine ? 1 : 0);
    if (candidateScore > priorScore) {
      existing[duplicateIndex] = candidate;
    }
  } else {
    existing.push(candidate);
  }
  candidatesByRowId.set(candidate.changelogId, existing);
}

function collectMessageCandidates(
  instanceId: string,
  identityIndex: Map<string, InstanceIdentity>,
  candidatesByRowId: Map<number, AtlasChangelogAuthorBackfillCandidate[]>,
  unresolvedIdentityIds: Set<string>,
): number {
  const messages = readAllLocalMessages(instanceId);
  const toolUses = new Map<string, AtlasCommitCallIdentity>();
  for (const message of messages) {
    if (message.ty !== 'tool_use' || !isAtlasCommitToolName(message.tn)) continue;
    const identity = extractToolCallIdentity(message.ti);
    if (!identity) continue;
    toolUses.set(message.id, identity);
  }

  let added = 0;
  for (const message of messages) {
    if (message.ty !== 'tool_result' || !isAtlasCommitToolName(message.tn)) continue;
    const changelogId = extractChangelogId(message.tx);
    const toolUseId = extractToolUseIdFromMessage(message);
    if (changelogId == null || toolUseId == null) continue;
    const toolIdentity = toolUses.get(toolUseId);
    if (!toolIdentity) continue;
    const authorIdentity = resolveIdentity(identityIndex, instanceId, null);
    if (isBlank(authorIdentity.authorName) || isBlank(authorIdentity.authorEngine)) {
      unresolvedIdentityIds.add(instanceId);
    }
    addCandidate(candidatesByRowId, {
      changelogId,
      filePath: toolIdentity.filePath,
      summary: toolIdentity.summary,
      authorInstanceId: instanceId,
      authorEngine: authorIdentity.authorEngine,
      authorName: authorIdentity.authorName,
      source: 'messages',
    });
    added += 1;
  }

  return added;
}

function collectCanonicalEventCandidates(
  instanceId: string,
  identityIndex: Map<string, InstanceIdentity>,
  candidatesByRowId: Map<number, AtlasChangelogAuthorBackfillCandidate[]>,
  unresolvedIdentityIds: Set<string>,
): number {
  const events = readEntries<LocalCanonicalEvent>('events', instanceId, Number.MAX_SAFE_INTEGER);
  const toolStarts = new Map<string, AtlasCommitCallIdentity>();
  for (const event of events) {
    if (event.ty !== 'tool_call_start') continue;
    const payload = event.p;
    if (!isAtlasCommitToolName(payload.canonicalToolName ?? payload.rawToolName)) continue;
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
    const toolIdentity = extractToolCallIdentity((payload as { input?: unknown }).input);
    if (!toolCallId || !toolIdentity) continue;
    toolStarts.set(toolCallId, toolIdentity);
  }

  let added = 0;
  for (const event of events) {
    if (event.ty !== 'tool_call_result') continue;
    const payload = event.p;
    if (!isAtlasCommitToolName(payload.canonicalToolName ?? payload.rawToolName)) continue;
    const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : null;
    const output = typeof payload.output === 'string' ? payload.output : null;
    const changelogId = extractChangelogId(output);
    if (!toolCallId || changelogId == null) continue;
    const toolIdentity = toolStarts.get(toolCallId);
    if (!toolIdentity) continue;
    const fallbackEngine = typeof event.eng === 'string' && event.eng.trim().length > 0 ? event.eng.trim() : null;
    const authorIdentity = resolveIdentity(identityIndex, instanceId, fallbackEngine);
    if (isBlank(authorIdentity.authorName) || isBlank(authorIdentity.authorEngine)) {
      unresolvedIdentityIds.add(instanceId);
    }
    addCandidate(candidatesByRowId, {
      changelogId,
      filePath: toolIdentity.filePath,
      summary: toolIdentity.summary,
      authorInstanceId: instanceId,
      authorEngine: authorIdentity.authorEngine,
      authorName: authorIdentity.authorName,
      source: 'canonical_events',
    });
    added += 1;
  }

  return added;
}

function rowMatchesCandidate(
  row: AtlasChangelogRecord,
  candidate: AtlasChangelogAuthorBackfillCandidate,
): boolean {
  return normalizeComparableText(row.file_path) === normalizeComparableText(candidate.filePath)
    && normalizeComparableText(row.summary) === normalizeComparableText(candidate.summary);
}

function chooseBestCandidate(
  row: AtlasChangelogRecord,
  candidates: AtlasChangelogAuthorBackfillCandidate[],
): AtlasChangelogAuthorBackfillCandidate | null {
  const matches = candidates.filter((candidate) => rowMatchesCandidate(row, candidate));
  if (matches.length === 0) return null;
  return [...matches].sort((left, right) => {
    const leftScore = (left.source === 'messages' ? 4 : 0) + (left.authorName ? 2 : 0) + (left.authorEngine ? 1 : 0);
    const rightScore = (right.source === 'messages' ? 4 : 0) + (right.authorName ? 2 : 0) + (right.authorEngine ? 1 : 0);
    return rightScore - leftScore;
  })[0] ?? null;
}

function canCandidateFillMissingAuthorData(
  row: AtlasChangelogRecord,
  candidate: AtlasChangelogAuthorBackfillCandidate,
): boolean {
  return (isBlank(row.author_instance_id) && !isBlank(candidate.authorInstanceId))
    || (isBlank(row.author_engine) && !isBlank(candidate.authorEngine))
    || (isBlank(row.author_name) && !isBlank(candidate.authorName));
}

export function runAtlasChangelogAuthorBackfill(
  db: AtlasDatabase,
  options: AtlasChangelogAuthorBackfillRunOptions = {},
): AtlasChangelogAuthorBackfillResult {
  const apply = options.apply ?? true;
  const dataRoot = getDataRoot();
  const identityIndex = buildIdentityIndex();
  const unresolvedIdentityIds = new Set<string>();
  const candidatesByRowId = new Map<number, AtlasChangelogAuthorBackfillCandidate[]>();

  const messageInstanceIds = listJsonlKeys('messages');
  const eventInstanceIds = listJsonlKeys('events');

  let messageCandidates = 0;
  for (const instanceId of messageInstanceIds) {
    messageCandidates += collectMessageCandidates(instanceId, identityIndex, candidatesByRowId, unresolvedIdentityIds);
  }

  let canonicalEventCandidates = 0;
  for (const instanceId of eventInstanceIds) {
    canonicalEventCandidates += collectCanonicalEventCandidates(instanceId, identityIndex, candidatesByRowId, unresolvedIdentityIds);
  }

  const selectedCandidates = new Map<number, AtlasChangelogAuthorBackfillCandidate>();
  const patchesToApply: AtlasChangelogAuthorBackfillInput[] = [];
  let matchedRows = 0;
  let skippedMissingRows = 0;
  let skippedRowMismatch = 0;
  let skippedAlreadyAttributed = 0;
  let skippedInsufficientAuthorData = 0;

  const lookupRow = db.prepare('SELECT * FROM atlas_changelog WHERE id = ? LIMIT 1');
  for (const [rowId, candidates] of candidatesByRowId) {
    const row = lookupRow.get(rowId) as Record<string, unknown> | undefined;
    if (!row) {
      skippedMissingRows += 1;
      continue;
    }
    const record = mapChangelogRecord(row);
    const candidate = chooseBestCandidate(record, candidates);
    if (!candidate) {
      skippedRowMismatch += 1;
      continue;
    }
    matchedRows += 1;

    if (!isBlank(record.author_instance_id) && !isBlank(record.author_engine) && !isBlank(record.author_name)) {
      skippedAlreadyAttributed += 1;
      continue;
    }

    if (!canCandidateFillMissingAuthorData(record, candidate)) {
      skippedInsufficientAuthorData += 1;
      continue;
    }

    selectedCandidates.set(rowId, candidate);
    patchesToApply.push({
      id: rowId,
      author_instance_id: candidate.authorInstanceId,
      author_engine: candidate.authorEngine,
      author_name: candidate.authorName,
    });
  }

  const applyResult = apply
    ? backfillAtlasChangelogAuthors(db, patchesToApply)
    : { attempted: patchesToApply.length, updated: 0, updatedIds: [] as number[] };

  const updatedIds = new Set(applyResult.updatedIds);
  const updatedAuthors = new Map<string, AtlasChangelogAuthorBackfillAuthorStat>();
  for (const rowId of updatedIds) {
    const candidate = selectedCandidates.get(rowId);
    if (!candidate) continue;
    const authorKey = `${candidate.authorInstanceId}\u0000${candidate.authorName ?? ''}\u0000${candidate.authorEngine ?? ''}`;
    const existing = updatedAuthors.get(authorKey);
    if (existing) {
      existing.rows += 1;
      continue;
    }
    updatedAuthors.set(authorKey, {
      instanceId: candidate.authorInstanceId,
      authorName: candidate.authorName,
      authorEngine: candidate.authorEngine,
      rows: 1,
    });
  }

  return {
    dataRoot,
    messageFilesScanned: messageInstanceIds.length,
    eventFilesScanned: eventInstanceIds.length,
    candidateCount: messageCandidates + canonicalEventCandidates,
    distinctRowIds: candidatesByRowId.size,
    candidatesBySource: {
      messages: messageCandidates,
      canonical_events: canonicalEventCandidates,
    },
    matchedRows,
    eligibleRows: patchesToApply.length,
    updatedRows: applyResult.updated,
    skippedMissingRows,
    skippedRowMismatch,
    skippedAlreadyAttributed,
    skippedInsufficientAuthorData,
    unresolvedIdentityCount: unresolvedIdentityIds.size,
    updatedAuthors: [...updatedAuthors.values()].sort((left, right) =>
      right.rows - left.rows
      || (left.authorName ?? left.instanceId).localeCompare(right.authorName ?? right.instanceId),
    ),
  };
}

export function formatAtlasChangelogAuthorBackfillResult(
  result: AtlasChangelogAuthorBackfillResult,
  options: { dryRun?: boolean; topAuthors?: number } = {},
): string {
  const topAuthors = options.topAuthors ?? 10;
  const lines = [
    options.dryRun
      ? '🧪 Atlas changelog author backfill — dry run'
      : '🛠️ Atlas changelog author backfill',
    `Data root: ${result.dataRoot}`,
    `Message files scanned: ${result.messageFilesScanned}`,
    `Event files scanned: ${result.eventFilesScanned}`,
    `Candidates: ${result.candidateCount} (${result.candidatesBySource.messages} messages, ${result.candidatesBySource.canonical_events} canonical events)`,
    `Distinct changelog row ids: ${result.distinctRowIds}`,
    `Matched current rows: ${result.matchedRows}`,
    options.dryRun
      ? `Rows eligible for update: ${result.eligibleRows}`
      : `Rows updated: ${result.updatedRows} / ${result.eligibleRows} eligible`,
    `Skipped: missing row=${result.skippedMissingRows}, row mismatch=${result.skippedRowMismatch}, already attributed=${result.skippedAlreadyAttributed}, insufficient author data=${result.skippedInsufficientAuthorData}`,
    `Instances missing name/engine metadata: ${result.unresolvedIdentityCount}`,
  ];

  if (result.updatedAuthors.length > 0) {
    lines.push('', 'Top updated authors:');
    for (const author of result.updatedAuthors.slice(0, topAuthors)) {
      const label = author.authorName ?? author.instanceId;
      const engine = author.authorEngine ? ` (${author.authorEngine})` : '';
      lines.push(`- ${label}${engine}: ${author.rows}`);
    }
  }

  return lines.join('\n');
}
