/**
 * Dense-embedding client for transcript search.
 *
 * Uses onnx-community/bge-small-en-v1.5-ONNX via @huggingface/transformers —
 * a 384-dim model with CLS pooling and an asymmetric query prefix. The model
 * downloads on first call (~30 MB) and is cached under ~/.cache/huggingface/
 * so subsequent runs are zero-cost beyond pipeline init.
 *
 * Asymmetric retrieval (queries get a prefix, documents don't) is load-bearing
 * for bge-small — the model was trained this way and skipping the prefix
 * silently degrades relevance without producing any error.
 */

import type { FeatureExtractionPipeline } from '@huggingface/transformers';

export const EMBED_MODEL = 'onnx-community/bge-small-en-v1.5-ONNX';
export const EMBED_DIM = 384;
export const EMBED_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
export const EMBED_BATCH_SIZE = 16;
export const EMBED_MAX_INPUT_CHARS = 8000;

/**
 * Lazy-initialised feature-extraction pipeline. We hold a single instance
 * for the process lifetime — the pipeline owns an ONNX session under the
 * hood and re-creating it per batch would burn startup cost repeatedly.
 */
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;

export async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      // `quantized: true` is the default for the ONNX community models —
      // left implicit here so we pick up model-author changes automatically.
      const extractor = await pipeline('feature-extraction', EMBED_MODEL);
      return extractor as unknown as FeatureExtractionPipeline;
    })();
  }
  return extractorPromise;
}

export type EmbedTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY';

/**
 * Embed a batch of texts. Queries get the asymmetric prefix prepended;
 * documents are embedded as-is. Returns L2-normalised vectors so downstream
 * cosine similarity is a dot product.
 *
 * NOTE: The transformers.js pipeline accepts either a single string or an
 * array. We always call with the prefixed-or-raw array to keep the code
 * path uniform.
 */
export async function embedBatch(texts: string[], taskType: EmbedTaskType): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const extractor = await getExtractor();
  const truncated = texts.map((t) => (t.length > EMBED_MAX_INPUT_CHARS ? t.slice(0, EMBED_MAX_INPUT_CHARS) : t));
  const prepared = taskType === 'RETRIEVAL_QUERY'
    ? truncated.map((t) => `${EMBED_QUERY_PREFIX}${t}`)
    : truncated;

  const vectors: Float32Array[] = [];
  for (let i = 0; i < prepared.length; i += EMBED_BATCH_SIZE) {
    const slice = prepared.slice(i, i + EMBED_BATCH_SIZE);
    // `pooling: 'cls'` extracts the [CLS] token representation — bge-small
    // was trained with CLS pooling specifically. `normalize: true` gives
    // unit-length vectors for cosine-as-dot-product at query time.
    const output = await extractor(slice, { pooling: 'cls', normalize: true });
    // transformers.js returns a Tensor with shape [batch, dim]. The `.data`
    // accessor gives a flat Float32Array we need to split by row.
    const data = output.data as Float32Array;
    const dim = output.dims?.[output.dims.length - 1] ?? EMBED_DIM;
    if (dim !== EMBED_DIM) {
      throw new Error(`[rebirth/embed] model returned dim=${dim}, expected ${EMBED_DIM}`);
    }
    for (let r = 0; r < slice.length; r++) {
      // Float32Array copy — slicing the view directly would keep the full
      // batch buffer alive as long as any chunk references it.
      const row = new Float32Array(dim);
      row.set(data.subarray(r * dim, (r + 1) * dim));
      vectors.push(row);
    }
  }
  return vectors;
}

/** Convenience wrapper for the single-query hot path. */
export async function embedQuery(text: string): Promise<Float32Array> {
  const [vec] = await embedBatch([text], 'RETRIEVAL_QUERY');
  if (!vec) throw new Error('[rebirth/embed] embed returned no vector');
  return vec;
}
