/**
 * Local Embedding Client
 *
 * Thin wrapper around `@huggingface/transformers` feature extraction:
 *   - Local inference after the model is downloaded and cached.
 *   - Batched embedding calls.
 *   - Retry-with-exponential-backoff on transient load/runtime failures.
 *   - Per-call timeout so cold starts fail cleanly instead of hanging forever.
 *   - Retrieval-model-specific query prefixing via `embedQuery()`.
 *
 * Two execution modes:
 *   - **Inline (default):** `@huggingface/transformers` runs on the main
 *     thread. Simple; blocks the event loop during ONNX inference (~100-300ms
 *     per batch of 16). Fine for low-throughput tap queries.
 *   - **Worker (`RELAY_EMBED_WORKER=1`):** delegate to a long-lived
 *     `node:worker_threads` worker (see `embedWorker.ts`) so the main thread
 *     stays responsive under multi-agent load or during large ingest
 *     backfills. The worker caches the extractor across requests and
 *     transfers Float32Array buffers zero-copy.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { DenseEmbedConfig, EmbedTaskType } from './types.js';

/**
 * Set `RELAY_EMBED_WORKER=1` to route all embedBatch/embedQuery calls
 * through a dedicated worker thread. Default off — inline mode.
 */
const USE_WORKER = process.env.RELAY_EMBED_WORKER === '1';

type ExtractorResult = {
  data: Float32Array | number[];
  dims?: number[];
};

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<ExtractorResult>;

let cachedModelId: string | null = null;
let cachedExtractor: FeatureExtractor | null = null;

async function getExtractor(config: DenseEmbedConfig): Promise<FeatureExtractor> {
  if (cachedExtractor && cachedModelId === config.model) {
    return cachedExtractor;
  }
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = await pipeline('feature-extraction', config.model, {
    dtype: 'fp32',
  });
  cachedModelId = config.model;
  cachedExtractor = extractor as FeatureExtractor;
  return cachedExtractor;
}

/** Reset the cached client — for tests only. */
export function __resetEmbedClient(): void {
  cachedModelId = null;
  cachedExtractor = null;
  __shutdownWorker();
}

export interface EmbedOptions {
  config: DenseEmbedConfig;
  /** Override task type for this call (default: config.taskType). */
  taskType?: EmbedTaskType;
}

function normalizeL2(v: Float32Array): Float32Array {
  let sumSq = 0;
  for (let i = 0; i < v.length; i++) sumSq += v[i] * v[i];
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < v.length; i++) v[i] /= norm;
  }
  return v;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(err: unknown): boolean {
  const msg = String((err as { message?: string })?.message ?? err).toLowerCase();
  return (
    msg.includes('deadline') ||
    msg.includes('timeout') ||
    msg.includes('aborted') ||
    msg.includes('socket') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    msg.includes('econnrefused')
  );
}

function coerceFloat32(data: Float32Array | number[]): Float32Array {
  return data instanceof Float32Array ? data : new Float32Array(data);
}

function splitBatchResult(result: ExtractorResult, batchSize: number): Float32Array[] {
  const dims = result.dims ?? [];
  const data = coerceFloat32(result.data);

  if (batchSize === 1) {
    return [normalizeL2(new Float32Array(data))];
  }
  if (dims.length >= 2 && dims[0] === batchSize) {
    const dim = dims[1] ?? Math.floor(data.length / batchSize);
    const out: Float32Array[] = [];
    for (let i = 0; i < batchSize; i++) {
      const start = i * dim;
      out.push(normalizeL2(data.slice(start, start + dim)));
    }
    return out;
  }
  const dim = Math.floor(data.length / batchSize);
  if (!dim || dim * batchSize !== data.length) {
    throw new Error(
      `[denseRetrieval] local model returned ${data.length} values for ${batchSize} inputs`,
    );
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    const start = i * dim;
    out.push(normalizeL2(data.slice(start, start + dim)));
  }
  return out;
}

// ── Worker-thread mode ──────────────────────────────────────────────────
//
// When RELAY_EMBED_WORKER=1, all inference runs in a dedicated long-lived
// worker process. The worker is lazy-spawned on first call, survives across
// embed requests, and is respawned if it dies. Each in-flight request carries
// a numeric id so responses pair up via a pending-resolver map.

interface PendingRequest {
  resolve: (vectors: Float32Array[]) => void;
  reject: (err: Error) => void;
  dim: number;
}

let workerInstance: Worker | null = null;
let workerSeq = 0;
const workerPending = new Map<number, PendingRequest>();

function resolveWorkerPath(): string {
  // This file compiles to `dist/relay/src/persistence/denseRetrieval/embedClient.js`.
  // The worker sits next to it as `embedWorker.js`. `import.meta.url` resolves
  // correctly in both dev (tsx) and prod (compiled .js) because the relative
  // layout is preserved.
  const here = fileURLToPath(import.meta.url);
  return path.join(path.dirname(here), 'embedWorker.js');
}

function ensureWorker(): Worker {
  if (workerInstance) return workerInstance;
  const w = new Worker(resolveWorkerPath());
  workerInstance = w;

  w.on('message', (msg: unknown) => {
    if (!msg || typeof msg !== 'object') return;
    const envelope = msg as {
      type: 'result' | 'error';
      id: number;
      buffers?: ArrayBuffer[];
      dim?: number;
      message?: string;
    };
    const pending = workerPending.get(envelope.id);
    if (!pending) return;
    workerPending.delete(envelope.id);
    if (envelope.type === 'error') {
      pending.reject(new Error(envelope.message ?? '[embedWorker] unknown error'));
      return;
    }
    if (!Array.isArray(envelope.buffers) || typeof envelope.dim !== 'number') {
      pending.reject(new Error('[embedWorker] malformed result envelope'));
      return;
    }
    const dim = envelope.dim;
    const vectors = envelope.buffers.map((buf) => {
      // Reconstruct Float32Array from the transferred ArrayBuffer.
      // `buf.byteLength / 4` should equal `dim`; trust the worker's
      // dim guard and slice defensively.
      const fv = new Float32Array(buf);
      return fv.length === dim ? fv : fv.slice(0, dim);
    });
    pending.resolve(vectors);
  });

  w.on('error', (err) => {
    // Reject every outstanding request with the same error, then drop the
    // dead worker so the next call respawns.
    const error = err instanceof Error ? err : new Error(String(err));
    for (const pending of workerPending.values()) {
      pending.reject(error);
    }
    workerPending.clear();
    workerInstance = null;
  });

  w.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`[embedWorker] exited with code ${code}`);
      for (const pending of workerPending.values()) {
        pending.reject(err);
      }
    }
    workerPending.clear();
    workerInstance = null;
  });

  // Don't hold the event loop open just because the worker is idle.
  w.unref();
  return w;
}

function __shutdownWorker(): void {
  const w = workerInstance;
  if (!w) return;
  try {
    w.postMessage({ type: 'shutdown' });
  } catch {
    // already dead
  }
  try {
    void w.terminate();
  } catch {
    // ignore
  }
  workerInstance = null;
  workerPending.clear();
}

async function embedBatchViaWorker(
  texts: string[],
  opts: EmbedOptions,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const { config } = opts;
  const taskType: EmbedTaskType = opts.taskType ?? config.taskType;

  let attempt = 0;
  let lastErr: unknown = null;
  while (attempt <= config.maxRetries) {
    const w = ensureWorker();
    const id = ++workerSeq;
    try {
      return await new Promise<Float32Array[]>((resolve, reject) => {
        workerPending.set(id, { resolve, reject, dim: config.dimensions });
        // Hard timeout fallback in case the worker drops a message.
        const timer = setTimeout(() => {
          if (!workerPending.has(id)) return;
          workerPending.delete(id);
          reject(
            new Error(
              `[embedClient] worker request timeout after ${config.requestTimeoutMs}ms`,
            ),
          );
        }, config.requestTimeoutMs + 5000);
        const pending = workerPending.get(id)!;
        const origResolve = pending.resolve;
        const origReject = pending.reject;
        pending.resolve = (v) => { clearTimeout(timer); origResolve(v); };
        pending.reject = (e) => { clearTimeout(timer); origReject(e); };
        try {
          w.postMessage({ type: 'embed', id, texts, taskType, config });
        } catch (err) {
          clearTimeout(timer);
          workerPending.delete(id);
          reject(err as Error);
        }
      });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === config.maxRetries) break;
      const backoff = config.initialBackoffMs * Math.pow(2, attempt);
      await sleep(backoff + Math.random() * 250);
      attempt++;
    }
  }
  throw lastErr ?? new Error('[embedClient] worker embed failed with no error');
}

/**
 * Embed a batch of texts. Returns L2-normalized vectors in the same order as input.
 * On unrecoverable failure, throws the last error encountered.
 *
 * Routes through the worker thread when `RELAY_EMBED_WORKER=1`, otherwise
 * runs inline on the calling thread.
 */
export async function embedBatch(
  texts: string[],
  opts: EmbedOptions,
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  if (USE_WORKER) return embedBatchViaWorker(texts, opts);
  const { config } = opts;
  const taskType: EmbedTaskType = opts.taskType ?? config.taskType;
  const contents = texts.map((t) => truncate(t, config.maxInputChars));

  let attempt = 0;
  let lastErr: unknown = null;

  while (attempt <= config.maxRetries) {
    try {
      const extractor = await getExtractor(config);
      const prefixedContents = taskType === 'RETRIEVAL_QUERY' && config.queryPrefix
        ? contents.map((text) => `${config.queryPrefix}${text}`)
        : contents;
      const response = await Promise.race([
        extractor(
          prefixedContents.length === 1 ? prefixedContents[0]! : prefixedContents,
          { pooling: config.pooling, normalize: true },
        ),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`[denseRetrieval] request timeout after ${config.requestTimeoutMs}ms`)),
            config.requestTimeoutMs,
          ),
        ),
      ]) as ExtractorResult;

      const vectors = splitBatchResult(response, texts.length);
      if (vectors.some((vector) => vector.length !== config.dimensions)) {
        const lengths = vectors.map((vector) => vector.length).join(', ');
        throw new Error(
          `[denseRetrieval] local model returned dims [${lengths}] but config expects ${config.dimensions}`,
        );
      }
      return vectors;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === config.maxRetries) break;
      const backoff = config.initialBackoffMs * Math.pow(2, attempt);
      await sleep(backoff + Math.random() * 250);
      attempt++;
    }
  }
  throw lastErr ?? new Error('[denseRetrieval] embed failed with no error');
}

/**
 * Embed a single query text using RETRIEVAL_QUERY task type (asymmetric).
 * Returns one L2-normalized vector.
 */
export async function embedQuery(
  query: string,
  config: DenseEmbedConfig,
): Promise<Float32Array> {
  const [vec] = await embedBatch([query], { config, taskType: 'RETRIEVAL_QUERY' });
  if (!vec) throw new Error('[denseRetrieval] query embedding missing');
  return vec;
}

/**
 * Split texts into batches of config.batchSize, embed each, and return a flat
 * array of vectors in original input order. Surfaces per-batch failures as throws.
 */
export async function embedAllBatched(
  texts: string[],
  opts: EmbedOptions,
): Promise<Float32Array[]> {
  const { batchSize } = opts.config;
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize);
    const vecs = await embedBatch(slice, opts);
    out.push(...vecs);
  }
  return out;
}
