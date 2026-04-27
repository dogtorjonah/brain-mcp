/**
 * SQLite store for the transcript search index.
 *
 * Schema (three logical layers, one physical database):
 *
 *   1. chunks — source of truth. One row per semantic event (user turn,
 *      assistant turn, tool_use+result pair, hook). Drives both retrievers.
 *
 *   2. chunks_fts — FTS5 external-content mirror over chunks.text. BM25
 *      ranking comes free from FTS5 (no custom postings / IDF bookkeeping).
 *      External-content means the virtual table doesn't duplicate storage —
 *      it points at chunks.text via rowid. We sync explicitly (not via
 *      triggers) because bulk upserts with triggers are slow and harder to
 *      reason about when deletes + inserts need to interleave.
 *
 *   3. chunks_vec — sqlite-vec vec0 virtual table for kNN on 384-dim float
 *      embeddings. Separate from chunks so kNN stays lean (no metadata cols).
 *      Joined back via rowid = chunks.rowid.
 *
 * File-scan metadata (scanned_files) tracks .jsonl mtime + row count so the
 * indexer can re-read only the tail of a file that grew since last pass —
 * critical for searching the live session while it's still being written.
 *
 * The sqlite-vec extension is loaded at open time. If loading fails the
 * database is still usable for BM25-only fallback — the search layer checks
 * `hasVector()` before attempting vec queries.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { EMBED_DIM } from './transcriptEmbed.js';
import type { Chunk } from './transcriptChunk.js';

type DatabaseType = InstanceType<typeof Database>;

export interface ScannedFile {
  path: string;
  mtimeMs: number;
  size: number;
  lastRowCount: number;
  sessionId: string | null;
}

export interface Bm25Hit {
  chunkId: string;
  rank: number; // 1-based rank within this result set (lower = more relevant)
  score: number; // FTS5 bm25() score (lower = more relevant in FTS5 convention)
}

export interface VectorHit {
  chunkId: string;
  rank: number; // 1-based rank within this result set
  distance: number; // cosine distance from query vector (lower = closer)
}

export interface StoreOpenOptions {
  /** Absolute path to the sqlite file. Parent dir is created if missing. */
  path: string;
}

export class SearchStore {
  private readonly db: DatabaseType;
  private readonly vectorEnabled: boolean;

  private constructor(db: DatabaseType, vectorEnabled: boolean) {
    this.db = db;
    this.vectorEnabled = vectorEnabled;
  }

  static open(opts: StoreOpenOptions): SearchStore {
    mkdirSync(dirname(opts.path), { recursive: true });
    const db = new Database(opts.path);
    // WAL is load-bearing for concurrent indexer + query reads: the live
    // session's jsonl is appended to while the user is searching. Without
    // WAL the reader blocks whenever the indexer starts a write txn.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    // foreign_keys stays off — we manage refs manually and want soft-refs
    // between the three chunk-related tables (delete chunks row, rely on
    // our delete hooks to clean fts + vec rows).

    let vectorEnabled = false;
    try {
      sqliteVec.load(db);
      vectorEnabled = true;
    } catch (err) {
      // Non-fatal. BM25-only mode is still useful — many queries are
      // literal-string heavy (file paths, tool names, error tokens) and
      // BM25 hits those well without the dense side.
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[brain-mcp/transcript-store] sqlite-vec unavailable, running BM25-only: ${msg}`);
    }

    const store = new SearchStore(db, vectorEnabled);
    store.applySchema();
    return store;
  }

  hasVector(): boolean {
    return this.vectorEnabled;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Idempotent schema setup. Safe to call on every open; CREATE IF NOT
   * EXISTS for both plain and virtual tables means no-op on warm DBs.
   * The vec0 table's dim is baked in at creation; if EMBED_DIM ever
   * changes the caller MUST drop the index first.
   */
  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chunks (
        chunk_id       TEXT NOT NULL UNIQUE,
        session_id     TEXT NOT NULL,
        cwd_slug       TEXT NOT NULL,
        kind           TEXT NOT NULL,
        tool_name      TEXT,
        file_paths     TEXT NOT NULL DEFAULT '[]',  -- JSON array
        timestamp_ms   INTEGER NOT NULL,
        text           TEXT NOT NULL,
        text_hash      TEXT NOT NULL,
        source_path    TEXT NOT NULL,
        has_vector     INTEGER NOT NULL DEFAULT 0   -- tracks chunks_vec sync
      );

      CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(session_id);
      CREATE INDEX IF NOT EXISTS idx_chunks_cwd ON chunks(cwd_slug);
      CREATE INDEX IF NOT EXISTS idx_chunks_ts ON chunks(timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS idx_chunks_hash ON chunks(text_hash);
      CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source_path);

      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
        text,
        content='chunks',
        content_rowid='rowid',
        tokenize='porter unicode61 remove_diacritics 1'
      );

      CREATE TABLE IF NOT EXISTS scanned_files (
        path           TEXT PRIMARY KEY,
        mtime_ms       INTEGER NOT NULL,
        size           INTEGER NOT NULL,
        last_row_count INTEGER NOT NULL DEFAULT 0,
        session_id     TEXT
      );
    `);

    if (this.vectorEnabled) {
      // vec0 virtual table creation is idempotent via IF NOT EXISTS, but
      // sqlite-vec's grammar accepts the dim as part of the column type.
      // Keep the schema inline with EMBED_DIM so a mismatch is obvious.
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
          embedding float[${EMBED_DIM}]
        );
      `);
    }
  }

  // ---------- chunk upsert / query ----------

  /** Map chunk_id → {rowid, text_hash, has_vector} for dedup at index time. */
  getExistingChunkIndex(cwdSlug?: string): Map<string, { rowid: number; textHash: string; hasVector: boolean }> {
    const rows = cwdSlug
      ? this.db.prepare('SELECT rowid, chunk_id, text_hash, has_vector FROM chunks WHERE cwd_slug = ?').all(cwdSlug)
      : this.db.prepare('SELECT rowid, chunk_id, text_hash, has_vector FROM chunks').all();
    const map = new Map<string, { rowid: number; textHash: string; hasVector: boolean }>();
    for (const r of rows as Array<{ rowid: number; chunk_id: string; text_hash: string; has_vector: number }>) {
      map.set(r.chunk_id, { rowid: r.rowid, textHash: r.text_hash, hasVector: r.has_vector === 1 });
    }
    return map;
  }

  /**
   * Upsert a batch of chunks. Runs in a single transaction; FTS5 is
   * kept in sync with an explicit delete-then-insert pattern (matches
   * external-content virtual-table semantics).
   *
   * Returns rowids for every chunk in the same order as the input, so the
   * caller can pair vectors with rowids for the chunks_vec upsert.
   */
  upsertChunks(chunks: Chunk[]): number[] {
    if (chunks.length === 0) return [];

    const selectRowid = this.db.prepare('SELECT rowid FROM chunks WHERE chunk_id = ?');
    const deleteFts = this.db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES (?, ?, ?)');
    const insertFts = this.db.prepare('INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)');

    const upsert = this.db.prepare(`
      INSERT INTO chunks (
        chunk_id, session_id, cwd_slug, kind, tool_name, file_paths,
        timestamp_ms, text, text_hash, source_path, has_vector
      ) VALUES (
        @chunk_id, @session_id, @cwd_slug, @kind, @tool_name, @file_paths,
        @timestamp_ms, @text, @text_hash, @source_path,
        COALESCE((SELECT has_vector FROM chunks WHERE chunk_id = @chunk_id), 0)
      )
      ON CONFLICT(chunk_id) DO UPDATE SET
        session_id   = excluded.session_id,
        cwd_slug     = excluded.cwd_slug,
        kind         = excluded.kind,
        tool_name    = excluded.tool_name,
        file_paths   = excluded.file_paths,
        timestamp_ms = excluded.timestamp_ms,
        text         = excluded.text,
        text_hash    = excluded.text_hash,
        source_path  = excluded.source_path,
        has_vector   = CASE
          WHEN chunks.text_hash = excluded.text_hash THEN chunks.has_vector
          ELSE 0
        END
    `);

    const rowids: number[] = [];

    const runBatch = this.db.transaction((batch: Chunk[]) => {
      for (const c of batch) {
        // Capture pre-existing rowid + text for FTS delete if present
        const prior = selectRowid.get(c.chunkId) as { rowid: number } | undefined;
        if (prior) {
          // External-content FTS5 delete trick: pass 'delete' as first
          // argument, then rowid + old text. We don't have the old text
          // handy; the safer generic form is the 'delete-all' command
          // followed by re-insert, but that's a full reindex. Instead,
          // fetch the old text for this single row.
          const oldRow = this.db.prepare('SELECT text FROM chunks WHERE rowid = ?').get(prior.rowid) as
            | { text: string } | undefined;
          if (oldRow) {
            deleteFts.run('delete', prior.rowid, oldRow.text);
          }
        }

        upsert.run({
          chunk_id: c.chunkId,
          session_id: c.sessionId,
          cwd_slug: c.cwdSlug,
          kind: c.kind,
          tool_name: c.toolName ?? null,
          file_paths: JSON.stringify(c.filePaths),
          timestamp_ms: c.timestampMs,
          text: c.text,
          text_hash: c.textHash,
          source_path: c.sourcePath,
        });

        const row = selectRowid.get(c.chunkId) as { rowid: number };
        rowids.push(row.rowid);
        insertFts.run(row.rowid, c.text);
      }
    });

    runBatch(chunks);
    return rowids;
  }

  /**
   * Write a batch of embedding vectors for chunks that were previously
   * upserted. Clears any stale vec0 row first (rowid collision is
   * impossible in practice, but the clear keeps the code simple).
   */
  upsertVectors(pairs: Array<{ rowid: number; vector: Float32Array }>): void {
    if (!this.vectorEnabled || pairs.length === 0) return;

    // sqlite-vec's vec0 virtual table is strict about the primary-key
    // rowid: it must be a LITERAL integer in the SQL, not a bound
    // parameter. Bind variables get normalised through SQLite's type
    // system and come out as "not integer" to vec0's strict check. We
    // interpolate rowid into the statement text and prepare per-row;
    // this is safe because rowid is only ever a Number we derived from
    // an AUTOINCREMENT column we control, not user input. better-sqlite3
    // caches the underlying VM bytecode for identical statements, so
    // the per-row prepare cost is small in steady state.
    const mark = this.db.prepare('UPDATE chunks SET has_vector = 1 WHERE rowid = ?');

    const runBatch = this.db.transaction((items: typeof pairs) => {
      for (const p of items) {
        const rid = Number(p.rowid);
        if (!Number.isInteger(rid) || rid <= 0) {
          throw new Error(`[brain-mcp/transcript-store] invalid vec rowid: ${p.rowid}`);
        }
        // Literal rowid. Buffer is still a bind parameter.
        this.db.prepare(`DELETE FROM chunks_vec WHERE rowid = ${rid}`).run();
        this.db
          .prepare(`INSERT INTO chunks_vec(rowid, embedding) VALUES (${rid}, ?)`)
          .run(Buffer.from(p.vector.buffer, p.vector.byteOffset, p.vector.byteLength));
        mark.run(rid);
      }
    });

    runBatch(pairs);
  }

  /** Chunks that still need an embedding (has_vector = 0). */
  getChunksNeedingVectors(limit = 500): Array<{ rowid: number; text: string }> {
    return this.db
      .prepare('SELECT rowid, text FROM chunks WHERE has_vector = 0 ORDER BY timestamp_ms DESC LIMIT ?')
      .all(limit) as Array<{ rowid: number; text: string }>;
  }

  // ---------- retrieval ----------

  /**
   * BM25 search via FTS5 MATCH. The caller is responsible for preparing
   * the query expression via prepareFtsQuery — passing a raw user string
   * will break on FTS5-reserved punctuation.
   */
  bm25Search(opts: {
    ftsQuery: string;
    limit: number;
    sessionFilter?: string;
    /**
     * Multi-session filter — used by scope='self' (chain of ancestor
     * sessionIds). Takes precedence over `sessionFilter` when both set.
     * An empty array is treated as "no sessions matched" and returns no
     * hits rather than an unfiltered query, which would be a footgun.
     */
    sessionFilters?: string[];
    cwdFilter?: string;
  }): Bm25Hit[] {
    const clauses: string[] = ['chunks_fts MATCH ?'];
    const params: unknown[] = [opts.ftsQuery];
    if (opts.sessionFilters) {
      if (opts.sessionFilters.length === 0) return [];
      const placeholders = opts.sessionFilters.map(() => '?').join(',');
      clauses.push(`c.session_id IN (${placeholders})`);
      params.push(...opts.sessionFilters);
    } else if (opts.sessionFilter) {
      clauses.push('c.session_id = ?');
      params.push(opts.sessionFilter);
    }
    if (opts.cwdFilter) {
      clauses.push('c.cwd_slug = ?');
      params.push(opts.cwdFilter);
    }
    params.push(opts.limit);

    const sql = `
      SELECT c.chunk_id AS chunk_id, bm25(chunks_fts) AS score
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      WHERE ${clauses.join(' AND ')}
      ORDER BY score ASC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; score: number }>;
    return rows.map((r, i) => ({ chunkId: r.chunk_id, rank: i + 1, score: r.score }));
  }

  /**
   * kNN search via sqlite-vec. Returns empty if vector support is unavailable.
   * Post-filters by session/cwd after kNN — vec0's MATCH clause doesn't
   * natively support metadata filters, and filtering post-hoc is fine at
   * kNN magnitudes (k=50-200).
   */
  vectorSearch(opts: {
    queryVector: Float32Array;
    limit: number;
    sessionFilter?: string;
    /** See `bm25Search.sessionFilters` — same semantics. */
    sessionFilters?: string[];
    cwdFilter?: string;
    oversample?: number;
  }): VectorHit[] {
    if (!this.vectorEnabled) return [];
    if (opts.sessionFilters && opts.sessionFilters.length === 0) return [];

    const oversample = opts.oversample ?? 3;
    const k = Math.max(opts.limit * oversample, opts.limit);
    const buf = Buffer.from(opts.queryVector.buffer, opts.queryVector.byteOffset, opts.queryVector.byteLength);

    // Filter clauses are post-kNN predicates on the joined chunks row —
    // sqlite-vec's MATCH clause doesn't filter, it defines the kNN; we
    // oversample by 3x to leave headroom for the post-filter without
    // under-recalling. With a large chain (scope='self' across many
    // rebirths), post-filtering can cull all kNN results — bump oversample
    // when sessionFilters is big to compensate.
    const filterClauses: string[] = [];
    const filterParams: unknown[] = [];
    if (opts.sessionFilters) {
      const placeholders = opts.sessionFilters.map(() => '?').join(',');
      filterClauses.push(`c.session_id IN (${placeholders})`);
      filterParams.push(...opts.sessionFilters);
    } else if (opts.sessionFilter) {
      filterClauses.push('c.session_id = ?');
      filterParams.push(opts.sessionFilter);
    }
    if (opts.cwdFilter) {
      filterClauses.push('c.cwd_slug = ?');
      filterParams.push(opts.cwdFilter);
    }

    // sqlite-vec requires `k` as a literal integer in the SQL (same
    // strictness as rowid on inserts — bind params aren't accepted).
    const safeK = Number.isInteger(k) && k > 0 ? k : 10;
    const filterSql = filterClauses.length > 0 ? 'AND ' + filterClauses.join(' AND ') : '';
    const sql = `
      SELECT c.chunk_id AS chunk_id, v.distance AS distance
      FROM chunks_vec v
      JOIN chunks c ON c.rowid = v.rowid
      WHERE v.embedding MATCH ?
        AND k = ${safeK}
        ${filterSql}
      ORDER BY v.distance ASC
      LIMIT ?
    `;

    const params: unknown[] = [buf, ...filterParams, opts.limit];
    const rows = this.db.prepare(sql).all(...params) as Array<{ chunk_id: string; distance: number }>;
    return rows.map((r, i) => ({ chunkId: r.chunk_id, rank: i + 1, distance: r.distance }));
  }

  /** Hydrate chunk rows by id — used after fusion to assemble hit payloads. */
  getChunksByIds(chunkIds: string[]): Map<string, StoredChunk> {
    const map = new Map<string, StoredChunk>();
    if (chunkIds.length === 0) return map;

    // SQLite has a parameter limit (999 by default); batch conservatively.
    const BATCH = 500;
    for (let i = 0; i < chunkIds.length; i += BATCH) {
      const slice = chunkIds.slice(i, i + BATCH);
      const placeholders = slice.map(() => '?').join(',');
      const rows = this.db
        .prepare(`
          SELECT chunk_id, session_id, cwd_slug, kind, tool_name, file_paths,
                 timestamp_ms, text, text_hash, source_path
          FROM chunks
          WHERE chunk_id IN (${placeholders})
        `)
        .all(...slice) as Array<{
          chunk_id: string;
          session_id: string;
          cwd_slug: string;
          kind: string;
          tool_name: string | null;
          file_paths: string;
          timestamp_ms: number;
          text: string;
          text_hash: string;
          source_path: string;
        }>;
      for (const r of rows) {
        map.set(r.chunk_id, {
          chunkId: r.chunk_id,
          sessionId: r.session_id,
          cwdSlug: r.cwd_slug,
          kind: r.kind as StoredChunk['kind'],
          toolName: r.tool_name ?? undefined,
          filePaths: safeParseJsonArray(r.file_paths),
          timestampMs: r.timestamp_ms,
          text: r.text,
          textHash: r.text_hash,
          sourcePath: r.source_path,
        });
      }
    }
    return map;
  }

  // ---------- scanned-file bookkeeping ----------

  getScannedFile(path: string): ScannedFile | null {
    const row = this.db.prepare(
      'SELECT path, mtime_ms, size, last_row_count, session_id FROM scanned_files WHERE path = ?',
    ).get(path) as { path: string; mtime_ms: number; size: number; last_row_count: number; session_id: string | null } | undefined;
    if (!row) return null;
    return {
      path: row.path,
      mtimeMs: row.mtime_ms,
      size: row.size,
      lastRowCount: row.last_row_count,
      sessionId: row.session_id,
    };
  }

  upsertScannedFile(entry: ScannedFile): void {
    this.db.prepare(`
      INSERT INTO scanned_files(path, mtime_ms, size, last_row_count, session_id)
      VALUES (@path, @mtime, @size, @rows, @session)
      ON CONFLICT(path) DO UPDATE SET
        mtime_ms       = excluded.mtime_ms,
        size           = excluded.size,
        last_row_count = excluded.last_row_count,
        session_id     = excluded.session_id
    `).run({
      path: entry.path,
      mtime: entry.mtimeMs,
      size: entry.size,
      rows: entry.lastRowCount,
      session: entry.sessionId,
    });
  }

  /**
   * Remove chunks + fts + vec rows for a source that no longer exists on
   * disk (e.g. user deleted a .jsonl). Called during reindex sweeps.
   */
  forgetSource(sourcePath: string): void {
    const selectRow = this.db.prepare('SELECT rowid, text FROM chunks WHERE source_path = ?');
    const delChunk = this.db.prepare('DELETE FROM chunks WHERE rowid = ?');
    const delFts = this.db.prepare('INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES (?, ?, ?)');
    const delVec = this.vectorEnabled
      ? this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?')
      : null;
    const delScan = this.db.prepare('DELETE FROM scanned_files WHERE path = ?');

    const run = this.db.transaction(() => {
      const rows = selectRow.all(sourcePath) as Array<{ rowid: number; text: string }>;
      for (const r of rows) {
        delFts.run('delete', r.rowid, r.text);
        if (delVec) delVec.run(r.rowid);
        delChunk.run(r.rowid);
      }
      delScan.run(sourcePath);
    });
    run();
  }
}

export interface StoredChunk {
  chunkId: string;
  sessionId: string;
  cwdSlug: string;
  kind: 'user' | 'assistant' | 'tool_call' | 'hook';
  toolName?: string;
  filePaths: string[];
  timestampMs: number;
  text: string;
  textHash: string;
  sourcePath: string;
}

function safeParseJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
