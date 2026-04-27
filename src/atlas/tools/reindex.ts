import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime, AtlasFileRecord } from '../types.js';
import { toolWithDescription } from './helpers.js';
import { deleteAtlasFile, enqueueReextract, getFilePhase, listAtlasFiles } from '../db.js';
import type { AtlasDatabase } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';
import { runRuntimeReindex } from '../pipeline/index.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import { ATLAS_MIGRATION_DIR } from '../migrationDir.js';
import { closeBridgeDb, discoverAllRoots, openWritableBridgeDb } from './bridge.js';

const activeReindexes = new Map<string, Promise<void>>();
const reindexStartedAt = new Map<string, Date>();
const reindexFileCount = new Map<string, number>();
const reindexMode = new Map<string, 'full' | 'crossref'>();
const reindexPid = process.pid;

// Track last-completed reindex so status checks after a fast run don't
// fall through to the dry-run path with no indication it already ran.
interface ReindexCompletion {
  mode: 'full' | 'crossref';
  succeeded: number;
  failed: number;
  durationMs: number;
  completedAt: Date;
  warning?: string;
}
const lastCompletion = new Map<string, ReindexCompletion>();

// ── Staleness detection for dry-run reporting ──

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

interface StaleStats {
  total: number;
  complete: number;
  stale: number;
  staleFiles: string[];
  incomplete: number;
  incompleteFiles: string[];
  pruned: number;
  prunedFiles: string[];
}

function computeStaleStats(
  db: AtlasDatabase,
  workspace: string,
  sourceRoot: string,
  atlasFiles: AtlasFileRecord[],
): StaleStats {
  let complete = 0;
  let stale = 0;
  let incomplete = 0;
  let pruned = 0;
  const staleFiles: string[] = [];
  const incompleteFiles: string[] = [];
  const prunedFiles: string[] = [];

  for (const record of atlasFiles) {
    const absPath = path.join(sourceRoot, record.file_path);
    let currentHash: string;
    try {
      const content = fs.readFileSync(absPath, 'utf8');
      currentHash = hashContent(content);
    } catch {
      // Source file no longer exists — prune the orphaned atlas entry
      deleteAtlasFile(db, workspace, record.file_path);
      pruned++;
      prunedFiles.push(record.file_path);
      continue;
    }

    const phase = getFilePhase(db, workspace, record.file_path, currentHash);
    if (phase === 'crossref') {
      complete++;
    } else if (record.file_hash !== currentHash) {
      stale++;
      staleFiles.push(record.file_path);
    } else {
      incomplete++;
      incompleteFiles.push(record.file_path);
    }
  }

  return { total: atlasFiles.length, complete, stale, staleFiles, incomplete, incompleteFiles, pruned, prunedFiles };
}

function buildPercentBar(percent: number, width = 18): string {
  const normalized = Math.max(0, Math.min(percent, 100));
  const filled = Math.round((normalized / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(width - filled, 0))}`;
}

function readStatus(sourceRoot: string): null | {
  currentPhase: string;
  phases: Record<string, { total?: number; completed?: number; failed?: number; done?: boolean }>;
} {
  try {
    const raw = fs.readFileSync(path.join(sourceRoot, '.brain', 'status.json'), 'utf8');
    return JSON.parse(raw) as {
      currentPhase: string;
      phases: Record<string, { total?: number; completed?: number; failed?: number; done?: boolean }>;
    };
  } catch {
    return null;
  }
}

export interface ReindexArgs {
  files?: string[];
  workspace?: string;
  confirm?: boolean;
  phase?: 'crossref';
}

type ReindexResult = { content: Array<{ type: 'text'; text: string }> };

export async function runReindexTool(runtime: AtlasRuntime, {
  files, workspace, confirm, phase,
}: ReindexArgs): Promise<ReindexResult> {
  // ── Cross-workspace dispatch ──
  // When `workspace` targets a different atlas DB than the current runtime,
  // open that DB directly and recurse with a properly scoped tempRuntime.
  //
  // WHY: without this, every stateful call below uses `runtime.db` (the
  // CURRENT workspace's DB) and `runtime.config.sourceRoot` (the CURRENT
  // workspace's file tree) while tagging rows with the TARGET workspace name.
  // That scans the wrong tree AND contaminates the wrong DB with rows
  // labeled for another workspace. See the swarm-chess incident.
  //
  // The init handler in admin.ts already uses this pattern (builds a
  // tempRuntime from resetAtlasDatabase). Reindex needs the same treatment
  // but opens an EXISTING DB via the writable bridge pool.
  if (workspace && workspace !== runtime.config.workspace) {
    const allRoots = discoverAllRoots(runtime.config.sourceRoot);
    const target = allRoots.find((r) => r.workspace === workspace);
    if (!target) {
      return {
        content: [{
          type: 'text',
          text: `Workspace "${workspace}" not found. Use atlas_admin action=bridge_list to see available workspaces.`,
        }],
      };
    }
    if (!target.indexed) {
      return {
        content: [{
          type: 'text',
          text: `Workspace "${workspace}" is a git repo but has no atlas yet. Use atlas_admin action=init workspace=${workspace} confirm=true to bootstrap it.`,
        }],
      };
    }
    // Close any readonly bridge handle pointing at this DB so the writable
    // open doesn't race with it (both pools keyed by dbPath).
    closeBridgeDb(target.dbPath);
    const targetDb = openWritableBridgeDb(
      target.dbPath,
      ATLAS_MIGRATION_DIR,
      runtime.config.sqliteVecExtension,
      runtime.config.embeddingDimensions,
    );
    const tempRuntime: AtlasRuntime = {
      config: {
        ...runtime.config,
        workspace: target.workspace,
        sourceRoot: target.sourceRoot,
        dbPath: target.dbPath,
      },
      db: targetDb,
      server: runtime.server,
    };
    return runReindexTool(tempRuntime, { files, confirm, phase });
  }

  const activeWorkspace = workspace ?? runtime.config.workspace;
  const requestedPhase = phase ?? 'full';
  const uniqueFiles = files ? [...new Set(files.map((f) => f.trim()).filter(Boolean))] : [];

  // ── Mode: flush specific files ──
  if (uniqueFiles.length > 0 && requestedPhase === 'full' && !confirm) {
    for (const filePath of uniqueFiles) {
      enqueueReextract(runtime.db, activeWorkspace, filePath, 'flush');
    }
    await notifyAtlasContextUpdated(runtime.server);
    return {
      content: [
        {
          type: 'text',
          text: `Queued ${uniqueFiles.length} file${uniqueFiles.length === 1 ? '' : 's'} for re-extraction.`,
        },
        {
          type: 'text',
          text: '💡 Call `atlas_admin action=reindex confirm=true files=["path/to/file.ts"]` to run the pipeline now.',
        },
      ],
    };
  }

  // ── Mode: dry-run / status ──
  const atlasFiles = listAtlasFiles(runtime.db, activeWorkspace);
  const fileCount = atlasFiles.length;
  const crossrefRequestedRows = uniqueFiles.length > 0
    ? atlasFiles.filter((file) => uniqueFiles.includes(file.file_path))
    : atlasFiles;
  const crossrefTargetCount = crossrefRequestedRows.filter((file) => file.purpose.trim() !== '' && file.extraction_model !== 'scaffold').length;
  const crossrefMissingCount = uniqueFiles.length > 0 ? Math.max(uniqueFiles.length - crossrefRequestedRows.length, 0) : 0;

  if (!confirm) {
    // Check if a recent reindex just completed (avoids confusing dry-run
    // output when the user checks right after a fast run finishes).
    const completed = lastCompletion.get(activeWorkspace);
    if (completed) {
      const agoMs = Date.now() - completed.completedAt.getTime();
      // Show completion notice for up to 5 minutes after the run ends
      if (agoMs < 5 * 60 * 1000) {
        const agoSec = Math.round(agoMs / 1000);
        const durationSec = Math.round(completed.durationMs / 1000);
        const modeLabel = completed.mode === 'crossref' ? 'Crossref rerun' : 'Reindex';
        lastCompletion.delete(activeWorkspace);
        const completionLines = [
          `✅ ${modeLabel} completed ${agoSec}s ago (ran for ${durationSec}s)`,
          `  ${completed.succeeded} succeeded, ${completed.failed} failed`,
        ];
        if (completed.warning) {
          completionLines.push('', completed.warning);
        }
        completionLines.push('', 'Atlas data is now up-to-date. Use `atlas_query` to explore the refreshed data.');
        return {
          content: [{
            type: 'text',
            text: completionLines.join('\n'),
          }],
        };
      }
      lastCompletion.delete(activeWorkspace);
    }

    const startedAt = reindexStartedAt.get(activeWorkspace);
    if (activeReindexes.has(activeWorkspace) && startedAt) {
      const elapsed = Math.round((Date.now() - startedAt.getTime()) / 1000);
      const status = readStatus(runtime.config.sourceRoot);
      const activeMode = reindexMode.get(activeWorkspace) ?? 'full';
      if (status) {
        const phaseOrder = ['structure', 'flow', 'crossref', 'cluster'];
        const phaseLabels: Record<string, string> = {
          'structure': 'AST analysis',
          'flow': 'Data flow',
          'crossref': 'Cross-refs',
          'cluster': 'Communities',
        };
        const normalized = phaseOrder.map((key) => {
          const p = status.phases[key];
          const total = Math.max(0, Number(p?.total ?? 0));
          const completed = Math.max(0, Number(p?.completed ?? 0));
          const failed = Math.max(0, Number(p?.failed ?? 0));
          const processed = Math.min(total, completed + failed);
          const done = Boolean(p?.done) || (total > 0 && processed >= total);
          return { key, total, processed, done };
        });
        const current = normalized.find((p) => p.key === status.currentPhase);
        const phaseUnits = normalized.reduce((sum, p) => {
          if (p.done) return sum + 1;
          if (p.key === status.currentPhase && p.total > 0) {
            return sum + (p.processed / p.total);
          }
          return sum;
        }, 0);
        const overallPercent = activeMode === 'crossref'
          ? Number((((current?.processed ?? 0) / Math.max(current?.total ?? 0, 1)) * 100).toFixed(1))
          : Number(((phaseUnits / phaseOrder.length) * 100).toFixed(1));
        const currentLabel = phaseLabels[status.currentPhase] ?? status.currentPhase;
        const currentPercent = current && current.total > 0
          ? `${((current.processed / current.total) * 100).toFixed(1)}%`
          : '—';
        return {
          content: [{
            type: 'text',
            text: [
              `${activeMode === 'crossref' ? 'Crossref rerun' : 'Reindex'} in progress (pid ${reindexPid}): ${buildPercentBar(overallPercent)} ${overallPercent}%, running for ${elapsed}s`,
              `Phase: ${currentLabel} (${current?.processed ?? 0}/${current?.total ?? 0}, ${currentPercent})`,
              `Target files in current phase: ${current?.total ?? reindexFileCount.get(activeWorkspace) ?? '?'}`,
              `Atlas context will update when complete.`,
            ].join('\n'),
          }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: [
            `${activeMode === 'crossref' ? 'Crossref rerun' : 'Reindex'} in progress (pid ${reindexPid}): ${reindexFileCount.get(activeWorkspace) ?? '?'} files, running for ${elapsed}s`,
            `Atlas context will update when complete.`,
          ].join('\n'),
        }],
      };
    }
    // ── Compute staleness for accurate dry-run reporting ──
    if (requestedPhase === 'crossref') {
      // Compute actual phase-level breakdown using getFilePhase, mirroring
      // the pipeline's selectCrossrefTargets prerequisite check.
      const targetRows = uniqueFiles.length > 0
        ? atlasFiles.filter((file) => uniqueFiles.includes(file.file_path))
        : atlasFiles;
      let alreadyComplete = 0;
      let eligible = 0;
      let missingPrereq = 0;
      for (const record of targetRows) {
        const absPath = path.join(runtime.config.sourceRoot, record.file_path);
        let currentHash: string;
        try {
          const content = fs.readFileSync(absPath, 'utf8');
          currentHash = hashContent(content);
        } catch {
          continue; // source file gone, skip
        }
        const phase = getFilePhase(runtime.db, activeWorkspace, record.file_path, currentHash);
        if (phase === 'crossref') {
          alreadyComplete++;
        } else if (phase === 'structure') {
          eligible++;
        } else {
          missingPrereq++;
        }
      }

      const lines: string[] = [
        `atlas_reindex dry-run (phase=crossref): ${targetRows.length} total files`,
        `  ✅ ${alreadyComplete} already have cross-refs (will be re-computed)`,
        `  📊 ${eligible} eligible (structure complete, ready for cross-refs)`,
      ];
      if (missingPrereq > 0) {
        lines.push(`  ⚠️  ${missingPrereq} missing prerequisites (need structure first, will be skipped)`);
      }
      if (crossrefMissingCount > 0) {
        lines.push(`  ❌ ${crossrefMissingCount} requested files not found in atlas`);
      }
      const willProcess = alreadyComplete + eligible;
      lines.push(
        `Requested files: ${uniqueFiles.length > 0 ? uniqueFiles.length : 'all eligible files'}`,
        `Files to process: ${willProcess}`,
        '',
        'Call atlas_reindex with confirm=true and phase="crossref" to rerun cross-refs only.',
        'Pass files=["path/to/file.ts"] with phase="crossref" to limit the rerun.',
      );

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const stats = computeStaleStats(runtime.db, activeWorkspace, runtime.config.sourceRoot, atlasFiles);
    const needsWork = stats.stale + stats.incomplete;
    // Adjust total to reflect pruned orphans
    const effectiveTotal = fileCount - stats.pruned;

    const lines: string[] = [
      `atlas_reindex dry-run: ${effectiveTotal} total files in atlas`,
      `  ✅ ${stats.complete} complete (up-to-date, will be skipped)`,
    ];
    if (stats.stale > 0) {
      lines.push(`  🔄 ${stats.stale} stale (source changed since last extraction)`);
    }
    if (stats.incomplete > 0) {
      lines.push(`  ⚠️  ${stats.incomplete} incomplete (extraction not finished)`);
    }
    if (stats.pruned > 0) {
      lines.push(`  🗑️  ${stats.pruned} orphaned (source deleted, pruned from atlas)`);
    }
    if (needsWork === 0) {
      lines.push(`  🎉 All files are up-to-date — nothing to do.`);
    } else {
      lines.push(`  📊 ${needsWork} file${needsWork === 1 ? '' : 's'} need processing`);
    }
    lines.push('Resume-safe — will pick up where it left off if interrupted.');
    if (stats.prunedFiles.length > 0 && stats.prunedFiles.length <= 20) {
      lines.push('', 'Pruned orphans:');
      for (const f of stats.prunedFiles) lines.push(`  • ${f}`);
    }
    if (stats.staleFiles.length > 0 && stats.staleFiles.length <= 20) {
      lines.push('', 'Stale files:');
      for (const f of stats.staleFiles) lines.push(`  • ${f}`);
    }
    if (stats.incompleteFiles.length > 0 && stats.incompleteFiles.length <= 20) {
      lines.push('', 'Incomplete files:');
      for (const f of stats.incompleteFiles) lines.push(`  • ${f}`);
    }
    lines.push('', needsWork > 0
      ? 'Call atlas_reindex with confirm=true to proceed.'
      : 'No reindex needed — all extractions are current.',
    );
    if (needsWork > 0) {
      lines.push('Pass files=["path/to/file.ts"] to re-extract specific files instead.');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }

  // ── Mode: full pipeline ──
  if (activeReindexes.has(activeWorkspace)) {
    return {
      content: [{ type: 'text', text: `A reindex is already in progress (pid ${reindexPid}).` }],
    };
  }

  // Compute accurate stale count for the start message
  const confirmStats = requestedPhase !== 'crossref'
    ? computeStaleStats(
      runtime.db,
      activeWorkspace,
      runtime.config.sourceRoot,
      uniqueFiles.length > 0
        ? atlasFiles.filter((file) => uniqueFiles.includes(file.file_path))
        : atlasFiles,
    )
    : null;
  const confirmFileCount = uniqueFiles.length > 0 ? crossrefRequestedRows.length : fileCount;
  const confirmNeedsWork = confirmStats ? confirmStats.stale + confirmStats.incomplete : crossrefTargetCount;

  const runStartedAt = new Date();
  reindexStartedAt.set(activeWorkspace, runStartedAt);
  reindexFileCount.set(activeWorkspace, requestedPhase === 'crossref' ? crossrefTargetCount : Math.max(confirmFileCount, confirmNeedsWork));
  reindexMode.set(activeWorkspace, requestedPhase);

  activeReindexes.set(activeWorkspace, runRuntimeReindex({
    db: runtime.db,
    workspace: activeWorkspace,
    rootDir: runtime.config.sourceRoot,
    concurrency: runtime.config.concurrency,
    embeddingModel: runtime.config.embeddingModel,
    embeddingDimensions: runtime.config.embeddingDimensions,
    phase: requestedPhase,
    files: uniqueFiles.length > 0 ? uniqueFiles : undefined,
  }).then((result) => {
    const succeeded = result.filesProcessed - result.filesFailed;
    const durationMs = Date.now() - runStartedAt.getTime();
    console.log(`[atlas-reindex] complete: ${succeeded} succeeded, ${result.filesFailed} failed in ${Math.round(durationMs / 1000)}s`);

    // Sanity check: if crossref completed but most files have 0 cross-refs, rg likely failed
    let xrefWarning: string | undefined;
    if (requestedPhase === 'crossref' && succeeded > 10) {
      try {
        const row = runtime.db.prepare(
          `SELECT count(*) as cnt FROM atlas_files
           WHERE workspace = ? AND cross_refs IS NOT NULL
             AND json_extract(cross_refs, '$.total_cross_references') > 0`,
        ).get(activeWorkspace) as { cnt: number } | undefined;
        const withXrefs = row?.cnt ?? 0;
        if (withXrefs < succeeded * 0.1) {
          xrefWarning = `⚠️  Only ${withXrefs}/${succeeded} files have non-zero cross-refs. ripgrep (rg) may not be installed or accessible.`;
          console.warn(`[atlas-reindex] ${xrefWarning}`);
        }
      } catch {
        // ignore check failure
      }
    }

    lastCompletion.set(activeWorkspace, {
      mode: requestedPhase,
      succeeded,
      failed: result.filesFailed,
      durationMs,
      completedAt: new Date(),
      warning: xrefWarning,
    });
    notifyAtlasContextUpdated(runtime.server).catch(() => {});
  }).catch((error: unknown) => {
    console.error('[atlas-reindex] failed:', error instanceof Error ? error.message : String(error));
  }).finally(() => {
    activeReindexes.delete(activeWorkspace);
    reindexStartedAt.delete(activeWorkspace);
    reindexFileCount.delete(activeWorkspace);
    reindexMode.delete(activeWorkspace);
  }));

  return {
    content: [
      {
        type: 'text',
        text: [
          requestedPhase === 'crossref'
            ? `Crossref rerun started in background (pid ${reindexPid}): ${crossrefTargetCount} eligible file${crossrefTargetCount === 1 ? '' : 's'}`
            : `Reindex started in background (pid ${reindexPid}, resume-safe): ${confirmFileCount} target file${confirmFileCount === 1 ? '' : 's'}, ${confirmNeedsWork} need processing`,
          requestedPhase === 'crossref'
            ? 'Cross-ref rerun only.'
            : 'Resume-safe — will pick up where it left off if interrupted.',
          `Run atlas_reindex again for live file counts and % progress.`,
          `Atlas context will update when complete.`,
        ].join('\n'),
      },
      {
        type: 'text',
        text: '💡 After the rerun settles, use `atlas_query action=search` to verify the refreshed Atlas data.',
      },
    ],
  };
}

export function registerReindexTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_reindex',
    'Re-run the atlas extraction pipeline. No args = dry-run status. files=["a.ts"] = re-extract specific files. confirm=true = full pipeline (resume-safe). confirm=true + phase="crossref" = recompute cross-references only. The pipeline is resume-safe — safe to kill and restart.',
    {
      files: z.array(z.string().min(1)).optional(),
      workspace: z.string().optional(),
      confirm: coercedOptionalBoolean,
      phase: z.enum(['crossref']).optional(),
    },
    async (args: ReindexArgs) => runReindexTool(runtime, args),
  );
}
