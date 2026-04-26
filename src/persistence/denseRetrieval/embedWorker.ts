/**
 * Dense Embedding Worker (node:worker_threads entrypoint)
 *
 * Runs the `@huggingface/transformers` feature-extraction pipeline inside a
 * dedicated worker thread so the main thread's event loop stays responsive
 * during ONNX inference. Main-thread client lives in `embedClient.ts` and
 * opts into this worker when `RELAY_EMBED_WORKER=1`.
 *
 * Protocol (parent -> worker):
 *   { type: 'embed', id, texts, taskType, config }
 *   { type: 'shutdown' }
 *
 * Protocol (worker -> parent):
 *   { type: 'result', id, vectors }    // vectors is Float32Array[]
 *   { type: 'error',  id, message }
 *
 * The worker caches the extractor per model id, same as inline embedClient.
 * L2-normalization is performed worker-side so the parent receives
 * ready-to-store vectors.
 */

import { parentPort } from 'node:worker_threads';
import type { DenseEmbedConfig, EmbedTaskType } from './types.js';

type ExtractorResult = {
  data: Float32Array | number[];
  dims?: number[];
};

type FeatureExtractor = (
  input: string | string[],
  options: { pooling: 'cls' | 'mean'; normalize: boolean },
) => Promise<ExtractorResult>;

interface EmbedRequest {
  type: 'embed';
  id: number;
  texts: string[];
  taskType: EmbedTaskType;
  config: DenseEmbedConfig;
}

interface ShutdownRequest {
  type: 'shutdown';
}

type WorkerRequest = EmbedRequest | ShutdownRequest;

if (!parentPort) {
  throw new Error('[embedWorker] must be launched via worker_threads.Worker');
}

let cachedModelId: string | null = null;
let cachedExtractor: FeatureExtractor | null = null;

async function getExtractor(config: DenseEmbedConfig): Promise<FeatureExtractor> {
  if (cachedExtractor && cachedModelId === config.model) {
    return cachedExtractor;
  }
  const { pipeline } = await import('@huggingface/transformers');
  const extractor = (await pipeline('feature-extraction', config.model, {
    dtype: 'fp32',
  })) as unknown as FeatureExtractor;
  cachedModelId = config.model;
  cachedExtractor = extractor;
  return extractor;
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
      `[embedWorker] model returned ${data.length} values for ${batchSize} inputs`,
    );
  }
  const out: Float32Array[] = [];
  for (let i = 0; i < batchSize; i++) {
    const start = i * dim;
    out.push(normalizeL2(data.slice(start, start + dim)));
  }
  return out;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

async function handleEmbed(req: EmbedRequest): Promise<void> {
  const port = parentPort!;
  try {
    const extractor = await getExtractor(req.config);
    const contents = req.texts.map((t) => truncate(t, req.config.maxInputChars));
    const prefixed =
      req.taskType === 'RETRIEVAL_QUERY' && req.config.queryPrefix
        ? contents.map((text) => `${req.config.queryPrefix}${text}`)
        : contents;

    // Per-call timeout guard — cold starts shouldn't wedge the worker.
    const response = (await Promise.race([
      extractor(prefixed.length === 1 ? prefixed[0]! : prefixed, {
        pooling: req.config.pooling,
        normalize: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new Error(
                `[embedWorker] request timeout after ${req.config.requestTimeoutMs}ms`,
              ),
            ),
          req.config.requestTimeoutMs,
        ),
      ),
    ])) as ExtractorResult;

    const vectors = splitBatchResult(response, req.texts.length);
    if (vectors.some((v) => v.length !== req.config.dimensions)) {
      const lengths = vectors.map((v) => v.length).join(', ');
      throw new Error(
        `[embedWorker] model returned dims [${lengths}] but config expects ${req.config.dimensions}`,
      );
    }

    // Send as transferable ArrayBuffers — zero-copy handoff to the parent.
    const buffers = vectors.map((v) => v.buffer as ArrayBuffer);
    port.postMessage(
      { type: 'result', id: req.id, buffers, dim: req.config.dimensions },
      buffers,
    );
  } catch (err) {
    port.postMessage({
      type: 'error',
      id: req.id,
      message: (err as Error).message,
    });
  }
}

parentPort.on('message', (msg: WorkerRequest) => {
  if (msg.type === 'shutdown') {
    // Let any in-flight embed finish naturally, then exit. A tighter shutdown
    // (process.exit) would drop pending responses the parent is still awaiting.
    parentPort?.close();
    return;
  }
  if (msg.type === 'embed') {
    void handleEmbed(msg);
  }
});
