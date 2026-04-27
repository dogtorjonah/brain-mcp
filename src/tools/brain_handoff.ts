import path from 'node:path';

import type { CallerContext } from '../daemon/protocol.js';
import { safeJsonStringify } from '../daemon/protocol.js';
import { getCallerContext } from '../daemon/requestContext.js';
import type { AtlasToolPool } from '../daemon/atlasToolPool.js';
import type { HomeDb } from '../home/db.js';
import type { IdentityStore } from '../identity/store.js';
import {
  extractPredecessorFromTranscript,
  readChainLink,
  walkChainBack,
  writeChainLink,
} from '../io/chain.js';
import { buildHandoff } from '../package/build.js';
import { collectFileContext } from '../package/fileContext.js';
import { loadTranscript } from '../trace/parse.js';
import { reduceTranscript } from '../trace/reduce.js';
import type { RawTranscriptLine } from '../trace/types.js';
import {
  ensureTranscriptIndex,
  listAllTranscripts,
  listProjectTranscripts,
  newestTranscriptForCwd,
  type TranscriptFileRef,
  type TranscriptIndexResult,
} from '../search/transcriptSearch.js';

interface BrainHandoffArgs {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  identity?: string;
  format?: 'json' | 'markdown' | 'both';
  include_atlas_context?: boolean;
  embed_transcript?: boolean;
  max_atlas_files?: number;
  thread_turns?: number;
}

interface AtlasInlayEntry {
  file_path: string;
  atlas_context: string;
}

interface RecentFileRow {
  workspace: string;
  file_path: string;
  edge_count: number;
  last_touched_at: number;
}

export interface BrainHandoffDeps {
  homeDb: HomeDb;
  identityStore: IdentityStore;
  atlasTools: AtlasToolPool;
  getCurrentIdentity: () => string | undefined;
  getCurrentSessionId: () => string | undefined;
}

export function registerBrainHandoffTool(server: unknown, deps: BrainHandoffDeps): void {
  const srv = server as {
    tool: (name: string, description: string, schema: unknown, handler: (args: unknown) => Promise<unknown>) => void;
  };

  srv.tool(
    'brain_handoff',
    'Build a structured JSON plus markdown handoff from transcript context, identity state, synapse edges, and Atlas inlay.',
    {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude session id. Defaults to current caller session.' },
        transcript_path: { type: 'string', description: 'Absolute path to a Claude JSONL transcript.' },
        cwd: { type: 'string', description: 'Workspace cwd. Defaults to caller cwd.' },
        identity: { type: 'string', description: 'Identity name. Defaults to current caller identity.' },
        format: { type: 'string', enum: ['json', 'markdown', 'both'], description: 'Response format. Default both.' },
        include_atlas_context: { type: 'boolean', description: 'Include Atlas lookup inlay for recent files. Default true.' },
        embed_transcript: { type: 'boolean', description: 'Backfill transcript chunk embeddings while building the handoff. Default false.' },
        max_atlas_files: { type: 'number', description: 'Max recent files to enrich from Atlas. Default 6.' },
        thread_turns: { type: 'number', description: 'Current-thread turns to include. Default follows package builder.' },
      },
    },
    async (rawArgs) => {
      const caller = getCallerContext();
      return handleBrainHandoff(rawArgs as BrainHandoffArgs, caller, deps);
    },
  );
}

async function handleBrainHandoff(
  args: BrainHandoffArgs,
  caller: CallerContext | undefined,
  deps: BrainHandoffDeps,
) {
  const cwd = args.cwd ?? caller?.cwd ?? process.cwd();
  const identityName = args.identity ?? deps.getCurrentIdentity() ?? caller?.identity ?? 'unknown';
  const sessionId = args.session_id ?? deps.getCurrentSessionId() ?? caller?.sessionId;
  const format = args.format ?? 'both';

  const transcript = args.transcript_path
    ? {
        path: args.transcript_path,
        sessionId: sessionId ?? transcriptSessionId(args.transcript_path),
        cwdSlug: cwdToProjectSlug(cwd),
      }
    : sessionId
      ? listProjectTranscripts(cwd).find((entry) => entry.sessionId === sessionId) ?? newestTranscriptForCwd(cwd)
      : newestTranscriptForCwd(cwd);

  if (!transcript) {
    return {
      content: [{ type: 'text', text: `No Claude transcript found for cwd ${cwd}.` }],
      isError: true,
    };
  }

  backfillChainLinkFromTranscript(transcript, cwd);
  if (caller?.sessionId && caller.sessionId !== transcript.sessionId) {
    writeChainLink(caller.sessionId, transcript.sessionId, cwd);
  }

  const chainTranscripts = resolveTranscriptChain(cwd, transcript);
  const rows = await loadTranscriptChainRows(chainTranscripts);
  const reduced = reduceTranscript(rows);

  let indexed: TranscriptIndexResult | undefined;
  try {
    indexed = await ensureTranscriptChainIndex({
      homeDb: deps.homeDb,
      cwd,
      identityName,
      transcripts: chainTranscripts,
      embedBudget: 50,
      skipEmbed: args.embed_transcript !== true,
    });
  } catch (error) {
    process.stderr.write(
      `[brain_handoff] transcript indexing failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const identitySnapshot = buildIdentitySnapshot(deps, identityName);
  const built = buildHandoff(reduced, {
    currentSessionId: transcript.sessionId,
    identityName,
    identitySnapshot,
    threadTurns: args.thread_turns,
  });

  const atlasInlay = args.include_atlas_context === false
    ? []
    : await buildAtlasInlay(deps, caller, reduced, cwd, args.max_atlas_files ?? 6);

  const markdown = atlasInlay.length > 0
    ? `${built.markdown}\n${renderAtlasInlay(atlasInlay)}`
    : built.markdown;

  const structuredContent = {
    kind: 'brain_handoff',
    session_id: transcript.sessionId,
    transcript_path: transcript.path,
    cwd,
    identity: identityName,
    stats: {
      ...built.stats,
      markdown_bytes: Buffer.byteLength(markdown, 'utf8'),
      indexed,
    },
    identity_snapshot: identitySnapshot,
    atlas_inlay: atlasInlay,
    markdown: format === 'json' ? undefined : markdown,
  };

  const text = format === 'json'
    ? safeJsonStringify(structuredContent)
    : format === 'markdown'
      ? markdown
      : safeJsonStringify(structuredContent);

  return {
    content: [{ type: 'text', text }],
    structuredContent,
  };
}

function backfillChainLinkFromTranscript(transcript: TranscriptFileRef, cwd: string): void {
  const inheritedPrev = extractPredecessorFromTranscript(transcript.path, transcript.sessionId);
  if (inheritedPrev && !readChainLink(transcript.sessionId)) {
    writeChainLink(transcript.sessionId, inheritedPrev, cwd);
  }
}

function resolveTranscriptChain(cwd: string, transcript: TranscriptFileRef): TranscriptFileRef[] {
  const cwdSlug = cwdToProjectSlug(cwd);
  const bySession = new Map<string, TranscriptFileRef>();
  for (const entry of listAllTranscripts()) {
    bySession.set(entry.sessionId, entry);
  }
  for (const entry of listProjectTranscripts(cwd)) {
    bySession.set(entry.sessionId, entry);
  }
  bySession.set(transcript.sessionId, transcript);

  const files: TranscriptFileRef[] = [];
  const seenPaths = new Set<string>();
  for (const sessionId of walkChainBack(transcript.sessionId, 20)) {
    const entry = sessionId === transcript.sessionId
      ? transcript
      : bySession.get(sessionId);
    if (!entry || seenPaths.has(entry.path)) continue;
    files.push({
      ...entry,
      cwdSlug: entry.cwdSlug || cwdSlug,
    });
    seenPaths.add(entry.path);
  }

  if (files.length === 0) files.push(transcript);
  return files;
}

async function loadTranscriptChainRows(transcripts: TranscriptFileRef[]): Promise<RawTranscriptLine[]> {
  const rows: RawTranscriptLine[] = [];
  for (const transcript of transcripts) {
    try {
      rows.push(...await loadTranscript(transcript.path));
    } catch {
      // Missing or corrupt ancestors degrade continuity, not the handoff itself.
    }
  }
  return rows;
}

async function ensureTranscriptChainIndex(opts: {
  homeDb: HomeDb;
  cwd: string;
  identityName: string;
  transcripts: TranscriptFileRef[];
  embedBudget: number;
  skipEmbed: boolean;
}): Promise<TranscriptIndexResult> {
  const aggregate: TranscriptIndexResult = {
    filesScanned: 0,
    filesChanged: 0,
    chunksUpserted: 0,
    embeddingsAdded: 0,
    vectorEnabled: opts.homeDb.hasVector,
  };

  for (const transcript of opts.transcripts) {
    const partial = await ensureTranscriptIndex({
      homeDb: opts.homeDb,
      cwd: opts.cwd,
      identityName: opts.identityName,
      sessionId: transcript.sessionId,
      sourcePath: transcript.path,
      embedBudget: opts.embedBudget,
      skipEmbed: opts.skipEmbed,
    });
    aggregate.filesScanned += partial.filesScanned;
    aggregate.filesChanged += partial.filesChanged;
    aggregate.chunksUpserted += partial.chunksUpserted;
    aggregate.embeddingsAdded += partial.embeddingsAdded;
    aggregate.vectorEnabled = aggregate.vectorEnabled || partial.vectorEnabled;
  }

  return aggregate;
}

function buildIdentitySnapshot(deps: BrainHandoffDeps, identityName: string) {
  const profile = deps.identityStore.getProfile(identityName);
  const handoffNote = deps.identityStore.getHandoffNote(identityName);
  const sops = deps.identityStore.listSops(identityName).slice(0, 8);
  const recentFiles = getRecentFiles(deps, identityName, 6);

  return {
    blurb: profile?.blurb ?? '',
    specialtyTags: profile?.specialtyTags ?? '',
    handoffNote: handoffNote?.note ?? null,
    activeSops: sops.map((sop) => ({ title: sop.title, body: sop.body })),
    recentFiles: recentFiles.map((file) => ({
      workspace: file.workspace,
      filePath: file.file_path,
      edgeCount: file.edge_count,
      lastTouchedAt: file.last_touched_at,
    })),
  };
}

function getRecentFiles(deps: BrainHandoffDeps, identityName: string, limit: number): RecentFileRow[] {
  return deps.homeDb.db.prepare(`
    SELECT workspace, file_path, COUNT(*) AS edge_count, MAX(ts) AS last_touched_at
    FROM atlas_identity_edges
    WHERE identity_name = ?
    GROUP BY workspace, file_path
    ORDER BY last_touched_at DESC
    LIMIT ?
  `).all(identityName, limit) as RecentFileRow[];
}

async function buildAtlasInlay(
  deps: BrainHandoffDeps,
  caller: CallerContext | undefined,
  reduced: ReturnType<typeof reduceTranscript>,
  cwd: string,
  maxFiles: number,
): Promise<AtlasInlayEntry[]> {
  if (!caller) return [];
  const fileContext = collectFileContext(reduced).slice(0, maxFiles);
  const out: AtlasInlayEntry[] = [];
  for (const entry of fileContext) {
    const filePath = normalizeWorkspacePath(cwd, entry.path);
    try {
      const result = await deps.atlasTools.callTool(cwd, 'atlas_query', {
        action: 'lookup',
        file_path: filePath,
        include_source: false,
      }, caller);
      const text = result.content
        .map((item) => (typeof item.text === 'string' ? item.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) {
        out.push({ file_path: filePath, atlas_context: trimLines(text, 80) });
      }
    } catch {
      // Atlas inlay is additive context. Missing Atlas DBs should not block
      // handoff generation.
    }
  }
  return out;
}

function renderAtlasInlay(entries: AtlasInlayEntry[]): string {
  const lines = ['── Atlas Inlay ──', ''];
  for (const entry of entries) {
    lines.push(`### ${entry.file_path}`, '');
    lines.push(entry.atlas_context, '');
  }
  return lines.join('\n');
}

function normalizeWorkspacePath(cwd: string, filePath: string): string {
  if (!path.isAbsolute(filePath)) return filePath;
  const rel = path.relative(cwd, filePath);
  return rel && !rel.startsWith('..') ? rel : filePath;
}

function transcriptSessionId(filePath: string): string {
  return path.basename(filePath).replace(/\.jsonl$/, '');
}

function cwdToProjectSlug(cwd: string): string {
  return cwd.replaceAll('/', '-').replace(/^-/, '-');
}

function trimLines(text: string, maxLines: number): string {
  const lines = text.split('\n');
  if (lines.length <= maxLines) return text;
  return `${lines.slice(0, maxLines).join('\n')}\n... [${lines.length - maxLines} lines elided]`;
}
