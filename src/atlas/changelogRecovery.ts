import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  getAtlasChangelogByRecoveryKey,
  insertAtlasChangelog,
  type AtlasDatabase,
} from './db.js';
import { normalizeAtlasCommitPayload, type NormalizedAtlasCommitPayload } from './tools/commitPayload.js';
import {
  buildAtlasCommitRecoveryKey,
  readLocalAtlasCommitArtifacts,
} from '../persistence/localAtlasCommitArtifacts.js';
import { loadAllLocalArchivedInstances } from '../persistence/localArchiveLibrary.js';
import { loadAllLocalInstances } from '../persistence/localInstances.js';
import { readAllLocalMessages, type LocalMessage } from '../persistence/localMessages.js';
import { type LocalCanonicalEvent } from '../persistence/localCanonicalEvents.js';
import { getDataRoot, readEntries } from '../persistence/localStore.js';
import { readThoughtLog, type ThoughtLogEntry } from '../persistence/thoughtLog.js';
import { deriveWorkspace, deriveWorkspaceIdentity } from '../pairingUtils.js';

type RecoverySource = 'artifacts' | 'messages' | 'canonical_events' | 'edit_provenance';

const EDIT_CLUSTER_GAP_MS = 10 * 60 * 1000;
const EDIT_CONTEXT_WINDOW_MS = 5 * 60 * 1000;
const EDIT_COVERAGE_LOOKBACK_MS = 2 * 60 * 1000;
const EDIT_COVERAGE_LOOKAHEAD_MS = 30 * 60 * 1000;
const EDIT_POST_WRAP_UP_WINDOW_MS = 10 * 60 * 1000;
const CHANGELOG_DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

interface RepoScopedInstanceIdentity {
  instanceId: string;
  workspace: string | null;
  repoRoot: string | null;
  authorName: string | null;
  authorEngine: string | null;
}

interface AtlasCommitTrace {
  source: Exclude<RecoverySource, 'edit_provenance'>;
  instanceId: string | null;
  filePath: string;
  turnId: string | null;
  createdAt: string;
  createdAtMs: number;
  payload: NormalizedAtlasCommitPayload | null;
  originalChangelogId: number | null;
  recoveryKey: string | null;
  verificationNotes: string | null;
  authorInstanceId: string | null;
  authorEngine: string | null;
  authorName: string | null;
}

interface AtlasChangelogRecoveryCandidate {
  recoveryKey: string;
  source: RecoverySource;
  workspace: string;
  repoRoot: string;
  originalChangelogId: number | null;
  createdAt: string;
  filePath: string;
  summary: string;
  patternsAdded: string[];
  patternsRemoved: string[];
  hazardsAdded: string[];
  hazardsRemoved: string[];
  cluster: string | null;
  breakingChanges: boolean;
  commitSha: string | null;
  authorInstanceId: string | null;
  authorEngine: string | null;
  authorName: string | null;
  reviewEntryId: string | null;
  payload: NormalizedAtlasCommitPayload | null;
  pinId: string | null;
  verificationNotes: string;
}

interface LocalEditProvenanceEntry {
  id: string;
  iid: string;
  iname?: string;
  tier?: string;
  engine?: string;
  sid?: string | null;
  sqid?: string | null;
  tool: string;
  path: string;
  hash: string;
  tuid: string | null;
  ok: boolean;
  ts: number;
}

interface NormalizedEditTrace {
  instanceId: string;
  filePath: string;
  diffHash: string;
  toolUseId: string | null;
  toolName: string;
  turnId: string | null;
  createdAt: string;
  createdAtMs: number;
}

interface EditCluster {
  instanceId: string;
  filePath: string;
  turnId: string | null;
  firstEditAt: string;
  firstEditAtMs: number;
  lastEditAt: string;
  lastEditAtMs: number;
  editCount: number;
  diffHashes: string[];
  toolUseIds: string[];
  toolNames: Set<string>;
  authorInstanceId: string | null;
  authorEngine: string | null;
  authorName: string | null;
}

type EditSummaryContextSource =
  | 'assistant_text_post_edit'
  | 'thought_log_post_edit'
  | 'transcript_context';

interface EditSummaryContext {
  source: EditSummaryContextSource;
  excerpt: string;
}

type CleanupDeleteReason = 'duplicate_recovery' | 'superseded_edit_provenance';

interface AtlasChangelogCleanupRow {
  id: number;
  source: string;
  filePath: string;
  normalizedFilePath: string | null;
  summary: string;
  createdAt: string;
  createdAtMs: number | null;
  authorInstanceId: string | null;
  authorName: string | null;
  verificationNotes: string | null;
}

export interface AtlasChangelogRecoveryRunOptions {
  apply?: boolean;
}

export interface AtlasChangelogRecoveryResult {
  dataRoot: string;
  workspace: string;
  repoRoot: string;
  artifactEntriesScanned: number;
  messageFilesScanned: number;
  eventFilesScanned: number;
  editFilesScanned: number;
  scopedInstances: number;
  candidateCount: number;
  distinctRecoveryKeys: number;
  candidatesBySource: Record<RecoverySource, number>;
  eligibleRows: number;
  insertedRows: number;
  skippedExistingRecoveryKey: number;
}

export interface AtlasChangelogCleanupRunOptions {
  apply?: boolean;
}

export interface AtlasChangelogCleanupResult {
  workspace: string;
  repoRoot: string;
  changelogRowsScanned: number;
  duplicateClusters: number;
  duplicateRows: number;
  supersededEditRows: number;
  deleteCandidates: number;
  deletedRows: number;
  deletedByReason: Record<CleanupDeleteReason, number>;
}

function normalizeRepoRoot(repoRoot: string): string {
  const resolved = path.resolve(repoRoot);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function normalizeFilePath(filePath: string | null | undefined): string | null {
  if (typeof filePath !== 'string') return null;
  const trimmed = filePath.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRepoScopedFilePath(
  filePath: string | null | undefined,
  repoRoot: string,
): string | null {
  const normalized = normalizeFilePath(filePath);
  if (!normalized) return null;
  if (!path.isAbsolute(normalized)) {
    return normalized.replace(/\\/g, '/').replace(/^\.\//, '');
  }

  const resolved = path.resolve(normalized);
  const relative = path.relative(repoRoot, resolved);
  if (
    relative.length > 0
    && !relative.startsWith('..')
    && !path.isAbsolute(relative)
  ) {
    return relative.replace(/\\/g, '/');
  }

  return resolved.replace(/\\/g, '/');
}

function sameRepoRoot(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false;
  return normalizeRepoRoot(left) === normalizeRepoRoot(right);
}

function findGitRepoRoot(startDir: string | null | undefined): string | null {
  if (!startDir || startDir.trim().length === 0) return null;
  let dir = path.resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) {
      return normalizeRepoRoot(dir);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
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

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex');
}

function toIsoString(value: number): string {
  return new Date(value).toISOString();
}

function parseTimestamp(value: string | number | null | undefined): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractChangelogId(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = text.match(/#(\d+)\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function extractToolUseIdFromMessage(message: LocalMessage): string | null {
  if (message.ti && typeof message.ti === 'object' && !Array.isArray(message.ti)) {
    const toolUseId = (message.ti as { toolUseId?: unknown }).toolUseId;
    if (typeof toolUseId === 'string' && toolUseId.trim().length > 0) {
      return toolUseId.trim();
    }
  }
  return message.id.endsWith(':result')
    ? message.id.slice(0, -':result'.length)
    : null;
}

function extractToolCallIdFromEvent(event: LocalCanonicalEvent): string | null {
  const toolCallId = event.p.toolCallId;
  if (typeof toolCallId === 'string' && toolCallId.trim().length > 0) {
    return toolCallId.trim();
  }
  return null;
}

function isAtlasCommitToolName(value: unknown): boolean {
  return typeof value === 'string' && (value === 'atlas_commit' || value.endsWith('__atlas_commit'));
}

function buildEditRecoveryKey(input: {
  workspace: string;
  repo_root: string;
  instance_id: string;
  file_path: string;
  turn_id?: string | null;
  first_edit_at: string;
}): string {
  return hashText([
    input.workspace.trim(),
    normalizeRepoRoot(input.repo_root),
    input.instance_id.trim(),
    input.file_path.trim(),
    input.turn_id?.trim() ?? '',
    input.first_edit_at,
  ].join('\u0000'));
}

function buildAtlasCommitInputRecoveryKey(input: {
  workspace: string;
  repo_root: string;
  instance_id: string;
  tool_call_id: string;
  file_path: string;
  summary: string;
}): string {
  return hashText([
    input.workspace.trim(),
    normalizeRepoRoot(input.repo_root),
    input.instance_id.trim(),
    input.tool_call_id.trim(),
    input.file_path.trim(),
    input.summary.trim(),
  ].join('\u0000'));
}

function buildInstanceIdentityIndex(): Map<string, RepoScopedInstanceIdentity> {
  const identities = new Map<string, RepoScopedInstanceIdentity>();

  const register = (identity: RepoScopedInstanceIdentity): void => {
    const existing = identities.get(identity.instanceId);
    if (!existing) {
      identities.set(identity.instanceId, identity);
      return;
    }
    identities.set(identity.instanceId, {
      instanceId: identity.instanceId,
      workspace: existing.workspace ?? identity.workspace,
      repoRoot: existing.repoRoot ?? identity.repoRoot,
      authorName: existing.authorName ?? identity.authorName,
      authorEngine: existing.authorEngine ?? identity.authorEngine,
    });
  };

  for (const instance of loadAllLocalInstances()) {
    register({
      instanceId: instance.id,
      workspace: deriveWorkspaceIdentity(instance.cwd, instance.baseWorkspaceKey ?? null),
      repoRoot: findGitRepoRoot(instance.worktreePath ?? instance.cwd),
      authorName: typeof instance.name === 'string' && instance.name.trim().length > 0 ? instance.name.trim() : null,
      authorEngine: typeof instance.engine === 'string' && instance.engine.trim().length > 0 ? instance.engine.trim() : null,
    });
  }

  for (const archived of loadAllLocalArchivedInstances()) {
    register({
      instanceId: archived.id,
      workspace: typeof archived.cwd === 'string' && archived.cwd.trim().length > 0
        ? deriveWorkspace(archived.cwd)
        : null,
      repoRoot: typeof archived.cwd === 'string' ? findGitRepoRoot(archived.cwd) : null,
      authorName: typeof archived.name === 'string' && archived.name.trim().length > 0 ? archived.name.trim() : null,
      authorEngine: typeof archived.engine === 'string' && archived.engine.trim().length > 0 ? archived.engine.trim() : null,
    });
  }

  return identities;
}

function isInstanceRelevant(
  identity: RepoScopedInstanceIdentity | undefined,
  targetWorkspace: string,
  targetRepoRoot: string,
): boolean {
  if (!identity) return false;
  if (identity.repoRoot) {
    return sameRepoRoot(identity.repoRoot, targetRepoRoot);
  }
  return identity.workspace === targetWorkspace;
}

function chooseBetterCandidate(
  current: AtlasChangelogRecoveryCandidate,
  candidate: AtlasChangelogRecoveryCandidate,
): AtlasChangelogRecoveryCandidate {
  const sourceScore = (value: RecoverySource): number => {
    if (value === 'artifacts') return 3;
    if (value === 'messages') return 2;
    if (value === 'canonical_events') return 1;
    return 0;
  };
  const metadataScore = (value: AtlasChangelogRecoveryCandidate): number => {
    return (value.authorName ? 2 : 0)
      + (value.authorEngine ? 1 : 0)
      + (value.commitSha ? 1 : 0)
      + (value.reviewEntryId ? 1 : 0)
      + (((value.payload?.purpose) ?? '').trim() ? 1 : 0)
      + (((value.payload?.blurb) ?? '').trim() ? 1 : 0);
  };

  const currentScore = sourceScore(current.source) * 10 + metadataScore(current);
  const candidateScore = sourceScore(candidate.source) * 10 + metadataScore(candidate);
  if (candidateScore !== currentScore) {
    return candidateScore > currentScore ? candidate : current;
  }
  return candidate.createdAt < current.createdAt ? candidate : current;
}

function addCandidate(
  candidatesByRecoveryKey: Map<string, AtlasChangelogRecoveryCandidate>,
  candidate: AtlasChangelogRecoveryCandidate,
): void {
  const existing = candidatesByRecoveryKey.get(candidate.recoveryKey);
  if (!existing) {
    candidatesByRecoveryKey.set(candidate.recoveryKey, candidate);
    return;
  }
  candidatesByRecoveryKey.set(
    candidate.recoveryKey,
    chooseBetterCandidate(existing, candidate),
  );
}

function pushAtlasCommitTrace(
  traces: AtlasCommitTrace[],
  args: {
    source: Exclude<RecoverySource, 'edit_provenance'>;
    instanceId?: string | null;
    filePath: string;
    turnId?: string | null;
    createdAt: string;
    payload?: NormalizedAtlasCommitPayload | null;
    originalChangelogId?: number | null;
    recoveryKey?: string | null;
    verificationNotes?: string | null;
    authorInstanceId?: string | null;
    authorEngine?: string | null;
    authorName?: string | null;
  },
): void {
  const createdAtMs = parseTimestamp(args.createdAt);
  if (createdAtMs == null) return;
  traces.push({
    source: args.source,
    instanceId: args.instanceId ?? null,
    filePath: args.filePath,
    turnId: args.turnId ?? null,
    createdAt: args.createdAt,
    createdAtMs,
    payload: args.payload ?? null,
    originalChangelogId: args.originalChangelogId ?? null,
    recoveryKey: args.recoveryKey ?? null,
    verificationNotes: args.verificationNotes ?? null,
    authorInstanceId: args.authorInstanceId ?? args.instanceId ?? null,
    authorEngine: args.authorEngine ?? null,
    authorName: args.authorName ?? null,
  });
}

function candidateFromPayload(args: {
  source: Exclude<RecoverySource, 'edit_provenance'>;
  workspace: string;
  repoRoot: string;
  originalChangelogId?: number | null;
  createdAt: string;
  payload: NormalizedAtlasCommitPayload;
  fallbackAuthorInstanceId?: string | null;
  fallbackAuthorEngine?: string | null;
  fallbackAuthorName?: string | null;
  pinId?: string | null;
  recoveryKey?: string | null;
  verificationNotes?: string | null;
}): AtlasChangelogRecoveryCandidate | null {
  const filePath = normalizeRepoScopedFilePath(args.payload.file_path, args.repoRoot);
  const summary = normalizeFilePath(args.payload.summary);
  if (!filePath || !summary) return null;
  const recoveryKey = args.recoveryKey ?? (
    args.originalChangelogId != null
      ? buildAtlasCommitRecoveryKey({
        workspace: args.workspace,
        repo_root: args.repoRoot,
        original_changelog_id: args.originalChangelogId,
        file_path: filePath,
        summary,
      })
      : null
  );
  const verificationNotes = args.verificationNotes ?? (
    args.originalChangelogId != null
      ? `Recovered from ${args.source}; original atlas_commit #${args.originalChangelogId}${args.pinId ? `; ${args.pinId}` : ''}`
      : null
  );
  if (!recoveryKey || !verificationNotes) return null;

  return {
    recoveryKey,
    source: args.source,
    workspace: args.workspace,
    repoRoot: args.repoRoot,
    originalChangelogId: args.originalChangelogId ?? null,
    createdAt: args.createdAt,
    filePath,
    summary,
    patternsAdded: args.payload.patterns_added ?? [],
    patternsRemoved: args.payload.patterns_removed ?? [],
    hazardsAdded: args.payload.hazards_added ?? [],
    hazardsRemoved: args.payload.hazards_removed ?? [],
    cluster: args.payload.cluster ?? null,
    breakingChanges: args.payload.breaking_changes === true,
    commitSha: args.payload.commit_sha ?? null,
    authorInstanceId: args.payload.author_instance_id ?? args.fallbackAuthorInstanceId ?? null,
    authorEngine: args.payload.author_engine ?? args.fallbackAuthorEngine ?? null,
    authorName: args.payload.author_name ?? args.fallbackAuthorName ?? null,
    reviewEntryId: args.payload.review_entry_id ?? null,
    payload: args.payload,
    pinId: args.pinId ?? null,
    verificationNotes,
  };
}

function classifyAtlasCommitResult(
  text: string | null | undefined,
): 'missing' | 'success_with_id' | 'recoverable_without_id' | 'failed_unrecoverable' {
  if (typeof text !== 'string' || text.trim().length === 0) return 'missing';
  if (extractChangelogId(text) != null) return 'success_with_id';

  const normalized = text.toLowerCase();
  if (
    normalized.includes('requires at least one inline atlas field')
    || normalized.includes('no_identity_field')
    || normalized.includes('input validation error')
    || normalized.includes('invalid input')
    || normalized.includes('invalid_type')
    || normalized.includes('expected')
    || normalized.includes('public_api.map is not a function')
  ) {
    return 'failed_unrecoverable';
  }
  if (
    normalized.includes('constraint failed')
    || normalized.includes('fst_under_pressure')
    || normalized.includes('service unavailable')
    || normalized.includes('timeout')
  ) {
    return 'recoverable_without_id';
  }
  if (normalized.includes('error') || normalized.includes('failed')) {
    return 'failed_unrecoverable';
  }
  return 'recoverable_without_id';
}

function buildAtlasCommitInputVerificationNotes(args: {
  source: Exclude<RecoverySource, 'edit_provenance'>;
  toolCallId: string;
  turnId?: string | null;
  outcome: 'missing_result' | 'result_without_row_id';
  resultText?: string | null;
}): string {
  const parts = [
    `Recovered from ${args.source}`,
    args.outcome === 'missing_result'
      ? 'replayed atlas_commit input because no tool result was recorded'
      : 'replayed atlas_commit input because the tool result did not expose a changelog row id',
    `${args.source === 'messages' ? 'tool_use_id' : 'tool_call_id'}=${args.toolCallId}`,
    args.turnId ? `turn=${args.turnId}` : null,
    args.resultText ? `result_excerpt=${JSON.stringify(normalizeTranscriptExcerpt(args.resultText, 220))}` : null,
  ].filter(Boolean);
  return parts.join('; ');
}

function collectArtifactCandidates(
  workspace: string,
  repoRoot: string,
  candidatesByRecoveryKey: Map<string, AtlasChangelogRecoveryCandidate>,
  atlasCommitTraces: AtlasCommitTrace[],
): number {
  const artifacts = readLocalAtlasCommitArtifacts(workspace, repoRoot);
  for (const artifact of artifacts) {
    const candidate = candidateFromPayload({
      source: 'artifacts',
      workspace,
      repoRoot,
      originalChangelogId: artifact.original_changelog_id,
      createdAt: artifact.created_at,
      payload: artifact.payload,
      fallbackAuthorInstanceId: artifact.author_instance_id,
      fallbackAuthorEngine: artifact.author_engine,
      fallbackAuthorName: artifact.author_name,
      pinId: artifact.pin_id,
    });
    if (!candidate) continue;
    addCandidate(candidatesByRecoveryKey, candidate);
    pushAtlasCommitTrace(atlasCommitTraces, {
      source: 'artifacts',
      instanceId: artifact.author_instance_id,
      filePath: candidate.filePath,
      createdAt: artifact.created_at,
      payload: artifact.payload,
      originalChangelogId: artifact.original_changelog_id,
      recoveryKey: candidate.recoveryKey,
      verificationNotes: candidate.verificationNotes,
      authorInstanceId: candidate.authorInstanceId,
      authorEngine: candidate.authorEngine,
      authorName: candidate.authorName,
    });
  }
  return artifacts.length;
}

function collectMessageCandidates(
  workspace: string,
  repoRoot: string,
  identityIndex: Map<string, RepoScopedInstanceIdentity>,
  candidatesByRecoveryKey: Map<string, AtlasChangelogRecoveryCandidate>,
  atlasCommitTraces: AtlasCommitTrace[],
): number {
  const messageInstanceIds = listJsonlKeys('messages');
  let relevantFiles = 0;

  for (const instanceId of messageInstanceIds) {
    const identity = identityIndex.get(instanceId);
    if (!isInstanceRelevant(identity, workspace, repoRoot)) continue;
    relevantFiles += 1;

    const messages = readAllLocalMessages(instanceId);
    const toolUses = new Map<string, {
      payload: NormalizedAtlasCommitPayload;
      turnId: string | null;
      createdAt: string;
    }>();
    const toolResults = new Map<string, {
      state: 'success_with_id' | 'recoverable_without_id' | 'failed_unrecoverable';
      createdAt: string;
      originalChangelogId: number | null;
      resultText: string | null;
    }>();
    for (const message of messages) {
      if (message.ty !== 'tool_use' || !isAtlasCommitToolName(message.tn)) continue;
      if (!message.ti || typeof message.ti !== 'object' || Array.isArray(message.ti)) continue;
      const normalized = normalizeAtlasCommitPayload(message.ti as Record<string, unknown>);
      if (!normalized.file_path || !normalized.summary) continue;
      toolUses.set(message.id, {
        payload: normalized,
        turnId: message.tid ?? null,
        createdAt: message.ts,
      });
    }

    for (const message of messages) {
      if (message.ty !== 'tool_result' || !isAtlasCommitToolName(message.tn)) continue;
      const toolUseId = extractToolUseIdFromMessage(message);
      if (toolUseId == null) continue;
      const originalChangelogId = extractChangelogId(message.tx);
      if (originalChangelogId != null) {
        toolResults.set(toolUseId, {
          state: 'success_with_id',
          createdAt: message.ts,
          originalChangelogId,
          resultText: typeof message.tx === 'string' ? message.tx : null,
        });
      } else if (!toolResults.has(toolUseId)) {
        toolResults.set(toolUseId, {
          state: classifyAtlasCommitResult(message.tx) === 'recoverable_without_id'
            ? 'recoverable_without_id'
            : 'failed_unrecoverable',
          createdAt: message.ts,
          originalChangelogId: null,
          resultText: typeof message.tx === 'string' ? message.tx : null,
        });
      }
    }

    for (const [toolUseId, toolUse] of toolUses.entries()) {
      const outcome = toolResults.get(toolUseId);
      if (outcome?.state === 'failed_unrecoverable') continue;

      if (outcome?.state === 'success_with_id' && outcome.originalChangelogId != null) {
        const candidate = candidateFromPayload({
          source: 'messages',
          workspace,
          repoRoot,
          originalChangelogId: outcome.originalChangelogId,
          createdAt: outcome.createdAt,
          payload: toolUse.payload,
          fallbackAuthorInstanceId: identity?.instanceId ?? null,
          fallbackAuthorEngine: identity?.authorEngine ?? null,
          fallbackAuthorName: identity?.authorName ?? null,
        });
        if (!candidate) continue;
        addCandidate(candidatesByRecoveryKey, candidate);
        pushAtlasCommitTrace(atlasCommitTraces, {
          source: 'messages',
          instanceId: identity?.instanceId ?? null,
          filePath: candidate.filePath,
          turnId: toolUse.turnId ?? null,
          createdAt: outcome.createdAt,
          payload: toolUse.payload,
          originalChangelogId: outcome.originalChangelogId,
          recoveryKey: candidate.recoveryKey,
          verificationNotes: candidate.verificationNotes,
          authorInstanceId: candidate.authorInstanceId,
          authorEngine: candidate.authorEngine,
          authorName: candidate.authorName,
        });
        continue;
      }

      const candidate = candidateFromPayload({
        source: 'messages',
        workspace,
        repoRoot,
        createdAt: toolUse.createdAt,
        payload: toolUse.payload,
        fallbackAuthorInstanceId: identity?.instanceId ?? null,
        fallbackAuthorEngine: identity?.authorEngine ?? null,
        fallbackAuthorName: identity?.authorName ?? null,
        recoveryKey: buildAtlasCommitInputRecoveryKey({
          workspace,
          repo_root: repoRoot,
          instance_id: identity?.instanceId ?? instanceId,
          tool_call_id: toolUseId,
          file_path: toolUse.payload.file_path,
          summary: toolUse.payload.summary ?? '',
        }),
        verificationNotes: buildAtlasCommitInputVerificationNotes({
          source: 'messages',
          toolCallId: toolUseId,
          turnId: toolUse.turnId,
          outcome: outcome?.state === 'recoverable_without_id'
            ? 'result_without_row_id'
            : 'missing_result',
          resultText: outcome?.resultText ?? null,
        }),
      });
      if (!candidate) continue;
      addCandidate(candidatesByRecoveryKey, candidate);
      pushAtlasCommitTrace(atlasCommitTraces, {
        source: 'messages',
        instanceId: identity?.instanceId ?? null,
        filePath: candidate.filePath,
        turnId: toolUse.turnId ?? null,
        createdAt: toolUse.createdAt,
        payload: toolUse.payload,
        recoveryKey: candidate.recoveryKey,
        verificationNotes: candidate.verificationNotes,
        authorInstanceId: candidate.authorInstanceId,
        authorEngine: candidate.authorEngine,
        authorName: candidate.authorName,
      });
    }
  }

  return relevantFiles;
}

function collectCanonicalEventCandidates(
  workspace: string,
  repoRoot: string,
  identityIndex: Map<string, RepoScopedInstanceIdentity>,
  candidatesByRecoveryKey: Map<string, AtlasChangelogRecoveryCandidate>,
  atlasCommitTraces: AtlasCommitTrace[],
): number {
  const eventInstanceIds = listJsonlKeys('events');
  let relevantFiles = 0;

  for (const instanceId of eventInstanceIds) {
    const identity = identityIndex.get(instanceId);
    if (!isInstanceRelevant(identity, workspace, repoRoot)) continue;
    relevantFiles += 1;

    const events = readEntries<LocalCanonicalEvent>('events', instanceId, Number.MAX_SAFE_INTEGER);
    const toolStarts = new Map<string, {
      payload: NormalizedAtlasCommitPayload;
      turnId: string | null;
      createdAt: string;
    }>();
    const toolResults = new Map<string, {
      state: 'success_with_id' | 'recoverable_without_id' | 'failed_unrecoverable';
      createdAt: string;
      originalChangelogId: number | null;
      resultText: string | null;
    }>();
    for (const event of events) {
      if (event.ty !== 'tool_call_start') continue;
      const payload = event.p;
      if (!isAtlasCommitToolName(payload.canonicalToolName ?? payload.rawToolName)) continue;
      const toolCallId = extractToolCallIdFromEvent(event);
      const input = (payload as { input?: unknown }).input;
      if (!toolCallId || !input || typeof input !== 'object' || Array.isArray(input)) continue;
      const normalized = normalizeAtlasCommitPayload(input as Record<string, unknown>);
      if (!normalized.file_path || !normalized.summary) continue;
      toolStarts.set(toolCallId, {
        payload: normalized,
        turnId: event.tid ?? null,
        createdAt: event.ts,
      });
    }

    for (const event of events) {
      if (event.ty !== 'tool_call_result') continue;
      const payload = event.p;
      if (!isAtlasCommitToolName(payload.canonicalToolName ?? payload.rawToolName)) continue;
      const toolCallId = extractToolCallIdFromEvent(event);
      const originalChangelogId = extractChangelogId(typeof payload.output === 'string' ? payload.output : null);
      if (!toolCallId) continue;
      if (originalChangelogId != null) {
        toolResults.set(toolCallId, {
          state: 'success_with_id',
          createdAt: event.ts,
          originalChangelogId,
          resultText: typeof payload.output === 'string' ? payload.output : null,
        });
      } else if (!toolResults.has(toolCallId)) {
        toolResults.set(toolCallId, {
          state: classifyAtlasCommitResult(typeof payload.output === 'string' ? payload.output : null) === 'recoverable_without_id'
            ? 'recoverable_without_id'
            : 'failed_unrecoverable',
          createdAt: event.ts,
          originalChangelogId: null,
          resultText: typeof payload.output === 'string' ? payload.output : null,
        });
      }
    }

    for (const [toolCallId, startPayload] of toolStarts.entries()) {
      const outcome = toolResults.get(toolCallId);
      if (outcome?.state === 'failed_unrecoverable') continue;

      if (outcome?.state === 'success_with_id' && outcome.originalChangelogId != null) {
        const candidate = candidateFromPayload({
          source: 'canonical_events',
          workspace,
          repoRoot,
          originalChangelogId: outcome.originalChangelogId,
          createdAt: outcome.createdAt,
          payload: startPayload.payload,
          fallbackAuthorInstanceId: identity?.instanceId ?? null,
          fallbackAuthorEngine: startPayload.payload.author_engine ?? identity?.authorEngine ?? null,
          fallbackAuthorName: identity?.authorName ?? null,
        });
        if (!candidate) continue;
        addCandidate(candidatesByRecoveryKey, candidate);
        pushAtlasCommitTrace(atlasCommitTraces, {
          source: 'canonical_events',
          instanceId: identity?.instanceId ?? null,
          filePath: candidate.filePath,
          turnId: startPayload.turnId ?? null,
          createdAt: outcome.createdAt,
          payload: startPayload.payload,
          originalChangelogId: outcome.originalChangelogId,
          recoveryKey: candidate.recoveryKey,
          verificationNotes: candidate.verificationNotes,
          authorInstanceId: candidate.authorInstanceId,
          authorEngine: candidate.authorEngine,
          authorName: candidate.authorName,
        });
        continue;
      }

      const candidate = candidateFromPayload({
        source: 'canonical_events',
        workspace,
        repoRoot,
        createdAt: startPayload.createdAt,
        payload: startPayload.payload,
        fallbackAuthorInstanceId: identity?.instanceId ?? null,
        fallbackAuthorEngine: startPayload.payload.author_engine ?? identity?.authorEngine ?? null,
        fallbackAuthorName: identity?.authorName ?? null,
        recoveryKey: buildAtlasCommitInputRecoveryKey({
          workspace,
          repo_root: repoRoot,
          instance_id: identity?.instanceId ?? instanceId,
          tool_call_id: toolCallId,
          file_path: startPayload.payload.file_path,
          summary: startPayload.payload.summary ?? '',
        }),
        verificationNotes: buildAtlasCommitInputVerificationNotes({
          source: 'canonical_events',
          toolCallId,
          turnId: startPayload.turnId,
          outcome: outcome?.state === 'recoverable_without_id'
            ? 'result_without_row_id'
            : 'missing_result',
          resultText: outcome?.resultText ?? null,
        }),
      });
      if (!candidate) continue;
      addCandidate(candidatesByRecoveryKey, candidate);
      pushAtlasCommitTrace(atlasCommitTraces, {
        source: 'canonical_events',
        instanceId: identity?.instanceId ?? null,
        filePath: candidate.filePath,
        turnId: startPayload.turnId ?? null,
        createdAt: startPayload.createdAt,
        payload: startPayload.payload,
        recoveryKey: candidate.recoveryKey,
        verificationNotes: candidate.verificationNotes,
        authorInstanceId: candidate.authorInstanceId,
        authorEngine: candidate.authorEngine,
        authorName: candidate.authorName,
      });
    }
  }

  return relevantFiles;
}

function buildToolTurnIndex(
  messages: LocalMessage[],
  events: LocalCanonicalEvent[],
): Map<string, string | null> {
  const toolTurns = new Map<string, string | null>();
  for (const message of messages) {
    if (message.ty !== 'tool_use') continue;
    toolTurns.set(message.id, message.tid ?? null);
  }
  for (const event of events) {
    if (event.ty !== 'tool_call_start') continue;
    const toolCallId = extractToolCallIdFromEvent(event);
    if (!toolCallId || toolTurns.has(toolCallId)) continue;
    toolTurns.set(toolCallId, event.tid ?? null);
  }
  return toolTurns;
}

function createEditCluster(
  edit: NormalizedEditTrace,
  identity: RepoScopedInstanceIdentity | undefined,
): EditCluster {
  const toolNames = new Set<string>();
  toolNames.add(edit.toolName);
  return {
    instanceId: edit.instanceId,
    filePath: edit.filePath,
    turnId: edit.turnId,
    firstEditAt: edit.createdAt,
    firstEditAtMs: edit.createdAtMs,
    lastEditAt: edit.createdAt,
    lastEditAtMs: edit.createdAtMs,
    editCount: 1,
    diffHashes: edit.diffHash ? [edit.diffHash] : [],
    toolUseIds: edit.toolUseId ? [edit.toolUseId] : [],
    toolNames,
    authorInstanceId: identity?.instanceId ?? edit.instanceId,
    authorEngine: identity?.authorEngine ?? null,
    authorName: identity?.authorName ?? null,
  };
}

function mergeEditIntoCluster(cluster: EditCluster, edit: NormalizedEditTrace): void {
  cluster.firstEditAtMs = Math.min(cluster.firstEditAtMs, edit.createdAtMs);
  cluster.lastEditAtMs = Math.max(cluster.lastEditAtMs, edit.createdAtMs);
  cluster.firstEditAt = toIsoString(cluster.firstEditAtMs);
  cluster.lastEditAt = toIsoString(cluster.lastEditAtMs);
  cluster.editCount += 1;
  if (edit.diffHash && !cluster.diffHashes.includes(edit.diffHash)) {
    cluster.diffHashes.push(edit.diffHash);
  }
  if (edit.toolUseId && !cluster.toolUseIds.includes(edit.toolUseId)) {
    cluster.toolUseIds.push(edit.toolUseId);
  }
  if (edit.toolName) {
    cluster.toolNames.add(edit.toolName);
  }
}

function buildEditClusters(
  instanceId: string,
  repoRoot: string,
  identity: RepoScopedInstanceIdentity | undefined,
  toolTurns: Map<string, string | null>,
): EditCluster[] {
  const rawEdits = readEntries<LocalEditProvenanceEntry>('edits', instanceId, Number.MAX_SAFE_INTEGER);
  const seen = new Set<string>();
  const normalizedEdits: NormalizedEditTrace[] = [];

  for (const row of rawEdits) {
    if (row.ok !== true) continue;
    const filePath = normalizeRepoScopedFilePath(row.path, repoRoot);
    if (!filePath) continue;
    const createdAtMs = parseTimestamp(row.ts);
    if (createdAtMs == null) continue;
    const toolUseId = typeof row.tuid === 'string' && row.tuid.trim().length > 0 ? row.tuid.trim() : null;
    const dedupeKey = [filePath, row.hash ?? '', toolUseId ?? '', String(createdAtMs)].join('\u0000');
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    normalizedEdits.push({
      instanceId,
      filePath,
      diffHash: typeof row.hash === 'string' ? row.hash : '',
      toolUseId,
      toolName: typeof row.tool === 'string' ? row.tool : 'Edit',
      turnId: toolUseId ? (toolTurns.get(toolUseId) ?? null) : null,
      createdAt: toIsoString(createdAtMs),
      createdAtMs,
    });
  }

  const turnScopedClusters = new Map<string, EditCluster>();
  const timedEdits: NormalizedEditTrace[] = [];
  for (const edit of normalizedEdits) {
    if (!edit.turnId) {
      timedEdits.push(edit);
      continue;
    }
    const clusterKey = [edit.instanceId, edit.filePath, edit.turnId].join('\u0000');
    const existing = turnScopedClusters.get(clusterKey);
    if (existing) {
      mergeEditIntoCluster(existing, edit);
      continue;
    }
    turnScopedClusters.set(clusterKey, createEditCluster(edit, identity));
  }

  timedEdits.sort((left, right) => {
    if (left.createdAtMs !== right.createdAtMs) return left.createdAtMs - right.createdAtMs;
    return left.filePath.localeCompare(right.filePath);
  });

  const timeWindowClusters: EditCluster[] = [];
  for (const edit of timedEdits) {
    const current = timeWindowClusters[timeWindowClusters.length - 1];
    if (
      current
      && current.turnId === null
      && current.filePath === edit.filePath
      && edit.createdAtMs - current.lastEditAtMs <= EDIT_CLUSTER_GAP_MS
    ) {
      mergeEditIntoCluster(current, edit);
      continue;
    }
    timeWindowClusters.push(createEditCluster(edit, identity));
  }

  return [...turnScopedClusters.values(), ...timeWindowClusters].sort((left, right) => {
    if (left.firstEditAtMs !== right.firstEditAtMs) return left.firstEditAtMs - right.firstEditAtMs;
    return left.filePath.localeCompare(right.filePath);
  });
}

function hasNearbyAtlasCommit(cluster: EditCluster, traces: AtlasCommitTrace[]): boolean {
  const windowStart = cluster.firstEditAtMs - EDIT_COVERAGE_LOOKBACK_MS;
  const windowEnd = cluster.lastEditAtMs + EDIT_COVERAGE_LOOKAHEAD_MS;

  return traces.some((trace) => {
    if (trace.filePath !== cluster.filePath) return false;
    if (trace.instanceId && trace.instanceId !== cluster.instanceId) return false;
    if (cluster.turnId && trace.turnId) {
      return cluster.turnId === trace.turnId;
    }
    return trace.createdAtMs >= windowStart && trace.createdAtMs <= windowEnd;
  });
}

function hasNearbyExistingChangelogRow(
  db: AtlasDatabase,
  workspace: string,
  repoRoot: string,
  cluster: EditCluster,
): boolean {
  const windowStart = toIsoString(cluster.firstEditAtMs - EDIT_COVERAGE_LOOKBACK_MS);
  const windowEnd = toIsoString(cluster.lastEditAtMs + EDIT_COVERAGE_LOOKAHEAD_MS);
  const rows = db.prepare(`
    SELECT id, file_path
    FROM atlas_changelog
    WHERE workspace = ?
      AND created_at >= ?
      AND created_at <= ?
  `).all(workspace, windowStart, windowEnd) as Array<{ id?: number; file_path?: string }>;
  return rows.some((row) => {
    const existingPath = normalizeRepoScopedFilePath(row.file_path, repoRoot);
    return existingPath === cluster.filePath;
  });
}

function hasExistingEquivalentChangelogRow(
  db: AtlasDatabase,
  args: {
    workspace: string;
    repoRoot: string;
    filePath: string;
    summary: string;
    createdAt: string;
  },
): boolean {
  const rows = db.prepare(`
    SELECT file_path
    FROM atlas_changelog
    WHERE workspace = ?
      AND summary = ?
      AND created_at = ?
  `).all(args.workspace, args.summary, args.createdAt) as Array<{ file_path?: string }>;
  return rows.some((row) => normalizeRepoScopedFilePath(row.file_path, args.repoRoot) === args.filePath);
}

function normalizeTranscriptExcerpt(text: string, maxChars = 220): string {
  const normalized = text
    .replace(/\s+/g, ' ')
    .replace(/`+/g, '')
    .trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1).trimEnd()}…`;
}

function textMentionsFilePath(text: string, filePath: string): boolean {
  const lowerText = text.toLowerCase();
  const lowerFilePath = filePath.toLowerCase();
  const basenameLower = path.basename(filePath).toLowerCase();
  return lowerText.includes(lowerFilePath) || (basenameLower.length > 0 && lowerText.includes(basenameLower));
}

function isLikelyPlanningOrLowSignalExcerpt(excerpt: string): boolean {
  const normalized = excerpt.trim();
  if (normalized.length < 24) return true;
  if (/^(Starting new task|Finished, ready for next task|Waiting for tool approval|Encountered an error)$/i.test(normalized)) {
    return true;
  }
  return (
    /\bi(?:'m| am|’m)\s+going to\b/i.test(normalized)
    || /\bi(?:'m| am|’m)\s+(checking|looking|pulling|mapping|switching|running|doing|reading|re-reading|patching|editing|claiming)\b/i.test(normalized)
    || /\bnext\s+i(?:'ll| will)\b/i.test(normalized)
  );
}

function hasWrapUpSignal(excerpt: string): boolean {
  return /\b(landed|fixed|remove[ds]?|added|updated|patched|resolved|pass(?:ed|es)?|green|cleanup|cleaned)\b/i.test(excerpt);
}

function findPostEditAssistantExcerpt(
  messages: LocalMessage[],
  cluster: EditCluster,
): EditSummaryContext | null {
  let bestMessage: { score: number; tsMs: number; excerpt: string } | null = null;

  for (const message of messages) {
    if (message.ty !== 'assistant_text' || !message.tx?.trim()) continue;
    const tsMs = parseTimestamp(message.ts);
    if (
      tsMs == null
      || tsMs < cluster.lastEditAtMs
      || tsMs > cluster.lastEditAtMs + EDIT_POST_WRAP_UP_WINDOW_MS
    ) {
      continue;
    }

    const excerpt = normalizeTranscriptExcerpt(message.tx, 320);
    if (!excerpt || isLikelyPlanningOrLowSignalExcerpt(excerpt)) continue;

    const sameTurn = Boolean(cluster.turnId && message.tid && cluster.turnId === message.tid);
    const fileHit = textMentionsFilePath(excerpt, cluster.filePath);
    if (!sameTurn && !fileHit) continue;

    let score = 0;
    if (sameTurn) score += 6;
    if (fileHit) score += 6;
    if (tsMs <= cluster.lastEditAtMs + 2 * 60 * 1000) score += 2;

    if (
      !bestMessage
      || score > bestMessage.score
      || (score === bestMessage.score && tsMs > bestMessage.tsMs)
    ) {
      bestMessage = { score, tsMs, excerpt };
    }
  }

  return bestMessage ? { source: 'assistant_text_post_edit', excerpt: bestMessage.excerpt } : null;
}

function findPostEditThoughtExcerpt(
  thoughts: ThoughtLogEntry[],
  cluster: EditCluster,
): EditSummaryContext | null {
  let bestThought: { score: number; tsMs: number; excerpt: string } | null = null;

  for (const thought of thoughts) {
    if (thought.s === 'auto') continue;
    const tsMs = typeof thought.t === 'number' && Number.isFinite(thought.t) ? thought.t : null;
    if (
      tsMs == null
      || tsMs < cluster.lastEditAtMs
      || tsMs > cluster.lastEditAtMs + EDIT_POST_WRAP_UP_WINDOW_MS
    ) {
      continue;
    }

    const excerpt = normalizeTranscriptExcerpt(thought.th, 220);
    if (!excerpt || isLikelyPlanningOrLowSignalExcerpt(excerpt)) continue;

    const fileHit = textMentionsFilePath(excerpt, cluster.filePath);
    const wrapUpSignal = hasWrapUpSignal(excerpt);
    if (!fileHit && !wrapUpSignal) continue;

    let score = thought.s === 'manual' ? 4 : 2;
    if (fileHit) score += 5;
    if (wrapUpSignal) score += 3;
    if (tsMs <= cluster.lastEditAtMs + 2 * 60 * 1000) score += 2;

    if (
      !bestThought
      || score > bestThought.score
      || (score === bestThought.score && tsMs > bestThought.tsMs)
    ) {
      bestThought = { score, tsMs, excerpt };
    }
  }

  return bestThought ? { source: 'thought_log_post_edit', excerpt: bestThought.excerpt } : null;
}

function findTranscriptContextExcerpt(
  messages: LocalMessage[],
  cluster: EditCluster,
): string | null {
  const filePathLower = cluster.filePath.toLowerCase();
  const basenameLower = path.basename(cluster.filePath).toLowerCase();

  let bestMessage: { score: number; tsMs: number; excerpt: string } | null = null;
  for (const message of messages) {
    if ((message.ty !== 'assistant_text' && message.ty !== 'user') || !message.tx?.trim()) continue;
    const tsMs = parseTimestamp(message.ts);
    if (tsMs == null) continue;
    const inScope = cluster.turnId
      ? message.tid === cluster.turnId
        || (tsMs >= cluster.firstEditAtMs - EDIT_CONTEXT_WINDOW_MS && tsMs <= cluster.lastEditAtMs + EDIT_CONTEXT_WINDOW_MS)
      : tsMs >= cluster.firstEditAtMs - EDIT_CONTEXT_WINDOW_MS && tsMs <= cluster.lastEditAtMs + EDIT_CONTEXT_WINDOW_MS;
    if (!inScope) continue;

    const excerpt = normalizeTranscriptExcerpt(message.tx);
    if (!excerpt) continue;

    const lowerText = excerpt.toLowerCase();
    let score = message.ty === 'assistant_text' ? 4 : 1;
    if (message.tid && cluster.turnId && message.tid === cluster.turnId) score += 4;
    if (lowerText.includes(filePathLower)) score += 6;
    if (basenameLower && lowerText.includes(basenameLower)) score += 3;
    if (tsMs >= cluster.firstEditAtMs && tsMs <= cluster.lastEditAtMs + EDIT_CONTEXT_WINDOW_MS) score += 2;
    if (!isLikelyPlanningOrLowSignalExcerpt(excerpt)) score += 1;

    if (
      !bestMessage
      || score > bestMessage.score
      || (score === bestMessage.score && tsMs > bestMessage.tsMs)
    ) {
      bestMessage = { score, tsMs, excerpt };
    }
  }

  return bestMessage?.excerpt ?? null;
}

function findBestEditSummaryContext(
  messages: LocalMessage[],
  thoughts: ThoughtLogEntry[],
  cluster: EditCluster,
): EditSummaryContext | null {
  const postEditAssistant = findPostEditAssistantExcerpt(messages, cluster);
  if (postEditAssistant) return postEditAssistant;

  const postEditThought = findPostEditThoughtExcerpt(thoughts, cluster);
  if (postEditThought) return postEditThought;

  const transcriptExcerpt = findTranscriptContextExcerpt(messages, cluster);
  return transcriptExcerpt ? { source: 'transcript_context', excerpt: transcriptExcerpt } : null;
}

function buildEditRecoverySummary(cluster: EditCluster, context: EditSummaryContext | null): string {
  const excerpt = context?.excerpt ?? null;
  if (
    excerpt
    && excerpt.length >= 24
    && !isLikelyPlanningOrLowSignalExcerpt(excerpt)
  ) {
    return excerpt;
  }

  const toolNames = [...cluster.toolNames];
  if (toolNames.some((toolName) => /write/i.test(toolName))) {
    return `Recover transcript-only write activity for ${cluster.filePath} after a missed atlas_commit.`;
  }
  return cluster.editCount > 1
    ? `Recover transcript-only edits for ${cluster.filePath} after a missed atlas_commit.`
    : `Recover transcript-only edit for ${cluster.filePath} after a missed atlas_commit.`;
}

function buildEditVerificationNotes(cluster: EditCluster, context: EditSummaryContext | null): string {
  const parts = [
    'Recovered from edit_provenance',
    'no nearby atlas_commit found in the same turn or within 30 minutes after the final edit',
    `edit_count=${cluster.editCount}`,
    cluster.turnId ? `turn=${cluster.turnId}` : null,
    cluster.toolUseIds.length > 0 ? `tool_use_ids=${cluster.toolUseIds.join(',')}` : null,
    context ? `summary_source=${context.source}` : null,
    context ? `summary_excerpt=${JSON.stringify(context.excerpt)}` : null,
  ].filter(Boolean);
  return parts.join('; ');
}

function isEditProvenanceRecoveryNotes(notes: string | null | undefined): boolean {
  return typeof notes === 'string' && notes.startsWith('Recovered from edit_provenance');
}

function cleanupAuthorKey(row: Pick<AtlasChangelogCleanupRow, 'authorInstanceId' | 'authorName'>): string {
  const authorInstanceId = row.authorInstanceId?.trim();
  if (authorInstanceId) return `iid:${authorInstanceId}`;
  const authorName = row.authorName?.trim().toLowerCase();
  if (authorName) return `name:${authorName}`;
  return 'unknown';
}

function cleanupRowPriority(row: AtlasChangelogCleanupRow): number {
  if (row.source !== 'atlas_commit_recovery') {
    let score = 50;
    if (row.source === 'atlas_commit') score += 20;
    if (!row.verificationNotes) score += 10;
    return score;
  }
  if (typeof row.verificationNotes === 'string') {
    if (row.verificationNotes.startsWith('Recovered from artifacts')) return 40;
    if (row.verificationNotes.startsWith('Recovered from messages')) return 30;
    if (row.verificationNotes.startsWith('Recovered from canonical_events')) return 20;
    if (isEditProvenanceRecoveryNotes(row.verificationNotes)) return 10;
  }
  return 0;
}

function preferCleanupRow(
  current: AtlasChangelogCleanupRow,
  candidate: AtlasChangelogCleanupRow,
): AtlasChangelogCleanupRow {
  const currentPriority = cleanupRowPriority(current);
  const candidatePriority = cleanupRowPriority(candidate);
  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }
  const currentRelative = current.filePath === current.normalizedFilePath;
  const candidateRelative = candidate.filePath === candidate.normalizedFilePath;
  if (candidateRelative !== currentRelative) {
    return candidateRelative ? candidate : current;
  }
  if (candidate.createdAt !== current.createdAt) {
    return candidate.createdAt > current.createdAt ? candidate : current;
  }
  return candidate.id < current.id ? candidate : current;
}

function loadAtlasChangelogCleanupRows(
  db: AtlasDatabase,
  workspace: string,
  repoRoot: string,
): AtlasChangelogCleanupRow[] {
  const rows = db.prepare(`
    SELECT
      id,
      source,
      file_path,
      summary,
      created_at,
      author_instance_id,
      author_name,
      verification_notes
    FROM atlas_changelog
    WHERE workspace = ?
    ORDER BY created_at ASC, id ASC
  `).all(workspace) as Array<{
    id?: number;
    source?: string;
    file_path?: string;
    summary?: string;
    created_at?: string;
    author_instance_id?: string | null;
    author_name?: string | null;
    verification_notes?: string | null;
  }>;

  return rows
    .filter((row): row is Required<Pick<typeof row, 'id' | 'source' | 'file_path' | 'summary' | 'created_at'>> & typeof row => (
      typeof row.id === 'number'
      && Number.isInteger(row.id)
      && typeof row.source === 'string'
      && typeof row.file_path === 'string'
      && typeof row.summary === 'string'
      && typeof row.created_at === 'string'
    ))
    .map((row) => ({
      id: row.id,
      source: row.source,
      filePath: row.file_path,
      normalizedFilePath: normalizeRepoScopedFilePath(row.file_path, repoRoot),
      summary: row.summary,
      createdAt: row.created_at,
      createdAtMs: parseTimestamp(row.created_at),
      authorInstanceId: normalizeFilePath(row.author_instance_id),
      authorName: normalizeFilePath(row.author_name),
      verificationNotes: typeof row.verification_notes === 'string' ? row.verification_notes : null,
    }));
}

function authorsMatchForSupersededEdit(
  editRow: AtlasChangelogCleanupRow,
  betterRow: AtlasChangelogCleanupRow,
): boolean {
  if (editRow.authorInstanceId) {
    return !betterRow.authorInstanceId || betterRow.authorInstanceId === editRow.authorInstanceId;
  }
  if (editRow.authorName) {
    return !betterRow.authorName || betterRow.authorName === editRow.authorName;
  }
  return true;
}

function countDeletesByReason(
  deleteReasons: Map<number, CleanupDeleteReason>,
): Record<CleanupDeleteReason, number> {
  const deletedByReason: Record<CleanupDeleteReason, number> = {
    duplicate_recovery: 0,
    superseded_edit_provenance: 0,
  };
  for (const reason of deleteReasons.values()) {
    deletedByReason[reason] += 1;
  }
  return deletedByReason;
}

function collectEditCandidates(
  db: AtlasDatabase,
  workspace: string,
  repoRoot: string,
  identityIndex: Map<string, RepoScopedInstanceIdentity>,
  atlasCommitTraces: AtlasCommitTrace[],
  candidatesByRecoveryKey: Map<string, AtlasChangelogRecoveryCandidate>,
): number {
  const editInstanceIds = listJsonlKeys('edits');
  let relevantFiles = 0;

  for (const instanceId of editInstanceIds) {
    const identity = identityIndex.get(instanceId);
    if (!isInstanceRelevant(identity, workspace, repoRoot)) continue;
    relevantFiles += 1;

    const messages = readAllLocalMessages(instanceId);
    const thoughts = readThoughtLog(instanceId, Number.MAX_SAFE_INTEGER);
    const events = readEntries<LocalCanonicalEvent>('events', instanceId, Number.MAX_SAFE_INTEGER);
    const toolTurns = buildToolTurnIndex(messages, events);
    const clusters = buildEditClusters(instanceId, repoRoot, identity, toolTurns);

    for (const cluster of clusters) {
      if (hasNearbyAtlasCommit(cluster, atlasCommitTraces)) continue;
      if (hasNearbyExistingChangelogRow(db, workspace, repoRoot, cluster)) continue;

      const summaryContext = findBestEditSummaryContext(messages, thoughts, cluster);
      const candidate: AtlasChangelogRecoveryCandidate = {
        recoveryKey: buildEditRecoveryKey({
          workspace,
          repo_root: repoRoot,
          instance_id: cluster.instanceId,
          file_path: cluster.filePath,
          turn_id: cluster.turnId,
          first_edit_at: cluster.firstEditAt,
        }),
        source: 'edit_provenance',
        workspace,
        repoRoot,
        originalChangelogId: null,
        createdAt: cluster.lastEditAt,
        filePath: cluster.filePath,
        summary: buildEditRecoverySummary(cluster, summaryContext),
        patternsAdded: [],
        patternsRemoved: [],
        hazardsAdded: [],
        hazardsRemoved: [],
        cluster: null,
        breakingChanges: false,
        commitSha: null,
        authorInstanceId: cluster.authorInstanceId,
        authorEngine: cluster.authorEngine,
        authorName: cluster.authorName,
        reviewEntryId: null,
        payload: null,
        pinId: null,
        verificationNotes: buildEditVerificationNotes(cluster, summaryContext),
      };
      addCandidate(candidatesByRecoveryKey, candidate);
    }
  }

  return relevantFiles;
}

function countCandidatesBySource(
  candidates: AtlasChangelogRecoveryCandidate[],
): Record<RecoverySource, number> {
  const counts: Record<RecoverySource, number> = {
    artifacts: 0,
    messages: 0,
    canonical_events: 0,
    edit_provenance: 0,
  };
  for (const candidate of candidates) {
    counts[candidate.source] += 1;
  }
  return counts;
}

export function runAtlasChangelogNoiseCleanup(
  db: AtlasDatabase,
  args: {
    workspace: string;
    sourceRoot: string;
  },
  options: AtlasChangelogCleanupRunOptions = {},
): AtlasChangelogCleanupResult {
  const apply = options.apply ?? false;
  const repoRoot = normalizeRepoRoot(args.sourceRoot);
  const rows = loadAtlasChangelogCleanupRows(db, args.workspace, repoRoot);
  const deleteReasons = new Map<number, CleanupDeleteReason>();

  const rowsByClusterKey = new Map<string, AtlasChangelogCleanupRow[]>();
  for (const row of rows) {
    if (!row.normalizedFilePath || row.createdAtMs == null) continue;
    const clusterKey = [
      row.normalizedFilePath,
      row.summary,
      cleanupAuthorKey(row),
    ].join('\u0000');
    const existing = rowsByClusterKey.get(clusterKey);
    if (existing) {
      existing.push(row);
    } else {
      rowsByClusterKey.set(clusterKey, [row]);
    }
  }

  let duplicateClusters = 0;
  let duplicateRows = 0;
  for (const clusterRows of rowsByClusterKey.values()) {
    let activeCluster: AtlasChangelogCleanupRow[] = [];
    const flushCluster = (): void => {
      if (
        activeCluster.length < 2
        || !activeCluster.some((row) => row.source === 'atlas_commit_recovery')
      ) {
        activeCluster = [];
        return;
      }
      duplicateClusters += 1;
      let keeper = activeCluster[0];
      for (const row of activeCluster.slice(1)) {
        keeper = preferCleanupRow(keeper, row);
      }
      for (const row of activeCluster) {
        if (row.id === keeper.id || deleteReasons.has(row.id)) continue;
        deleteReasons.set(row.id, 'duplicate_recovery');
        duplicateRows += 1;
      }
      activeCluster = [];
    };

    for (const row of clusterRows) {
      if (
        activeCluster.length === 0
        || row.createdAtMs == null
        || activeCluster[activeCluster.length - 1]?.createdAtMs == null
        || row.createdAtMs - (activeCluster[activeCluster.length - 1]?.createdAtMs ?? 0) <= CHANGELOG_DUPLICATE_WINDOW_MS
      ) {
        activeCluster.push(row);
        continue;
      }
      flushCluster();
      activeCluster = [row];
    }
    flushCluster();
  }

  const betterRowsByFile = new Map<string, AtlasChangelogCleanupRow[]>();
  for (const row of rows) {
    if (
      deleteReasons.has(row.id)
      || !row.normalizedFilePath
      || row.createdAtMs == null
      || isEditProvenanceRecoveryNotes(row.verificationNotes)
    ) {
      continue;
    }
    const existing = betterRowsByFile.get(row.normalizedFilePath);
    if (existing) {
      existing.push(row);
    } else {
      betterRowsByFile.set(row.normalizedFilePath, [row]);
    }
  }
  for (const fileRows of betterRowsByFile.values()) {
    fileRows.sort((left, right) => {
      if (left.createdAtMs !== right.createdAtMs) {
        return (left.createdAtMs ?? 0) - (right.createdAtMs ?? 0);
      }
      return left.id - right.id;
    });
  }

  let supersededEditRows = 0;
  for (const row of rows) {
    if (
      deleteReasons.has(row.id)
      || !row.normalizedFilePath
      || row.createdAtMs == null
      || !isEditProvenanceRecoveryNotes(row.verificationNotes)
    ) {
      continue;
    }
    const betterRows = betterRowsByFile.get(row.normalizedFilePath) ?? [];
    const windowStart = row.createdAtMs - EDIT_COVERAGE_LOOKBACK_MS;
    const windowEnd = row.createdAtMs + EDIT_COVERAGE_LOOKAHEAD_MS;
    const hasBetterRow = betterRows.some((betterRow) => {
      if (betterRow.id === row.id || betterRow.createdAtMs == null) return false;
      if (betterRow.createdAtMs < windowStart || betterRow.createdAtMs > windowEnd) return false;
      return authorsMatchForSupersededEdit(row, betterRow);
    });
    if (!hasBetterRow) continue;
    deleteReasons.set(row.id, 'superseded_edit_provenance');
    supersededEditRows += 1;
  }

  const deleteIds = [...deleteReasons.keys()].sort((left, right) => left - right);
  let deletedRows = 0;
  if (apply && deleteIds.length > 0) {
    const deleteStatement = db.prepare('DELETE FROM atlas_changelog WHERE id = ?');
    const deleteRows = db.transaction((ids: number[]) => {
      for (const id of ids) {
        deleteStatement.run(id);
      }
    });
    deleteRows(deleteIds);
    deletedRows = deleteIds.length;
  }

  return {
    workspace: args.workspace,
    repoRoot,
    changelogRowsScanned: rows.length,
    duplicateClusters,
    duplicateRows,
    supersededEditRows,
    deleteCandidates: deleteIds.length,
    deletedRows,
    deletedByReason: countDeletesByReason(deleteReasons),
  };
}

export function runAtlasChangelogRecovery(
  db: AtlasDatabase,
  args: {
    workspace: string;
    sourceRoot: string;
  },
  options: AtlasChangelogRecoveryRunOptions = {},
): AtlasChangelogRecoveryResult {
  const apply = options.apply ?? false;
  const repoRoot = normalizeRepoRoot(args.sourceRoot);
  const dataRoot = getDataRoot();
  const identityIndex = buildInstanceIdentityIndex();
  const candidatesByRecoveryKey = new Map<string, AtlasChangelogRecoveryCandidate>();
  const atlasCommitTraces: AtlasCommitTrace[] = [];

  const artifactEntriesScanned = collectArtifactCandidates(
    args.workspace,
    repoRoot,
    candidatesByRecoveryKey,
    atlasCommitTraces,
  );
  const messageFilesScanned = collectMessageCandidates(
    args.workspace,
    repoRoot,
    identityIndex,
    candidatesByRecoveryKey,
    atlasCommitTraces,
  );
  const eventFilesScanned = collectCanonicalEventCandidates(
    args.workspace,
    repoRoot,
    identityIndex,
    candidatesByRecoveryKey,
    atlasCommitTraces,
  );
  const editFilesScanned = collectEditCandidates(
    db,
    args.workspace,
    repoRoot,
    identityIndex,
    atlasCommitTraces,
    candidatesByRecoveryKey,
  );
  const candidates = [...candidatesByRecoveryKey.values()].sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt.localeCompare(right.createdAt);
    return left.filePath.localeCompare(right.filePath);
  });

  let skippedExistingRecoveryKey = 0;
  let eligibleRows = 0;
  let insertedRows = 0;

  for (const candidate of candidates) {
    const existing = getAtlasChangelogByRecoveryKey(db, args.workspace, candidate.recoveryKey);
    if (existing) {
      skippedExistingRecoveryKey += 1;
      continue;
    }
    if (hasExistingEquivalentChangelogRow(db, {
      workspace: args.workspace,
      repoRoot,
      filePath: candidate.filePath,
      summary: candidate.summary,
      createdAt: candidate.createdAt,
    })) {
      skippedExistingRecoveryKey += 1;
      continue;
    }
    eligibleRows += 1;
    if (!apply) continue;
    try {
      insertAtlasChangelog(db, {
        workspace: candidate.workspace,
        file_path: candidate.filePath,
        summary: candidate.summary,
        patterns_added: candidate.patternsAdded,
        patterns_removed: candidate.patternsRemoved,
        hazards_added: candidate.hazardsAdded,
        hazards_removed: candidate.hazardsRemoved,
        cluster: candidate.cluster,
        breaking_changes: candidate.breakingChanges,
        commit_sha: candidate.commitSha,
        author_instance_id: candidate.authorInstanceId,
        author_engine: candidate.authorEngine,
        author_name: candidate.authorName,
        review_entry_id: candidate.reviewEntryId,
        source: 'atlas_commit_recovery',
        verification_status: 'pending',
        verification_notes: candidate.verificationNotes,
        recovery_key: candidate.recoveryKey,
        created_at: candidate.createdAt,
      });
      insertedRows += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/UNIQUE constraint failed/i.test(message)) {
        skippedExistingRecoveryKey += 1;
        eligibleRows -= 1;
        continue;
      }
      throw error;
    }
  }

  return {
    dataRoot,
    workspace: args.workspace,
    repoRoot,
    artifactEntriesScanned,
    messageFilesScanned,
    eventFilesScanned,
    editFilesScanned,
    scopedInstances: new Set(
      [...identityIndex.values()]
        .filter((identity) => isInstanceRelevant(identity, args.workspace, repoRoot))
        .map((identity) => identity.instanceId),
    ).size,
    candidateCount: candidates.length,
    distinctRecoveryKeys: candidatesByRecoveryKey.size,
    candidatesBySource: countCandidatesBySource(candidates),
    eligibleRows,
    insertedRows,
    skippedExistingRecoveryKey,
  };
}

export function formatAtlasChangelogRecoveryResult(
  result: AtlasChangelogRecoveryResult,
  options: { dryRun?: boolean } = {},
): string {
  return [
    options.dryRun
      ? '🧪 Atlas changelog recovery — dry run'
      : '🛠️ Atlas changelog recovery',
    `Workspace: ${result.workspace}`,
    `Repo root: ${result.repoRoot}`,
    `Data root: ${result.dataRoot}`,
    `Artifacts scanned: ${result.artifactEntriesScanned}`,
    `Scoped transcript instances: ${result.scopedInstances}`,
    `Message logs scanned: ${result.messageFilesScanned}`,
    `Canonical-event logs scanned: ${result.eventFilesScanned}`,
    `Edit-provenance logs scanned: ${result.editFilesScanned}`,
    `Candidates: ${result.candidateCount} (${result.candidatesBySource.artifacts} artifacts, ${result.candidatesBySource.messages} messages, ${result.candidatesBySource.canonical_events} canonical events, ${result.candidatesBySource.edit_provenance} edit traces)`,
    `Distinct recovery keys: ${result.distinctRecoveryKeys}`,
    `Already present: ${result.skippedExistingRecoveryKey}`,
    options.dryRun
      ? `Rows eligible for insert: ${result.eligibleRows}`
      : `Rows inserted: ${result.insertedRows} / ${result.eligibleRows} eligible`,
  ].join('\n');
}

export function formatAtlasChangelogNoiseCleanupResult(
  result: AtlasChangelogCleanupResult,
  options: { dryRun?: boolean } = {},
): string {
  return [
    options.dryRun
      ? '🧪 Atlas changelog noise cleanup — dry run'
      : '🧹 Atlas changelog noise cleanup',
    `Workspace: ${result.workspace}`,
    `Repo root: ${result.repoRoot}`,
    `Changelog rows scanned: ${result.changelogRowsScanned}`,
    `Duplicate recovery clusters: ${result.duplicateClusters}`,
    `Duplicate recovery rows: ${result.duplicateRows}`,
    `Superseded edit-provenance rows: ${result.supersededEditRows}`,
    `Delete candidates: ${result.deleteCandidates} (${result.deletedByReason.duplicate_recovery} duplicate recovery, ${result.deletedByReason.superseded_edit_provenance} superseded edit traces)`,
    options.dryRun
      ? 'Rows deleted: 0 (preview only)'
      : `Rows deleted: ${result.deletedRows}`,
  ].join('\n');
}
