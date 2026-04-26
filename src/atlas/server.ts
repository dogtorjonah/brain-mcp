#!/usr/bin/env node
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openAtlasDatabase } from './db.js';
import { loadAtlasConfig } from './config.js';
import { runFullPipeline } from './pipeline/index.js';
import { startAtlasWatcher } from './watcher.js';
import { registerChangelogTools } from './tools/changelog.js';
import { registerCommitTool } from './tools/commit.js';
// Composite tools (21 → 5 consolidation — individual tools removed)
import { registerQueryTool } from './tools/query.js';
import { registerGraphCompositeTool } from './tools/graphComposite.js';
import { registerAuditTool } from './tools/audit.js';
import { registerAdminTool } from './tools/admin.js';
import { ATLAS_CONTEXT_RESOURCE_URI, generateContextResource } from './resources/context.js';
import { ATLAS_MIGRATION_DIR } from './migrationDir.js';
import type { AtlasRuntime } from './types.js';

function parseInitArgs(argv: string[]): {
  targetRoot: string;
  configArgs: string[];
  useWizard: boolean;
  force: boolean;
  phase?: 'crossref';
  files: string[];
} {
  const configArgs: string[] = [];
  const files: string[] = [];
  let force = false;
  let wizardRequested = false;
  let phase: 'crossref' | undefined;
  let targetRoot = process.cwd();
  let targetAssigned = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg) continue;

    if (arg === '--yes') {
      // No-op: retained for CLI compat but no cost confirmation needed
      continue;
    }
    if (arg === '--wizard') {
      wizardRequested = true;
      continue;
    }
    if (arg === '--force') {
      force = true;
      continue;
    }
    if (arg === '--phase') {
      const value = argv[index + 1];
      if (value === 'crossref') {
        phase = 'crossref';
      }
      if (value) {
        index += 1;
      }
      continue;
    }
    if (arg === '--file') {
      const value = argv[index + 1];
      if (value) {
        files.push(value);
        index += 1;
      }
      continue;
    }
    if (arg.startsWith('--')) {
      configArgs.push(arg);
      const value = argv[index + 1];
      if (value && !value.startsWith('--')) {
        configArgs.push(value);
        index += 1;
      }
      continue;
    }
    if (!targetAssigned) {
      targetRoot = path.resolve(arg);
      targetAssigned = true;
      continue;
    }
    configArgs.push(arg);
  }

  const useWizard = wizardRequested || (argv.length === 0 && process.stdin.isTTY && process.stdout.isTTY);
  return {
    targetRoot,
    configArgs,
    useWizard,
    force,
    phase,
    files,
  };
}

/**
 * Auto-install atlas into Claude Code's global settings (~/.claude/settings.json).
 * Runs after every `atlas init` — idempotent, never prompts.
 */
function installGlobalMcpConfig(): void {
  try {
    // Resolve the path to dist/server.js (works whether running via tsx or compiled)
    const thisFile = fileURLToPath(import.meta.url);
    const distServerJs = thisFile.endsWith('.ts')
      ? path.resolve(path.dirname(thisFile), '..', 'dist', 'server.js')
      : thisFile;

    const claudeDir = path.join(os.homedir(), '.claude');
    const settingsPath = path.join(claudeDir, 'settings.json');

    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    const mcpServers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    const existing = mcpServers.atlas as Record<string, unknown> | undefined;

    // Check if already installed with the same path
    if (existing && Array.isArray(existing.args) && existing.args[0] === distServerJs) {
      console.log('[atlas-init] ✓ Claude Code global config already set');
      return;
    }

    mcpServers.atlas = {
      command: 'node',
      args: [distServerJs],
    };
    settings.mcpServers = mcpServers;

    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log('[atlas-init] ✓ Installed atlas into ~/.claude/settings.json (global)');
    console.log('[atlas-init]   Atlas tools are now available in Claude Code for ALL repos.');
  } catch (err) {
    // Non-fatal — don't block init if we can't write settings
    console.log(`[atlas-init] ⚠ Could not auto-install to Claude Code global config: ${err instanceof Error ? err.message : err}`);
    console.log('[atlas-init]   You can manually add atlas to ~/.claude/settings.json');
  }
}

async function promptInitWizard(config: import('./types.js').AtlasServerConfig): Promise<import('./types.js').AtlasServerConfig> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return config;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    console.log('');
    console.log('╔══════════════════════════════════════╗');
    console.log('║       Atlas — Setup Wizard           ║');
    console.log('╚══════════════════════════════════════╝');
    console.log('');

    // 1. Codebase path
    const sourceRootAnswer = await rl.question(`  Codebase path [${config.sourceRoot}]: `);
    const sourceRoot = path.resolve(sourceRootAnswer.trim() || config.sourceRoot);

    // 2. Workspace name
    const workspaceDefault = path.basename(sourceRoot).toLowerCase();
    const workspaceAnswer = await rl.question(`  Workspace name [${workspaceDefault}]: `);
    const workspace = workspaceAnswer.trim() || workspaceDefault;

    // 3. Concurrency
    const concurrencyAnswer = await rl.question(`  Concurrency [${config.concurrency}]: `);
    const parsedConcurrency = Number.parseInt(concurrencyAnswer.trim(), 10);
    const concurrency = Number.isFinite(parsedConcurrency) && parsedConcurrency > 0 ? parsedConcurrency : config.concurrency;

    // Summary
    console.log('');
    console.log('  ─────────────────────────────────────');
    console.log(`  Codebase:    ${sourceRoot}`);
    console.log(`  Workspace:   ${workspace}`);
    console.log(`  Pipeline:    deterministic (AST + import graph + cross-refs)`);
    console.log(`  Concurrency: ${concurrency}`);
    console.log('  ─────────────────────────────────────');
    console.log('');

    return {
      ...config,
      sourceRoot,
      workspace,
      dbPath: path.join(sourceRoot, '.brain', 'atlas.sqlite'),
      concurrency,
    };
  } finally {
    rl.close();
  }
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const isInit = argv[0] === 'init';
  const initArgs = isInit ? parseInitArgs(argv.slice(1)) : null;
  let targetRoot = isInit ? initArgs?.targetRoot ?? process.cwd() : process.cwd();
  const configArgs = isInit ? initArgs?.configArgs ?? [] : argv;
  const config = loadAtlasConfig(configArgs, {
    sourceRoot: targetRoot,
    dbPath: path.join(targetRoot, '.brain', 'atlas.sqlite'),
    workspace: path.basename(targetRoot).toLowerCase(),
  });

  if (isInit) {
    const initConfig = initArgs?.useWizard ? await promptInitWizard(config) : config;
    targetRoot = initConfig.sourceRoot;
    if (initArgs?.force) {
      console.log('[atlas-init] --force supplied; database will be deleted and rebuilt from scratch');
    }

    console.log('[atlas-init] starting heuristic pipeline');
    await runFullPipeline(targetRoot, {
      ...initConfig,
      sourceRoot: targetRoot,
      dbPath: initConfig.dbPath,
      concurrency: initConfig.concurrency,
      migrationDir: ATLAS_MIGRATION_DIR,
      force: initArgs?.force ?? false,
      phase: initArgs?.phase,
      files: initArgs?.files,
    });

    // Auto-install atlas MCP server into Claude Code global settings
    installGlobalMcpConfig();

    return;
  }

  const db = openAtlasDatabase({
    dbPath: config.dbPath,
    migrationDir: ATLAS_MIGRATION_DIR,
    sqliteVecExtension: config.sqliteVecExtension,
    embeddingDimensions: config.embeddingDimensions,
  });

  const runtime: AtlasRuntime = { config, db };

  const server = new McpServer({
    name: '@voxxo/atlas',
    version: '0.1.0',
  });
  runtime.server = server;

  server.resource(
    'Atlas Codebase Context',
    ATLAS_CONTEXT_RESOURCE_URI,
    {
      description: 'Auto-updated codebase context. Subscribe for automatic injection of relevant file knowledge on every change.',
      mimeType: 'text/markdown',
    },
    async () => ({
      contents: [{
        uri: ATLAS_CONTEXT_RESOURCE_URI,
        mimeType: 'text/markdown',
        text: generateContextResource(db, runtime.config.workspace),
      }],
    }),
  );

  // ── Standalone tools (not in any composite) ──
  registerChangelogTools(server, runtime);
  registerCommitTool(server, runtime);

  // ── Composite tools (21 → 5 consolidation) ──
  // atlas_query:  search, lookup, brief, snippet, similar, plan_context, cluster, patterns, history
  // atlas_graph:  impact, neighbors, trace, cycles, reachability, graph, cluster
  // atlas_audit:  gaps, smells, hotspots
  // atlas_admin:  reindex, bridge_list
  registerQueryTool(server, runtime);
  registerGraphCompositeTool(server, runtime);
  registerAuditTool(server, runtime);
  registerAdminTool(server, runtime);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const stopWatcher = startAtlasWatcher(runtime);
  const shutdown = (): void => {
    stopWatcher();
    try {
      db.close();
    } catch {
      // ignore close-on-shutdown races
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdin.once('close', shutdown);
}

const entrypoint = process.argv[1];

if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
