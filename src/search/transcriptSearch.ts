import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { HomeDb } from '../home/db.js';
import { loadTranscript } from '../trace/parse.js';
import { reduceTranscript } from '../trace/reduce.js';
import { buildChunks, type Chunk } from './transcriptChunk.js';
import { EMBED_BATCH_SIZE, embedBatch, embedQuery } from './transcriptEmbed.js';
import { reciprocalRankFuse, type FusedHit, type RrfWeights } from './transcriptRrf.js';
import { prepareFtsQuery } from './transcriptTokenize.js';

type DatabaseType = HomeDb['db'];

export type TranscriptSearchScope = 'workspace' | 'session' | 'self' | 'all' | 'identity';

export interface TranscriptFileRef {
  path: string;
  sessionId: string;
  cwdSlug: string;
}

export interface TranscriptIndexOptions {
  homeDb: HomeDb;
  cwd: string;
  identityName?: string;
  sessionId?: string;
  sourcePath?: string;
  embedBudget?: number;
  skipEmbed?: boolean;
  indexIdentityName?: string;
}

export interface TranscriptIndexResult {
  filesScanned: number;
  filesChanged: number;
  chunksUpserted: number;
  embeddingsAdded: number;
  vectorEnabled: boolean;
}

export interface TranscriptSearchOptions {
  homeDb: HomeDb;
  query: string;
  k?: number;
  candidatePool?: number;
  scope?: TranscriptSearchScope;
  identityName?: string;
  indexIdentityName?: string;
  sessionId?: string;
  sessionIds?: string[];
  cwd?: string;
  weights?: RrfWeights;
  ensureIndex?: boolean;
  skipEmbed?: boolean;
}

export interface TranscriptSearchHit {
  chunkId: string;
  rowId: number;
  sessionId: string;
  identityName: string | null;
  cwd: string | null;
  kind: string;
  toolName?: string;
  filePaths: string[];
  timestampMs: number;
  text: string;
  sourcePath?: string;
  fusedScore: number;
  bm25Rank: number | null;
  vectorRank: number | null;
}

export interface TranscriptSearchResult {
  query: string;
  scope: TranscriptSearchScope;
  hits: TranscriptSearchHit[];
  stats: {
    bm25Candidates: number;
    vectorCandidates: number;
    fusedCandidates: number;
    indexed?: TranscriptIndexResult;
  };
}

interface Bm25Hit {
  chunkId: string;
  rank: number;
  score: number;
}

interface VectorHit {
  chunkId: string;
  rank: number;
  distance: number;
}

interface StoredTranscriptChunk {
  id: number;
  chunk_id: string | null;
  session_id: string;
  identity_name: string | null;
  cwd: string | null;
  turn_index: number;
  role: string;
  tool_name: string | null;
  text: string;
  file_paths_json: string;
  ts: number;
  source_path: string | null;
}

const DEFAULT_K = 8;
const DEFAULT_CANDIDATE_POOL = 50;
const DEFAULT_EMBED_BUDGET = 200;

export function claudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

export function cwdToProjectSlug(cwd: string): string {
  return cwd.replaceAll('/', '-').replace(/^-/, '-');
}

export function listProjectTranscripts(cwd: string): TranscriptFileRef[] {
  const slug = cwdToProjectSlug(cwd);
  const dir = join(claudeProjectsDir(), slug);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => ({
      path: join(dir, entry),
      sessionId: entry.replace(/\.jsonl$/, ''),
      cwdSlug: slug,
    }));
}

export function listAllTranscripts(): TranscriptFileRef[] {
  const root = claudeProjectsDir();
  if (!existsSync(root)) return [];

  const out: TranscriptFileRef[] = [];
  for (const slug of readdirSync(root)) {
    const dir = join(root, slug);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      out.push({
        path: join(dir, entry),
        sessionId: entry.replace(/\.jsonl$/, ''),
        cwdSlug: slug,
      });
    }
  }
  return out;
}

export function newestTranscriptForCwd(cwd: string): TranscriptFileRef | null {
  const transcripts = listProjectTranscripts(cwd)
    .map((entry) => {
      try {
        return { entry, mtimeMs: statSync(entry.path).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry): entry is { entry: TranscriptFileRef; mtimeMs: number } => entry !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  return transcripts[0]?.entry ?? null;
}

export async function indexTranscriptFile(
  opts: TranscriptIndexOptions & { file: TranscriptFileRef },
): Promise<TranscriptIndexResult> {
  const result: TranscriptIndexResult = {
    filesScanned: 1,
    filesChanged: 0,
    chunksUpserted: 0,
    embeddingsAdded: 0,
    vectorEnabled: opts.homeDb.hasVector,
  };

  const rows = await loadTranscript(opts.file.path);
  if (rows.length === 0) return result;

  const reduced = reduceTranscript(rows);
  const chunks = buildChunks({
    events: reduced.events,
    sessionId: opts.file.sessionId,
    cwdSlug: opts.file.cwdSlug,
    sourcePath: opts.file.path,
  });
  if (chunks.length === 0) return result;

  result.filesChanged = 1;
  result.chunksUpserted = upsertHomeChunks(opts.homeDb.db, {
    chunks,
    cwd: opts.cwd,
    identityName: opts.identityName,
  });

  if (!opts.skipEmbed && opts.homeDb.hasVector) {
    result.embeddingsAdded = await backfillTranscriptEmbeddings(opts.homeDb.db, opts.embedBudget ?? DEFAULT_EMBED_BUDGET);
  }

  return result;
}

export async function ensureTranscriptIndex(opts: TranscriptIndexOptions): Promise<TranscriptIndexResult> {
  const files = opts.sourcePath
    ? [{
        path: opts.sourcePath,
        sessionId: opts.sessionId ?? opts.sourcePath.split('/').pop()?.replace(/\.jsonl$/, '') ?? 'unknown',
        cwdSlug: cwdToProjectSlug(opts.cwd),
      }]
    : opts.sessionId
      ? listProjectTranscripts(opts.cwd).filter((entry) => entry.sessionId === opts.sessionId)
      : listProjectTranscripts(opts.cwd);

  const aggregate: TranscriptIndexResult = {
    filesScanned: 0,
    filesChanged: 0,
    chunksUpserted: 0,
    embeddingsAdded: 0,
    vectorEnabled: opts.homeDb.hasVector,
  };

  for (const file of files) {
    const partial = await indexTranscriptFile({ ...opts, file });
    aggregate.filesScanned += partial.filesScanned;
    aggregate.filesChanged += partial.filesChanged;
    aggregate.chunksUpserted += partial.chunksUpserted;
    aggregate.embeddingsAdded += partial.embeddingsAdded;
  }

  return aggregate;
}

export async function searchTranscripts(opts: TranscriptSearchOptions): Promise<TranscriptSearchResult> {
  const scope = opts.scope ?? 'workspace';
  const candidatePool = opts.candidatePool ?? DEFAULT_CANDIDATE_POOL;
  const k = opts.k ?? DEFAULT_K;

  let indexed: TranscriptIndexResult | undefined;
  if (opts.ensureIndex !== false && opts.cwd) {
    indexed = await ensureTranscriptIndex({
      homeDb: opts.homeDb,
      cwd: opts.cwd,
      identityName: opts.indexIdentityName ?? opts.identityName,
      sessionId: scope === 'session' ? opts.sessionId : undefined,
      embedBudget: candidatePool,
      skipEmbed: opts.skipEmbed,
    });
  }

  const bm25Hits = bm25Search(opts.homeDb.db, opts, candidatePool);
  const vectorHits = opts.skipEmbed || !opts.homeDb.hasVector
    ? []
    : await vectorSearch(opts.homeDb.db, opts, candidatePool);

  const fused = reciprocalRankFuse({
    bm25Hits,
    vectorHits,
    weights: opts.weights,
    limit: k,
  });
  const rows = hydrateChunks(opts.homeDb.db, fused.map((hit) => hit.chunkId));
  const rowByChunk = new Map(rows.map((row) => [row.chunk_id ?? String(row.id), row]));

  return {
    query: opts.query,
    scope,
    hits: fused.flatMap((hit) => {
      const row = rowByChunk.get(hit.chunkId);
      if (!row) return [];
      return [formatHit(row, hit)];
    }),
    stats: {
      bm25Candidates: bm25Hits.length,
      vectorCandidates: vectorHits.length,
      fusedCandidates: fused.length,
      indexed,
    },
  };
}

function upsertHomeChunks(
  db: DatabaseType,
  opts: { chunks: Chunk[]; cwd: string; identityName?: string },
): number {
  const selectExisting = db.prepare('SELECT id, text_hash FROM transcript_chunks WHERE chunk_id = ?');
  const insert = db.prepare(`
    INSERT INTO transcript_chunks (
      session_id, identity_name, cwd, turn_index, role, tool_name, text,
      file_paths_json, ts, chunk_id, text_hash, source_path, has_vector
    ) VALUES (
      @session_id, @identity_name, @cwd, @turn_index, @role, @tool_name, @text,
      @file_paths_json, @ts, @chunk_id, @text_hash, @source_path, 0
    )
  `);
  const update = db.prepare(`
    UPDATE transcript_chunks
    SET session_id = @session_id,
        identity_name = @identity_name,
        cwd = @cwd,
        turn_index = @turn_index,
        role = @role,
        tool_name = @tool_name,
        text = @text,
        file_paths_json = @file_paths_json,
        ts = @ts,
        text_hash = @text_hash,
        source_path = @source_path,
        has_vector = CASE WHEN text_hash = @text_hash THEN has_vector ELSE 0 END
    WHERE chunk_id = @chunk_id
  `);

  const run = db.transaction((chunks: Chunk[]) => {
    let changed = 0;
    for (const chunk of chunks) {
      const prior = selectExisting.get(chunk.chunkId) as { id: number; text_hash: string } | undefined;
      const payload = {
        session_id: chunk.sessionId,
        identity_name: opts.identityName ?? null,
        cwd: opts.cwd,
        turn_index: chunkOrdinal(chunk.chunkId),
        role: roleFromChunkKind(chunk.kind),
        tool_name: chunk.toolName ?? null,
        text: chunk.text,
        file_paths_json: JSON.stringify(chunk.filePaths),
        ts: chunk.timestampMs,
        chunk_id: chunk.chunkId,
        text_hash: chunk.textHash,
        source_path: chunk.sourcePath,
      };

      if (prior) {
        update.run(payload);
        if (prior.text_hash !== chunk.textHash) changed += 1;
      } else {
        insert.run(payload);
        changed += 1;
      }
    }
    return changed;
  });

  return run(opts.chunks) as number;
}

async function backfillTranscriptEmbeddings(db: DatabaseType, limit: number): Promise<number> {
  ensureTranscriptVectorTable(db);
  const rows = db.prepare(`
    SELECT id, text
    FROM transcript_chunks
    WHERE has_vector = 0
    ORDER BY ts DESC
    LIMIT ?
  `).all(limit) as Array<{ id: number; text: string }>;

  let written = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedBatch(batch.map((row) => row.text), 'RETRIEVAL_DOCUMENT');
    const mark = db.prepare('UPDATE transcript_chunks SET has_vector = 1 WHERE id = ?');
    const runBatch = db.transaction((items: Array<{ id: number; vector: Float32Array }>) => {
      for (const item of items) {
        if (!Number.isInteger(item.id) || item.id <= 0) continue;
        db.prepare(`DELETE FROM transcript_chunk_embeddings WHERE rowid = ${item.id}`).run();
        db.prepare(`INSERT INTO transcript_chunk_embeddings(rowid, embedding) VALUES (${item.id}, ?)`).run(
          Buffer.from(item.vector.buffer, item.vector.byteOffset, item.vector.byteLength),
        );
        mark.run(item.id);
        written += 1;
      }
    });
    runBatch(batch.flatMap((row, index) => {
      const vector = vectors[index];
      return vector ? [{ id: row.id, vector }] : [];
    }));
  }
  return written;
}

function ensureTranscriptVectorTable(db: DatabaseType): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS transcript_chunk_embeddings USING vec0(
      embedding float[384]
    );
  `);
}

function bm25Search(db: DatabaseType, opts: TranscriptSearchOptions, limit: number): Bm25Hit[] {
  const fts = prepareFtsQuery(opts.query);
  if (!fts) return [];
  const filter = buildWhereFilters(opts, 'c');
  const rows = db.prepare(`
    SELECT c.chunk_id, c.id, bm25(transcript_chunks_fts) AS score
    FROM transcript_chunks_fts
    JOIN transcript_chunks c ON c.id = transcript_chunks_fts.rowid
    WHERE transcript_chunks_fts MATCH ?
      ${filter.sql}
    ORDER BY score
    LIMIT ?
  `).all(fts, ...filter.params, limit) as Array<{ chunk_id: string | null; id: number; score: number }>;

  return rows.map((row, index) => ({
    chunkId: row.chunk_id ?? String(row.id),
    rank: index + 1,
    score: row.score,
  }));
}

async function vectorSearch(db: DatabaseType, opts: TranscriptSearchOptions, limit: number): Promise<VectorHit[]> {
  try {
    ensureTranscriptVectorTable(db);
    const vector = await embedQuery(opts.query);
    const rows = db.prepare(`
      SELECT rowid, distance
      FROM transcript_chunk_embeddings
      WHERE embedding MATCH ? AND k = ?
    `).all(Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength), Math.max(limit * 3, limit)) as Array<{
      rowid: number;
      distance: number;
    }>;
    if (rows.length === 0) return [];

    const hydrated = hydrateChunksById(db, rows.map((row) => row.rowid));
    const rowById = new Map(hydrated.map((row) => [row.id, row]));
    const filtered: VectorHit[] = [];
    for (const row of rows) {
      const chunk = rowById.get(row.rowid);
      if (!chunk || !matchesFilters(chunk, opts)) continue;
      filtered.push({
        chunkId: chunk.chunk_id ?? String(chunk.id),
        rank: filtered.length + 1,
        distance: row.distance,
      });
      if (filtered.length >= limit) break;
    }
    return filtered;
  } catch {
    return [];
  }
}

function hydrateChunks(db: DatabaseType, chunkIds: string[]): StoredTranscriptChunk[] {
  if (chunkIds.length === 0) return [];
  const placeholders = chunkIds.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, chunk_id, session_id, identity_name, cwd, turn_index, role,
           tool_name, text, file_paths_json, ts, source_path
    FROM transcript_chunks
    WHERE COALESCE(chunk_id, CAST(id AS TEXT)) IN (${placeholders})
  `).all(...chunkIds) as StoredTranscriptChunk[];
}

function hydrateChunksById(db: DatabaseType, ids: number[]): StoredTranscriptChunk[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  return db.prepare(`
    SELECT id, chunk_id, session_id, identity_name, cwd, turn_index, role,
           tool_name, text, file_paths_json, ts, source_path
    FROM transcript_chunks
    WHERE id IN (${placeholders})
  `).all(...ids) as StoredTranscriptChunk[];
}

function buildWhereFilters(opts: TranscriptSearchOptions, alias: string): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.identityName) {
    clauses.push(`${alias}.identity_name = ?`);
    params.push(opts.identityName);
  }
  if (opts.sessionId) {
    clauses.push(`${alias}.session_id = ?`);
    params.push(opts.sessionId);
  }
  if (opts.sessionIds && opts.sessionIds.length > 0) {
    clauses.push(`${alias}.session_id IN (${opts.sessionIds.map(() => '?').join(', ')})`);
    params.push(...opts.sessionIds);
  }
  if (opts.cwd && (opts.scope ?? 'workspace') === 'workspace') {
    clauses.push(`${alias}.cwd = ?`);
    params.push(opts.cwd);
  }
  return {
    sql: clauses.length > 0 ? `AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function matchesFilters(row: StoredTranscriptChunk, opts: TranscriptSearchOptions): boolean {
  if (opts.identityName && row.identity_name !== opts.identityName) return false;
  if (opts.sessionId && row.session_id !== opts.sessionId) return false;
  if (opts.sessionIds && opts.sessionIds.length > 0 && !opts.sessionIds.includes(row.session_id)) return false;
  if (opts.cwd && (opts.scope ?? 'workspace') === 'workspace' && row.cwd !== opts.cwd) return false;
  return true;
}

function formatHit(row: StoredTranscriptChunk, hit: FusedHit): TranscriptSearchHit {
  return {
    chunkId: row.chunk_id ?? String(row.id),
    rowId: row.id,
    sessionId: row.session_id,
    identityName: row.identity_name,
    cwd: row.cwd,
    kind: row.role,
    toolName: row.tool_name ?? undefined,
    filePaths: parseJsonArray(row.file_paths_json),
    timestampMs: row.ts,
    text: row.text,
    sourcePath: row.source_path ?? undefined,
    fusedScore: hit.fusedScore,
    bm25Rank: hit.bm25Rank,
    vectorRank: hit.vectorRank,
  };
}

function roleFromChunkKind(kind: Chunk['kind']): string {
  switch (kind) {
    case 'assistant':
      return 'assistant';
    case 'tool_call':
      return 'tool';
    case 'hook':
      return 'system';
    case 'user':
    default:
      return 'user';
  }
}

function chunkOrdinal(chunkId: string): number {
  const raw = chunkId.split(':').pop();
  const n = raw ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}
