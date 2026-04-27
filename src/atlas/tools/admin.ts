/**
 * atlas_admin — composite admin/ops tool for atlas-mcp-server.
 *
 * Consolidates operational tools into a single action-dispatched interface:
 *   - init: nuke the database and reindex from scratch (destructive).
 *           Also supports bootstrapping a fresh atlas for any local git repo
 *           that does not yet have one — the repo is discovered via
 *           `discoverAllRoots` (sibling dirs of the current source root and
 *           $HOME) or by explicit `sourceRoot` path.
 *   - reindex: re-run extraction pipeline (status / dry-run / full / crossref / flush specific files)
 *   - bridge_list: discover local atlas workspaces AND indexable git repos
 *
 * Reindex action delegates to the shared runReindexTool handler from reindex.ts
 * so that state (activeReindexes, progress tracking) is shared.
 */

import path from 'node:path';
import fs from 'node:fs';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { backupAtlasDatabase, resetAtlasDatabase } from '../db.js';
import { ATLAS_MIGRATION_DIR } from '../migrationDir.js';
import { toolWithDescription } from './helpers.js';
import {
  discoverAllRoots,
  closeBridgeDb,
  openBridgeDb,
  preferredAtlasDbPath,
  resolveExistingAtlasDbPath,
  slugifyWorkspaceName,
  type DiscoveredRoot,
} from './bridge.js';
import { runReindexTool } from './reindex.js';
import { coercedOptionalBoolean } from '../../zodHelpers.js';
import {
  discoverWorktreeAtlases,
  resolveSourceDb,
  runAtlasMerge,
  formatAtlasMergeResult,
  type AtlasMergeResult,
} from '../mergeAtlas.js';

// ============================================================================
// Action handlers
// ============================================================================

interface AdminArgs {
  action: 'init' | 'reindex' | 'bridge_list' | 'merge';
  files?: string[];
  workspace?: string;
  sourceRoot?: string;
  confirm?: boolean;
  phase?: 'crossref';
  /** Source Atlas to merge FROM — worktree ID (e.g. "TABNDPgU1Ne8"), branch ("evolve/TABNDPgU1Ne8"), or absolute DB path. */
  source?: string;
}

/**
 * Resolve a target for init:
 *   1. Explicit `sourceRoot` wins — auto-derive workspace from dir basename if
 *      the caller didn't pass one. Must be a git repo (has `.git/`) to be
 *      bootstrappable; already-indexed repos are fine too.
 *   2. Otherwise match `workspace` against `discoverAllRoots` — both indexed
 *      and indexable candidates are eligible.
 */
function resolveInitTarget(
  runtime: AtlasRuntime,
  workspace?: string,
  sourceRoot?: string,
): { target: DiscoveredRoot } | { error: string } {
  if (sourceRoot) {
    const absRoot = path.resolve(sourceRoot);
    if (!fs.existsSync(absRoot)) {
      return { error: `sourceRoot does not exist: ${absRoot}` };
    }
    const stat = fs.statSync(absRoot);
    if (!stat.isDirectory()) {
      return { error: `sourceRoot is not a directory: ${absRoot}` };
    }
    const atlasPath = preferredAtlasDbPath(absRoot);
    const existingAtlas = resolveExistingAtlasDbPath(absRoot);
    const gitPath = path.join(absRoot, '.git');
    const indexed = existingAtlas != null;
    const hasGit = fs.existsSync(gitPath);
    if (!indexed && !hasGit) {
      return { error: `sourceRoot is neither an indexed atlas workspace nor a git repo: ${absRoot}` };
    }
    return {
      target: {
        workspace: workspace ?? slugifyWorkspaceName(path.basename(absRoot)),
        sourceRoot: absRoot,
        indexed,
        dbPath: atlasPath,
        existingDbPath: existingAtlas?.dbPath ?? null,
        legacy: existingAtlas?.legacy ?? false,
        hasGit,
      },
    };
  }

  if (!workspace) {
    return { error: 'init requires either `workspace` or `sourceRoot`.' };
  }

  const roots = discoverAllRoots(runtime.config.sourceRoot);
  const match = roots.find((r) => r.workspace === workspace);
  if (match) return { target: match };

  const indexedNames = roots.filter((r) => r.indexed).map((r) => r.workspace);
  const indexableNames = roots.filter((r) => !r.indexed && r.hasGit).map((r) => r.workspace);
  const parts: string[] = [`Workspace "${workspace}" not found on this machine.`];
  if (indexedNames.length > 0) parts.push(`Indexed: ${indexedNames.join(', ')}`);
  if (indexableNames.length > 0) parts.push(`Indexable git repos: ${indexableNames.join(', ')}`);
  parts.push('Pass `sourceRoot=/abs/path/to/repo` to bootstrap a repo outside the scanned directories.');
  return { error: parts.join('\n  ') };
}

async function handleInit(
  runtime: AtlasRuntime,
  workspace?: string,
  sourceRoot?: string,
  confirm?: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const targetWorkspace = workspace ?? runtime.config.workspace;
  const isCrossWorkspace = sourceRoot !== undefined || targetWorkspace !== runtime.config.workspace;

  // ── Cross-workspace init (supports bootstrapping unindexed git repos) ──
  if (isCrossWorkspace) {
    const resolved = resolveInitTarget(runtime, workspace, sourceRoot);
    if ('error' in resolved) {
      return { content: [{ type: 'text', text: resolved.error }] };
    }
    const target = resolved.target;
    const resolvedWorkspace = target.workspace;
    const isBootstrap = !target.indexed || target.legacy;

    if (!confirm) {
      const headline = isBootstrap
        ? `🌱 atlas_admin(action=init) will **bootstrap** a fresh atlas for git repo "${resolvedWorkspace}" (cross-workspace).`
        : `⚠️  atlas_admin(action=init) will **destroy** the atlas database for workspace "${resolvedWorkspace}" (cross-workspace).`;
      const body = isBootstrap
        ? [
          `  Workspace: ${resolvedWorkspace}`,
          `  Source:    ${target.sourceRoot}`,
          `  Database:  ${target.dbPath} (will be created)`,
          '',
          'No existing atlas database will be touched. A new `.brain/atlas.sqlite` will be created',
          'and the full extraction pipeline will run (structure → flow → crossref → cluster).',
          'Call with confirm=true to proceed.',
        ]
        : [
          `  Workspace: ${resolvedWorkspace}`,
          `  Database:  ${target.dbPath}`,
          `  Source:    ${target.sourceRoot}`,
          '',
          'This deletes all extractions, embeddings, changelog entries, symbols, references, and community clusters.',
          'A backup will be created automatically before destruction.',
          'Call with confirm=true to proceed.',
        ];
      return { content: [{ type: 'text', text: [headline, '', ...body].join('\n') }] };
    }

    // Close any cached bridge handle (for indexed targets) before nuking
    if (target.indexed && target.existingDbPath) closeBridgeDb(target.existingDbPath);

    // Fresh DB handle — resetAtlasDatabase handles both "exists (nuke)" and
    // "doesn't exist (create)" cases. When the file is absent, backupAtlasDatabase
    // returns null, deleteAtlasDatabaseFiles silently ignores ENOENT, and
    // openAtlasDatabase auto-creates the `.brain/` directory via ensureDirectory.
    const freshDb = resetAtlasDatabase({
      dbPath: target.dbPath,
      migrationDir: ATLAS_MIGRATION_DIR,
      sqliteVecExtension: runtime.config.sqliteVecExtension,
      embeddingDimensions: runtime.config.embeddingDimensions,
    });

    // Build temporary runtime targeting the remote workspace
    const tempRuntime: AtlasRuntime = {
      config: {
        ...runtime.config,
        workspace: resolvedWorkspace,
        sourceRoot: target.sourceRoot,
        dbPath: target.dbPath,
      },
      db: freshDb,
      server: runtime.server,
    };

    const reindexResult = await runReindexTool(tempRuntime, { confirm: true });
    const reindexText = reindexResult.content.map((c) => c.text).join('\n');

    const statusLine = isBootstrap
      ? `🌱 Fresh atlas created for git repo "${resolvedWorkspace}" at ${target.sourceRoot}`
      : `🔥 Database nuked and recreated for workspace "${resolvedWorkspace}" (cross-workspace).`;
    const trailer = isBootstrap
      ? '💡 Once extraction settles, query it via `atlas_query action=search workspace=' + resolvedWorkspace + '`.'
      : '💾 A backup was automatically saved to .brain/backups/ before destruction. Use it to restore if needed.';

    return {
      content: [
        { type: 'text', text: `${statusLine}\n\n${reindexText}` },
        { type: 'text', text: trailer },
      ],
    };
  }

  // ── Local init ──
  if (!confirm) {
    return {
      content: [{
        type: 'text',
        text: [
          '⚠️  atlas_admin(action=init) will **destroy** the current atlas database and rebuild from scratch.',
          '',
          `  Workspace: ${runtime.config.workspace}`,
          `  Database:  ${runtime.config.dbPath}`,
          '',
          'This deletes all extractions, embeddings, changelog entries, symbols, references, and community clusters.',
          'A backup will be created automatically before destruction.',
          'Call with confirm=true to proceed.',
        ].join('\n'),
      }],
    };
  }

  // Nuke and reopen (resetAtlasDatabase auto-backs up first)
  const freshDb = resetAtlasDatabase(
    {
      dbPath: runtime.config.dbPath,
      migrationDir: ATLAS_MIGRATION_DIR,
      sqliteVecExtension: runtime.config.sqliteVecExtension,
      embeddingDimensions: runtime.config.embeddingDimensions,
    },
    runtime.db,
  );

  // Swap the live db handle so the rest of the server uses the fresh database
  (runtime as { db: typeof freshDb }).db = freshDb;

  // Kick off full reindex
  const reindexResult = await runReindexTool(runtime, { confirm: true });
  const reindexText = reindexResult.content.map((c) => c.text).join('\n');

  return {
    content: [
      { type: 'text', text: `🔥 Database nuked and recreated for workspace "${runtime.config.workspace}".\n\n${reindexText}` },
      { type: 'text', text: '💾 A backup was automatically saved to .brain/backups/ before destruction. Use it to restore if needed.' },
    ],
  };
}

async function handleBridgeList(
  runtime: AtlasRuntime,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const roots = discoverAllRoots(runtime.config.sourceRoot);
  if (roots.length === 0) {
    return {
      content: [{ type: 'text', text: 'No atlas databases or git repos found on this machine.' }],
    };
  }

  const getFileCount = (db: import('../db.js').AtlasDatabase, workspace: string): number => {
    try {
      const row = db.prepare('SELECT count(*) as cnt FROM atlas_files WHERE workspace = ?').get(workspace) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch {
      return 0;
    }
  };

  const indexedLines: string[] = [];
  const indexableLines: string[] = [];
  for (const root of roots) {
    if (root.indexed) {
      const bdb = openBridgeDb(root.workspace, root.sourceRoot);
      const count = bdb ? getFileCount(bdb.db, root.workspace) : 0;
      indexedLines.push(`📦 ${root.workspace} — ${count} files\n   ${root.sourceRoot}`);
    } else if (root.hasGit) {
      indexableLines.push(`🌱 ${root.workspace} — not indexed yet (git repo)\n   ${root.sourceRoot}`);
    }
  }

  const sections: string[] = [];
  if (indexedLines.length > 0) {
    sections.push(`Indexed workspaces (${indexedLines.length}):\n${indexedLines.join('\n\n')}`);
  }
  if (indexableLines.length > 0) {
    sections.push(`Indexable (not yet indexed) git repos (${indexableLines.length}):\n${indexableLines.join('\n\n')}`);
  }

  const tips: string[] = [];
  if (indexedLines.length > 0) {
    tips.push('💡 Query any indexed workspace with `atlas_query action=search workspace=<name>`.');
  }
  if (indexableLines.length > 0) {
    tips.push('💡 Bootstrap an unindexed repo with `atlas_admin action=init workspace=<name> confirm=true`.');
    tips.push('   Or pass `sourceRoot=/abs/path/to/repo` for git repos outside the scanned dirs.');
  }

  return {
    content: [
      {
        type: 'text',
        text: [
          `🌉 Atlas Bridge — ${indexedLines.length} indexed, ${indexableLines.length} indexable`,
          '',
          sections.join('\n\n'),
        ].join('\n'),
      },
      { type: 'text', text: tips.join('\n') },
    ],
  };
}

async function handleMerge(
  runtime: AtlasRuntime,
  source?: string,
  confirm?: boolean,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  if (!source) {
    // List available worktree Atlases
    const worktrees = discoverWorktreeAtlases(runtime.config.sourceRoot);
    if (worktrees.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No git worktree Atlas databases found. Pass `source=<path>` to merge from an arbitrary Atlas database.',
        }],
      };
    }
    const lines = worktrees.map((wt) =>
      `  ${wt.branch}\n    Path: ${wt.worktreePath}\n    DB:   ${wt.dbPath}`,
    );
    return {
      content: [{
        type: 'text',
        text: [
          'Available worktree Atlas databases:',
          '',
          ...lines,
          '',
          'Usage: `atlas_admin action=merge source=<worktree-id-or-branch> confirm=true`',
          'Omit confirm=true for a dry-run preview.',
        ].join('\n'),
      }],
    };
  }

  const resolved = resolveSourceDb(runtime.config.sourceRoot, source);
  if ('error' in resolved) {
    return { content: [{ type: 'text', text: resolved.error }] };
  }

  const sourceDbPath = resolved.dbPath;
  const sourceLabel = resolved.label;

  if (!confirm) {
    const preview = runAtlasMerge(runtime.db, sourceDbPath, runtime.config.dbPath, { apply: false });
    return {
      content: [{
        type: 'text',
        text: [
          formatAtlasMergeResult(preview, sourceLabel, { dryRun: true }),
        ].join('\n'),
      }],
    };
  }

  // Backup before applying
  const backupPath = backupAtlasDatabase(runtime.config.dbPath);

  const result = runAtlasMerge(runtime.db, sourceDbPath, runtime.config.dbPath, { apply: true }) as AtlasMergeResult;
  result.backupPath = backupPath ?? null;

  return {
    content: [{
      type: 'text',
      text: formatAtlasMergeResult(result, sourceLabel, { dryRun: false }),
    }],
  };
}

// ============================================================================
// Registration
// ============================================================================

export function registerAdminTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_admin',
    [
      'Strategic operations tool for Atlas maintenance, refresh, and workspace discovery.',
      'Use atlas_admin when the Atlas itself needs to be updated or inspected, not when you want code answers from the Atlas.',
      'Actions: init destroys the database and rebuilds from scratch (requires confirm=true, auto-backs up to .brain/backups/ before destruction) — or bootstraps a brand-new atlas for any local git repo that does not yet have one; reindex reruns extraction work and is the main way to refresh Atlas state after code changes; bridge_list discovers every local Atlas workspace AND every indexable git repo on the machine; merge ports atlas_files metadata and atlas_changelog entries from a worktree or external Atlas database into the local Atlas — use after merging a git worktree branch to bring agent-authored Atlas commits along.',
      'Fresh-index bootstrap: `atlas_admin action=init workspace=<name> confirm=true` works for any git repo next to the current source root or inside $HOME, even without an existing .brain/ directory. For repos outside those dirs, pass `sourceRoot=/abs/path/to/repo`. A new `.brain/atlas.sqlite` is created and the full pipeline runs (structure → flow → crossref → cluster). No existing data is touched when bootstrapping.',
      'Merge workflow: after `git merge <worktree-branch>`, run `atlas_admin action=merge source=<worktree-id>` to preview, then `atlas_admin action=merge source=<worktree-id> confirm=true` to apply. Omit `source` to list available worktree Atlas databases. The merge inserts new atlas_files records, updates existing records with richer metadata from the source, and ports missing atlas_changelog entries (deduped by file_path + summary + created_at). A backup is created automatically before applying.',
      'Workflow hints: prefer reindex over init — init destroys all changelog history and agent metadata; use reindex with no args first to inspect status before starting work; use files=[...] for targeted refreshes after touching a few files; use confirm=true only when you actually want to launch a broader run; use phase="crossref" for cross-reference-only refreshes when structural passes are already current; use bridge_list before querying another workspace so you see what is indexed AND what is indexable; use merge after merging a git worktree branch to port the worktree Atlas data into the local Atlas without manual SQL surgery.',
      'The refreshed pipeline now feeds richer outputs, including AST-verified structural edges, deterministic flow analysis, heuristic crossref cross-references, and Leiden community clusters, so admin actions directly control the quality and freshness of those higher-value results.',
    ].join('\n'),
    {
      action: z.enum(['init', 'reindex', 'bridge_list', 'merge']),
      files: z.array(z.string().min(1)).optional().describe('File paths to re-extract (reindex action)'),
      workspace: z.string().optional().describe('Target workspace (defaults to current). For init, can name an indexed workspace, an indexable git repo, or an arbitrary slug when paired with sourceRoot.'),
      sourceRoot: z.string().optional().describe('Absolute path to a git repo to init (escape hatch for repos outside the auto-scanned dirs). When omitted, init resolves the workspace by name via discoverAllRoots.'),
      confirm: coercedOptionalBoolean.describe('Confirm destructive or write actions (init, reindex, merge). Default: dry-run / preview'),
      phase: z.enum(['crossref']).optional().describe('Limit reindex to crossref phase only'),
      source: z.string().optional().describe('Source Atlas to merge from — worktree ID (e.g. "TABNDPgU1Ne8"), branch name ("evolve/TABNDPgU1Ne8"), or absolute path to an atlas.sqlite file. Omit to list available worktree Atlases.'),
    },
    async (args: AdminArgs) => {
      switch (args.action) {
        case 'init':
          return handleInit(runtime, args.workspace, args.sourceRoot, args.confirm);
        case 'reindex':
          return runReindexTool(runtime, {
            files: args.files,
            workspace: args.workspace,
            confirm: args.confirm,
            phase: args.phase,
          });
        case 'bridge_list':
          return handleBridgeList(runtime);
        case 'merge':
          return handleMerge(runtime, args.source, args.confirm);
        default:
          return {
            content: [{
              type: 'text',
              text: `Unknown atlas_admin action: ${String((args as { action: string }).action)}. Valid: init, reindex, bridge_list, merge.`,
            }],
          };
      }
    },
  );
}
