import { createHash } from 'node:crypto';
import type {
  AtlasChangelogRecord,
  AtlasDatabase,
  AtlasSourceChunkRecord,
} from './db.js';
import {
  listAllAtlasChangelog,
  listAtlasFiles,
  replaceSourceChunks,
  upsertChangelogEmbedding,
  upsertEmbedding,
  upsertSourceChunkEmbedding,
} from './db.js';
import type { AtlasFileRecord, AtlasServerConfig, AtlasSourceChunk } from './types.js';
import { buildEmbeddingInput, buildSourceChunks } from './pipeline/shared.js';
import {
  DEFAULT_EMBED_CONFIG,
  type DenseEmbedConfig,
} from '../persistence/denseRetrieval/types.js';
import {
  embedBatch,
  embedQuery,
} from '../persistence/denseRetrieval/embedClient.js';

type AtlasEmbeddingConfigSource = Pick<AtlasServerConfig, 'embeddingModel' | 'embeddingDimensions'>;

export type AtlasEmbeddingPhase = 'files' | 'source_chunks' | 'changelog';

export interface AtlasEmbeddingProgressEvent {
  phase: AtlasEmbeddingPhase;
  /** Items embedded so far this phase. */
  completed: number;
  /** Items that still need embedding this phase (post-skip). */
  total: number;
  /** Items skipped because their cached hash matched. */
  skipped: number;
}

type AtlasEmbeddingBackfillConfig = AtlasEmbeddingConfigSource & {
  filePaths?: string[];
  onProgress?: (event: AtlasEmbeddingProgressEvent) => void;
};

/**
 * Sidecar table that records the text hash used for the most recent successful
 * embedding per target. On re-runs we compare the current input hash against
 * this; matches skip the entire embed (no disk reads, no model calls, no DB
 * writes for the vector). Lazy-created — no migration required.
 */
const EMBED_HASH_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS atlas_embedding_hashes (
    kind      TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    text_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (kind, target_id)
  )
`;

type EmbedHashKind = 'file' | 'source_chunk' | 'changelog';

function ensureEmbeddingHashTable(db: AtlasDatabase): void {
  db.exec(EMBED_HASH_TABLE_SQL);
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function loadEmbeddingHashes(
  db: AtlasDatabase,
  kind: EmbedHashKind,
): Map<number, string> {
  const rows = db
    .prepare('SELECT target_id, text_hash FROM atlas_embedding_hashes WHERE kind = ?')
    .all(kind) as Array<{ target_id: number; text_hash: string }>;
  const out = new Map<number, string>();
  for (const row of rows) out.set(row.target_id, row.text_hash);
  return out;
}

function recordEmbeddingHashes(
  db: AtlasDatabase,
  kind: EmbedHashKind,
  updates: Array<{ targetId: number; textHash: string }>,
): void {
  if (updates.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO atlas_embedding_hashes (kind, target_id, text_hash, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(kind, target_id) DO UPDATE SET
       text_hash = excluded.text_hash,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction((items: Array<{ targetId: number; textHash: string }>) => {
    for (const item of items) stmt.run(kind, item.targetId, item.textHash);
  });
  tx(updates);
}

export interface ReciprocalRankResult<T> {
  id: string | number;
  item: T;
  score: number;
  source: 'fts' | 'vector';
}

export interface AtlasEmbeddingBackfillResult {
  fileEmbeddings: number;
  fileSkipped: number;
  sourceChunkEmbeddings: number;
  sourceChunkSkipped: number;
  changelogEmbeddings: number;
  changelogSkipped: number;
}

export interface AtlasSourceChunkEmbeddingRefreshResult {
  embedded: number;
  skipped: number;
}

export function getAtlasEmbeddingConfig(
  config: AtlasEmbeddingConfigSource,
): DenseEmbedConfig {
  return {
    ...DEFAULT_EMBED_CONFIG,
    model: config.embeddingModel,
    dimensions: config.embeddingDimensions,
  };
}

export function buildAtlasChangelogEmbeddingInput(
  entry: Pick<
    AtlasChangelogRecord,
    | 'file_path'
    | 'summary'
    | 'cluster'
    | 'patterns_added'
    | 'patterns_removed'
    | 'hazards_added'
    | 'hazards_removed'
    | 'verification_notes'
  >,
): string {
  return [
    entry.file_path,
    entry.summary,
    entry.cluster ?? '',
    entry.patterns_added.join(', '),
    entry.patterns_removed.join(', '),
    entry.hazards_added.join(', '),
    entry.hazards_removed.join(', '),
    entry.verification_notes ?? '',
  ].filter((part) => part.trim().length > 0).join('\n');
}

export function buildAtlasSourceChunkEmbeddingInput(
  filePath: string,
  chunk: Pick<AtlasSourceChunk, 'kind' | 'label' | 'startLine' | 'endLine' | 'content'>,
): string {
  return [
    filePath,
    chunk.kind === 'highlight' ? 'source highlight' : 'source code chunk',
    chunk.label ?? '',
    `lines ${chunk.startLine}-${chunk.endLine}`,
    chunk.content,
  ].filter((part) => part.trim().length > 0).join('\n');
}

export async function embedAtlasQueryText(
  query: string,
  config: AtlasEmbeddingConfigSource,
): Promise<number[]> {
  const embedding = await embedQuery(query, getAtlasEmbeddingConfig(config));
  return Array.from(embedding);
}

async function embedTexts(
  texts: string[],
  config: AtlasEmbeddingConfigSource,
  onBatchComplete?: (done: number) => void,
): Promise<number[][]> {
  if (texts.length === 0) return [];
  const embedConfig = getAtlasEmbeddingConfig(config);
  const { batchSize } = embedConfig;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = await embedBatch(slice, { config: embedConfig });
    for (const v of vecs) out.push(Array.from(v));
    onBatchComplete?.(out.length);
  }
  return out;
}

export async function refreshAtlasFileEmbedding(
  db: AtlasDatabase,
  workspace: string,
  file: AtlasFileRecord,
  config: AtlasEmbeddingConfigSource,
): Promise<boolean> {
  const text = buildEmbeddingInput(file);
  if (!text.trim()) return false;
  const [embedding] = await embedTexts([text], config);
  if (!embedding) return false;
  upsertEmbedding(db, workspace, file.file_path, embedding);
  return true;
}

export async function refreshAtlasSourceChunkEmbeddings(
  db: AtlasDatabase,
  workspace: string,
  file: AtlasFileRecord,
  sourceRoot: string,
  config: AtlasEmbeddingConfigSource,
): Promise<AtlasSourceChunkEmbeddingRefreshResult> {
  const chunks = await buildSourceChunks(sourceRoot, file);
  const storedChunks = replaceSourceChunks(db, workspace, file.file_path, chunks);
  if (storedChunks.length === 0) {
    return { embedded: 0, skipped: 0 };
  }

  const chunkInputs = storedChunks
    .map((chunk) => ({
      chunk,
      text: buildAtlasSourceChunkEmbeddingInput(file.file_path, chunkRecordToEmbeddingChunk(chunk)),
    }))
    .filter((entry) => entry.text.trim().length > 0);

  const embeddings = await embedTexts(chunkInputs.map((entry) => entry.text), config);
  embeddings.forEach((embedding, index) => {
    const entry = chunkInputs[index];
    if (!entry) return;
    upsertSourceChunkEmbedding(db, entry.chunk.id, embedding);
  });

  return {
    embedded: embeddings.length,
    skipped: storedChunks.length - embeddings.length,
  };
}

export async function refreshAtlasChangelogEmbedding(
  db: AtlasDatabase,
  entry: AtlasChangelogRecord,
  config: AtlasEmbeddingConfigSource,
): Promise<boolean> {
  const text = buildAtlasChangelogEmbeddingInput(entry);
  if (!text.trim()) return false;
  const [embedding] = await embedTexts([text], config);
  if (!embedding) return false;
  upsertChangelogEmbedding(db, entry.id, embedding);
  return true;
}

function chunkRecordToEmbeddingChunk(
  chunk: AtlasSourceChunkRecord,
): Pick<AtlasSourceChunk, 'kind' | 'label' | 'startLine' | 'endLine' | 'content'> {
  return {
    kind: chunk.kind,
    label: chunk.label,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
  };
}

export async function backfillAtlasEmbeddings(
  db: AtlasDatabase,
  workspace: string,
  sourceRoot: string,
  config: AtlasEmbeddingBackfillConfig,
): Promise<AtlasEmbeddingBackfillResult> {
  ensureEmbeddingHashTable(db);

  const onProgress = config.onProgress;
  const requestedFiles = config.filePaths && config.filePaths.length > 0
    ? new Set(config.filePaths.map((filePath) => filePath.trim()).filter(Boolean))
    : null;
  const files = listAtlasFiles(db, workspace).filter(
    (file) => requestedFiles == null || requestedFiles.has(file.file_path),
  );

  // ── Phase A: file-level embeddings (hash-gated) ─────────────────────────
  const fileHashMap = loadEmbeddingHashes(db, 'file');
  const fileWork: Array<{ file: AtlasFileRecord; text: string; hash: string; fileId: number }> = [];
  let fileSkipped = 0;
  for (const file of files) {
    const text = buildEmbeddingInput(file);
    if (!text.trim()) {
      fileSkipped += 1;
      continue;
    }
    const fileId = file.id;
    const currentHash = hashText(text);
    if (fileHashMap.get(fileId) === currentHash) {
      fileSkipped += 1;
      continue;
    }
    fileWork.push({ file, text, hash: currentHash, fileId });
  }
  onProgress?.({ phase: 'files', completed: 0, total: fileWork.length, skipped: fileSkipped });

  const fileEmbeddings = await embedTexts(
    fileWork.map((entry) => entry.text),
    config,
    (done) => onProgress?.({ phase: 'files', completed: done, total: fileWork.length, skipped: fileSkipped }),
  );
  const fileHashUpdates: Array<{ targetId: number; textHash: string }> = [];
  fileEmbeddings.forEach((embedding, index) => {
    const entry = fileWork[index];
    if (!entry) return;
    upsertEmbedding(db, workspace, entry.file.file_path, embedding);
    if (entry.fileId >= 0) {
      fileHashUpdates.push({ targetId: entry.fileId, textHash: entry.hash });
    }
  });
  recordEmbeddingHashes(db, 'file', fileHashUpdates);

  // ── Phase B: source-chunk embeddings (per-file file_hash gate) ──────────
  // If a file's content hash hasn't changed since the last successful chunk
  // backfill, skip disk-read + chunk-rebuild + embed entirely. Hash is stored
  // against file.id under kind='source_chunk' as a single summary marker.
  const sourceChunkHashMap = loadEmbeddingHashes(db, 'source_chunk');
  const sourceChunkInputs: Array<{ chunk: AtlasSourceChunkRecord; text: string }> = [];
  const filesTouchedForChunks: Array<{ fileId: number; fileHashMarker: string }> = [];
  let storedSourceChunkCount = 0;
  let sourceChunkFileSkipped = 0;
  for (const file of files) {
    const fileId = file.id;
    const fileContentHash = file.file_hash ?? '';
    if (fileContentHash && sourceChunkHashMap.get(fileId) === fileContentHash) {
      sourceChunkFileSkipped += 1;
      continue;
    }
    const chunks = await buildSourceChunks(sourceRoot, file);
    const storedChunks = replaceSourceChunks(db, workspace, file.file_path, chunks);
    storedSourceChunkCount += storedChunks.length;
    if (fileContentHash) {
      filesTouchedForChunks.push({ fileId, fileHashMarker: fileContentHash });
    }
    storedChunks.forEach((chunk) => {
      const text = buildAtlasSourceChunkEmbeddingInput(file.file_path, chunkRecordToEmbeddingChunk(chunk));
      if (!text.trim()) return;
      sourceChunkInputs.push({ chunk, text });
    });
  }
  onProgress?.({
    phase: 'source_chunks',
    completed: 0,
    total: sourceChunkInputs.length,
    skipped: sourceChunkFileSkipped,
  });

  const sourceChunkEmbeddings = await embedTexts(
    sourceChunkInputs.map((entry) => entry.text),
    config,
    (done) =>
      onProgress?.({
        phase: 'source_chunks',
        completed: done,
        total: sourceChunkInputs.length,
        skipped: sourceChunkFileSkipped,
      }),
  );
  sourceChunkEmbeddings.forEach((embedding, index) => {
    const entry = sourceChunkInputs[index];
    if (!entry) return;
    upsertSourceChunkEmbedding(db, entry.chunk.id, embedding);
  });
  recordEmbeddingHashes(
    db,
    'source_chunk',
    filesTouchedForChunks.map((entry) => ({ targetId: entry.fileId, textHash: entry.fileHashMarker })),
  );

  // ── Phase C: changelog embeddings (hash-gated) ──────────────────────────
  const changelogHashMap = loadEmbeddingHashes(db, 'changelog');
  const changelogEntries = listAllAtlasChangelog(db, workspace)
    .filter((entry) => requestedFiles == null || requestedFiles.has(entry.file_path));
  const changelogWork: Array<{ entry: AtlasChangelogRecord; text: string; hash: string }> = [];
  let changelogSkipped = 0;
  for (const entry of changelogEntries) {
    const text = buildAtlasChangelogEmbeddingInput(entry);
    if (!text.trim()) {
      changelogSkipped += 1;
      continue;
    }
    const currentHash = hashText(text);
    if (changelogHashMap.get(entry.id) === currentHash) {
      changelogSkipped += 1;
      continue;
    }
    changelogWork.push({ entry, text, hash: currentHash });
  }
  onProgress?.({
    phase: 'changelog',
    completed: 0,
    total: changelogWork.length,
    skipped: changelogSkipped,
  });

  const changelogEmbeddings = await embedTexts(
    changelogWork.map((item) => item.text),
    config,
    (done) =>
      onProgress?.({
        phase: 'changelog',
        completed: done,
        total: changelogWork.length,
        skipped: changelogSkipped,
      }),
  );
  const changelogHashUpdates: Array<{ targetId: number; textHash: string }> = [];
  changelogEmbeddings.forEach((embedding, index) => {
    const item = changelogWork[index];
    if (!item) return;
    upsertChangelogEmbedding(db, item.entry.id, embedding);
    changelogHashUpdates.push({ targetId: item.entry.id, textHash: item.hash });
  });
  recordEmbeddingHashes(db, 'changelog', changelogHashUpdates);

  return {
    fileEmbeddings: fileEmbeddings.length,
    fileSkipped: (files.length - fileWork.length) + (fileWork.length - fileEmbeddings.length),
    sourceChunkEmbeddings: sourceChunkEmbeddings.length,
    sourceChunkSkipped: storedSourceChunkCount - sourceChunkEmbeddings.length,
    changelogEmbeddings: changelogEmbeddings.length,
    changelogSkipped,
  };
}

export function fuseReciprocalRankResults<T>(
  fts: ReciprocalRankResult<T>[],
  vector: ReciprocalRankResult<T>[],
  k = 60,
): ReciprocalRankResult<T>[] {
  const scores = new Map<string | number, ReciprocalRankResult<T>>();

  fts.forEach((result, index) => {
    const current = scores.get(result.id);
    scores.set(result.id, {
      id: result.id,
      item: current?.item ?? result.item,
      source: current?.source ?? result.source,
      score: (current?.score ?? 0) + 1 / (k + index + 1),
    });
  });

  vector.forEach((result, index) => {
    const current = scores.get(result.id);
    scores.set(result.id, {
      id: result.id,
      item: current?.item ?? result.item,
      source: current?.source ?? result.source,
      score: (current?.score ?? 0) + 1 / (k + index + 1),
    });
  });

  const ranked = [...scores.values()].sort((left, right) => right.score - left.score);
  const topScore = ranked[0]?.score ?? 0;
  if (topScore <= 0) {
    return ranked;
  }
  return ranked.map((entry) => ({
    ...entry,
    score: entry.score / topScore,
  }));
}
