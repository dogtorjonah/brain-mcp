/**
 * Pre-fetch the local embedding model so the first MCP call doesn't stall
 * on a 30MB ONNX download.
 *
 * @huggingface/transformers lazy-downloads the model on first
 * `pipeline('feature-extraction', ...)` call and caches it under
 * ~/.cache/huggingface/. We trigger the download once during install so
 * brain_recall / handoff transcript indexing don't hit a cold cache when
 * a user actually asks them to do something.
 */
import { DEFAULT_EMBED_CONFIG } from '../persistence/denseRetrieval/types.js';

export interface WarmEmbeddingsResult {
  ok: boolean;
  status: 'warmed' | 'already-warm' | 'failed';
  model: string;
  detail: string;
  durationMs?: number;
}

export async function warmEmbeddings(opts: {
  model?: string;
  dryRun?: boolean;
} = {}): Promise<WarmEmbeddingsResult> {
  const model = opts.model ?? DEFAULT_EMBED_CONFIG.model;

  if (opts.dryRun) {
    return {
      ok: true,
      status: 'warmed',
      model,
      detail: `would download / verify HF model "${model}" (~30MB on first run)`,
    };
  }

  const startedAt = Date.now();
  try {
    const { pipeline } = await import('@huggingface/transformers');
    // First invocation downloads + caches; subsequent invocations are no-ops.
    // We only need the side-effect (cache populated) — discard the extractor.
    await pipeline('feature-extraction', model, { dtype: 'fp32' });
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      model,
      detail: `embedding warmup failed for "${model}": ${(err as Error).message}`,
    };
  }

  const durationMs = Date.now() - startedAt;
  // 1500ms is roughly the cold-load time on a typical laptop after the
  // model is already cached on disk. Below that we infer "already warm".
  const status = durationMs < 1500 ? 'already-warm' : 'warmed';
  const detail = status === 'already-warm'
    ? `HF cache already had "${model}" (loaded in ${durationMs}ms)`
    : `downloaded + cached HF model "${model}" (${durationMs}ms)`;

  return { ok: true, status, model, detail, durationMs };
}
