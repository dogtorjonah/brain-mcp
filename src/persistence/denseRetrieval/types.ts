/**
 * Dense Retrieval — Types
 *
 * Parallel dense-embedding retrieval path over transcript chunks, sitting
 * alongside the existing BM25 + sparse-HNSW pipeline in `hybridRetrieval.ts`.
 *
 * The existing HNSW path uses TF-IDF pseudo-vectors — it is still a lexical
 * retriever under the hood. This module adds a **true semantic** layer:
 * local BGE sentence embeddings persisted in sqlite-vec.
 */

/** Gemini task-type hint — asymmetric retrieval uses DOCUMENT for chunks, QUERY for queries. */
export type EmbedTaskType =
  | 'RETRIEVAL_DOCUMENT'
  | 'RETRIEVAL_QUERY'
  | 'SEMANTIC_SIMILARITY';

/** Configuration for dense embedding generation. */
export interface DenseEmbedConfig {
  model: string;
  /** Output dimensionality of the local embedding model. */
  dimensions: number;
  /** Max input chars per chunk before truncation. */
  maxInputChars: number;
  /** Max texts per local inference batch. */
  batchSize: number;
  maxRetries: number;
  initialBackoffMs: number;
  requestTimeoutMs: number;
  /** Pooling strategy recommended by the selected model. */
  pooling: 'cls' | 'mean';
  /**
   * Optional query prefix used by retrieval-tuned models such as BGE.
   * Applied to query embeddings only.
   */
  queryPrefix: string;
  taskType: EmbedTaskType;
}

export const DEFAULT_EMBED_CONFIG: DenseEmbedConfig = {
  // Frost Hydra's original recommendation: free/local BGE-small first.
  model: 'onnx-community/bge-small-en-v1.5-ONNX',
  dimensions: 384,
  maxInputChars: 8000,
  batchSize: 16,
  maxRetries: 2,
  initialBackoffMs: 1000,
  requestTimeoutMs: 120000,
  pooling: 'cls',
  queryPrefix: 'Represent this sentence for searching relevant passages: ',
  taskType: 'RETRIEVAL_DOCUMENT',
};

/** A single persisted dense-embedding record. */
export interface DenseEmbedding {
  chunkId: string;
  /** Model identifier at time of embedding — mismatch triggers re-embed. */
  model: string;
  dim: number;
  /** L2-normalized embedding vector. */
  vector: Float32Array;
  /** Sha256 of embedded text — used to detect stale entries after chunk edits. */
  textHash: string;
  createdAt: number;
}

/** Result of a dense similarity search. */
export interface DenseSearchHit {
  chunkId: string;
  chunk: unknown;
  /** Cosine similarity in [-1, 1]; higher = more similar. */
  score: number;
}

export interface EmbedProgress {
  totalChunks: number;
  alreadyEmbedded: number;
  newlyEmbedded: number;
  failed: number;
  elapsedMs: number;
}
