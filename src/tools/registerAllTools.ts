import type { ToolRegistry } from '../daemon/toolRegistry.js';
import type { BrainDaemonRuntime } from '../daemon/runtime.js';
import { safeJsonStringify } from '../daemon/protocol.js';
import {
  searchTranscripts as searchTranscriptChunks,
  type TranscriptSearchHit,
  type TranscriptSearchScope,
} from '../search/transcriptSearch.js';
import type { BrainSearchScope } from '../search/scopeResolver.js';
import { registerBrainRecommendTool } from './brain_recommend.js';
import { registerBrainDiffIdentitiesTool } from './brain_diff_identities.js';

interface SiloHitShape {
  silo: 'transcripts' | 'atlas_files' | 'atlas_changelog' | 'source_highlights';
  id: string;
  rank: number;
  payload: Record<string, unknown>;
}

export interface AllToolsDeps {
  registry: ToolRegistry;
  runtime: BrainDaemonRuntime;
}

type RegisterWithDeps = (server: unknown, deps: unknown) => void;
type RegisterWithRuntime = (registry: ToolRegistry, runtime: BrainDaemonRuntime) => void;

export async function registerAllTools({ registry, runtime }: AllToolsDeps): Promise<void> {
  registerDaemonStatus(registry, runtime);

  await registerBrainSearch(registry, runtime);
  await registerSopTools(registry, runtime);
  await registerIdentityTools(registry, runtime);

  registerBrainRecommendTool(registry, runtime);
  registerBrainDiffIdentitiesTool(registry, runtime);

  await registerOptionalMcpTool(registry, runtime, '../tools/brain_resume.js', 'registerBrainResumeTool', brainToolDeps(runtime));
  await registerOptionalMcpTool(registry, runtime, '../tools/brain_lineage.js', 'registerBrainLineageTool', brainToolDeps(runtime));
  await registerOptionalMcpTool(registry, runtime, '../tools/brain_when_did.js', 'registerBrainWhenDidTool', brainToolDeps(runtime));
  await registerOptionalMcpTool(registry, runtime, '../tools/brain_specialize.js', 'registerBrainSpecializeTool', brainToolDeps(runtime));

  await registerOptionalRuntimeTool(registry, runtime, '../tools/brain_respawn.js', 'registerBrainRespawnTool');
  await registerOptionalMcpTool(registry, runtime, '../tools/brain_handoff.js', 'registerBrainHandoffTool', brainToolDeps(runtime));
}

function registerDaemonStatus(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  registry.register(
    {
      name: 'brain_daemon_status',
      description: 'Inspect the running brain-mcp daemon, caller context, pools, and workers.',
    },
    (_args, caller) => {
      const structuredContent = {
        protocol: 'brain-mcp-daemon',
        status: 'ok',
        caller,
        ...runtime.snapshot(),
      };
      return {
        content: [{ type: 'text', text: safeJsonStringify(structuredContent) }],
        structuredContent,
      };
    },
  );
}

async function registerBrainSearch(registry: ToolRegistry, runtime: BrainDaemonRuntime): Promise<void> {
  await registerOptionalMcpTool(registry, runtime, '../search/brainSearch.js', 'registerBrainSearchTool', {
    searchTranscripts: (opts: {
      query: string;
      k: number;
      scope: BrainSearchScope;
      identity?: string;
      sessionId?: string;
      projectSlug?: string;
      weights?: { bm25: number; vector: number };
    }) => searchTranscriptSilo(runtime, opts),
    searchAtlasFiles: (opts: { query: string; k: number; workspace?: string }) =>
      searchAtlasBackedSilo(runtime, 'atlas_files', opts),
    searchAtlasChangelog: (opts: { query: string; k: number; workspace?: string }) =>
      searchAtlasBackedSilo(runtime, 'atlas_changelog', opts),
    searchSourceHighlights: (opts: { query: string; k: number; workspace?: string }) =>
      searchAtlasBackedSilo(runtime, 'source_highlights', opts),
    getCurrentSessionId: () => runtime.getCurrentSessionId(),
    getCurrentIdentity: () => runtime.getCurrentIdentity(),
    getCurrentProjectSlug: () => runtime.getCurrentProjectSlug(),
  });
}

async function registerSopTools(registry: ToolRegistry, runtime: BrainDaemonRuntime): Promise<void> {
  await registerOptionalMcpTool(registry, runtime, '../sop/candidatesTool.js', 'registerSopCandidatesTool', {
    db: runtime.homeDb.db,
    getCurrentIdentity: () => runtime.getCurrentIdentity(),
  });
  await registerOptionalMcpTool(registry, runtime, '../sop/promoteTool.js', 'registerSopPromoteTool', {
    db: runtime.homeDb.db,
    getCurrentIdentity: () => runtime.getCurrentIdentity(),
    getCurrentSession: () => runtime.getCurrentSessionId() ?? null,
  });
}

async function registerIdentityTools(registry: ToolRegistry, runtime: BrainDaemonRuntime): Promise<void> {
  await registerOptionalMcpTool(registry, runtime, '../identity/identityTools.js', 'registerIdentityTools', brainToolDeps(runtime), {
    quietMissing: true,
  });
}

function brainToolDeps(runtime: BrainDaemonRuntime): Record<string, unknown> {
  return {
    homeDb: runtime.homeDb,
    db: runtime.homeDb.db,
    identityStore: runtime.identityStore,
    edgeEmitter: runtime.edgeEmitter,
    atlasTools: runtime.atlasTools,
    getCurrentIdentity: () => runtime.getCurrentIdentity(),
    getCurrentSessionId: () => runtime.getCurrentSessionId(),
    getCurrentProjectSlug: () => runtime.getCurrentProjectSlug(),
  };
}

async function registerOptionalRuntimeTool(
  registry: ToolRegistry,
  runtime: BrainDaemonRuntime,
  modulePath: string,
  exportName: string,
): Promise<void> {
  try {
    const mod = await import(modulePath) as Record<string, unknown>;
    const register = mod[exportName];
    if (typeof register === 'function') {
      (register as RegisterWithRuntime)(registry, runtime);
    } else {
      process.stderr.write(`[brain-daemon] ${exportName} not found in ${modulePath}; skipping\n`);
    }
  } catch (error) {
    process.stderr.write(
      `[brain-daemon] ${exportName} registrar unavailable (${modulePath}): ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function registerOptionalMcpTool(
  registry: ToolRegistry,
  runtime: BrainDaemonRuntime,
  modulePath: string,
  exportName: string,
  deps: unknown,
  opts: { quietMissing?: boolean } = {},
): Promise<void> {
  try {
    const mod = await import(modulePath) as Record<string, unknown>;
    const register = mod[exportName];
    if (typeof register === 'function') {
      (register as RegisterWithDeps)(registry.createCaptureServer(), deps);
    } else if (!opts.quietMissing) {
      process.stderr.write(`[brain-daemon] ${exportName} not found in ${modulePath}; skipping\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (opts.quietMissing && (message.includes('Cannot find module') || message.includes('ERR_MODULE_NOT_FOUND'))) {
      return;
    }
    process.stderr.write(`[brain-daemon] ${exportName} registrar unavailable (${modulePath}): ${message}\n`);
  }
}

async function searchTranscriptSilo(
  runtime: BrainDaemonRuntime,
  opts: {
    query: string;
    k: number;
    scope: BrainSearchScope;
    identity?: string;
    sessionId?: string;
    projectSlug?: string;
    weights?: { bm25: number; vector: number };
  },
): Promise<SiloHitShape[]> {
  const caller = runtime.getCallerContext();
  const scope = toTranscriptSearchScope(opts.scope);
  const result = await searchTranscriptChunks({
    homeDb: runtime.homeDb,
    query: opts.query,
    k: opts.k,
    candidatePool: opts.k,
    scope,
    identityName: opts.identity,
    indexIdentityName: runtime.getCurrentIdentity(),
    sessionId: opts.sessionId,
    cwd: scope === 'workspace' ? caller?.cwd : undefined,
    weights: opts.weights,
    ensureIndex: Boolean(caller?.cwd),
  });

  return result.hits.map((hit, index) => transcriptHitToSiloHit(hit, index));
}

function toTranscriptSearchScope(scope: BrainSearchScope): TranscriptSearchScope {
  switch (scope) {
    case 'self':
    case 'session':
    case 'workspace':
    case 'identity':
      return scope;
    case 'all':
    case 'atlas':
    case 'transcripts':
      return 'all';
  }
}

function transcriptHitToSiloHit(hit: TranscriptSearchHit, index: number): SiloHitShape {
  return {
    silo: 'transcripts',
    id: hit.chunkId,
    rank: index + 1,
    payload: {
      chunk_id: hit.chunkId,
      row_id: hit.rowId,
      session_id: hit.sessionId,
      identity_name: hit.identityName,
      cwd: hit.cwd,
      kind: hit.kind,
      tool_name: hit.toolName,
      text: hit.text,
      file_paths: hit.filePaths,
      timestamp_ms: hit.timestampMs,
      source_path: hit.sourcePath,
      bm25_rank: hit.bm25Rank,
      vector_rank: hit.vectorRank,
      fused_score: hit.fusedScore,
    },
  };
}

async function searchAtlasBackedSilo(
  runtime: BrainDaemonRuntime,
  silo: 'atlas_files' | 'atlas_changelog' | 'source_highlights',
  opts: { query: string; k: number; workspace?: string },
): Promise<SiloHitShape[]> {
  const caller = runtime.getCallerContext();
  if (!caller) return [];

  const result = await runtime.atlasTools.callTool(
    caller.cwd,
    'atlas_query',
    {
      action: silo === 'atlas_changelog' ? 'history' : 'search',
      query: opts.query,
      limit: opts.k,
      workspace: opts.workspace,
    },
    caller,
  );

  if (result.isError) return [];

  const text = result.content
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');

  if (!text.trim()) return [];

  return [{
    silo,
    id: `${silo}:${opts.query}:${opts.workspace ?? 'cwd'}`,
    rank: 1,
    payload: {
      text,
      summary: text,
      workspace: opts.workspace,
    },
  }];
}
