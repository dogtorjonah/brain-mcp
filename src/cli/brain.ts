#!/usr/bin/env node
/**
 * `brain` — multi-subcommand CLI dispatcher.
 *
 * Subcommands:
 *   setup           — one-command install wizard (shim + MCP + brain-home + embeddings)
 *   migrate         — import from rebirth-mcp's home directory
 *   install-shim    — append `claude()` shell function to rc file
 *   uninstall-shim  — remove the shell function
 *   warm-embeddings — pre-fetch the local HF embedding model
 *   help            — print usage
 */
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

import { runWizard, formatWizardResult, formatWizardFooter } from '../install/wizard.js';
import { installShim, uninstallShim, SHIM_BODY } from '../install/shim.js';
import { warmEmbeddings } from '../install/embeddings.js';
import { runMigrate } from './migrate.js';

interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  let command: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[body] = next;
          i++;
        } else {
          flags[body] = true;
        }
      }
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

function printHelp(): void {
  process.stdout.write(
    [
      'brain — brain-mcp install + maintenance CLI',
      '',
      'Usage:',
      '  brain setup           [--dry-run] [--no-shim] [--no-mcp] [--no-brain-home]',
      '                        [--no-embeddings] [--shell zsh|bash] [--rc-file PATH]',
      '                        [--embedding-model NAME]',
      '  brain migrate         [--dry-run]',
      '  brain install-shim    [--shell zsh|bash] [--rc-file PATH] [--dry-run] [--print]',
      '  brain uninstall-shim  [--shell zsh|bash] [--rc-file PATH] [--dry-run]',
      '  brain warm-embeddings [--model NAME]',
      '  brain help',
      '',
      'setup runs the four install steps idempotently:',
      '  shim       — append `claude() { brain-claude "$@"; }` to your rc file',
      '  mcp        — register brain-mcp via `claude mcp add brain-mcp -s user`',
      '  brain-home — create ~/.brain/ and run home migrations on brain.sqlite',
      '  embeddings — pre-fetch the local HF embedding model (~30MB)',
      '',
      'Skip any step with --no-<step>. Each step is independent — a failure',
      'in one does not abort the others.',
      '',
    ].join('\n'),
  );
}

async function runSetupCommand(flags: Record<string, string | boolean>): Promise<number> {
  const result = await runWizard({
    dryRun: !!flags['dry-run'],
    noShim: !!flags['no-shim'],
    noMcp: !!flags['no-mcp'],
    noBrainHome: !!flags['no-brain-home'],
    noEmbeddings: !!flags['no-embeddings'],
    shell: typeof flags['shell'] === 'string' ? flags['shell'] : undefined,
    rcFile: typeof flags['rc-file'] === 'string' ? flags['rc-file'] : undefined,
    embeddingModel: typeof flags['embedding-model'] === 'string' ? flags['embedding-model'] : undefined,
  });
  process.stdout.write('brain setup:\n' + formatWizardResult(result) + '\n');
  const footer = formatWizardFooter(result);
  if (footer) process.stdout.write('\n' + footer + '\n');
  return result.ok ? 0 : 1;
}

function runInstallShimCommand(flags: Record<string, string | boolean>): number {
  if (flags['print']) {
    process.stdout.write(SHIM_BODY + '\n');
    return 0;
  }
  const result = installShim({
    shell: typeof flags['shell'] === 'string' ? flags['shell'] : undefined,
    rcFile: typeof flags['rc-file'] === 'string' ? flags['rc-file'] : undefined,
    dryRun: !!flags['dry-run'],
  });
  if (!result.ok) {
    process.stderr.write(`brain: install-shim failed (${result.reason})\n`);
    return 1;
  }
  const { status, target } = result;
  if (status === 'already-installed') {
    process.stdout.write(`brain: shim already installed in ${target.rcPath} (shell=${target.shell}) — nothing to do.\n`);
    return 0;
  }
  if (status === 'dry-run') {
    process.stdout.write(
      [
        `brain: DRY RUN — would append shim to ${target.rcPath} (shell=${target.shell}):`,
        '',
        result.preview ?? SHIM_BODY,
        '',
      ].join('\n'),
    );
    return 0;
  }
  const backupNote = result.backupPath ? `  Backup: ${result.backupPath}` : '  (rc file did not exist — no backup needed)';
  process.stdout.write(
    [
      `brain: shim installed in ${target.rcPath} (shell=${target.shell})`,
      backupNote,
      '',
      '  Open a new terminal or `source` your rc file so the `claude` function is live.',
      '',
    ].join('\n'),
  );
  return 0;
}

function runUninstallShimCommand(flags: Record<string, string | boolean>): number {
  const result = uninstallShim({
    shell: typeof flags['shell'] === 'string' ? flags['shell'] : undefined,
    rcFile: typeof flags['rc-file'] === 'string' ? flags['rc-file'] : undefined,
    dryRun: !!flags['dry-run'],
  });
  if (!result.ok) {
    process.stderr.write(`brain: uninstall-shim failed (${result.reason})\n`);
    return 1;
  }
  const { status, target } = result;
  if (status === 'not-installed') {
    process.stdout.write(`brain: no shim found in ${target.rcPath} (shell=${target.shell}) — nothing to remove.\n`);
    return 0;
  }
  if (status === 'dry-run') {
    process.stdout.write(`brain: DRY RUN — would strip shim block from ${target.rcPath} (shell=${target.shell}).\n`);
    return 0;
  }
  process.stdout.write(
    [
      `brain: shim removed from ${target.rcPath} (shell=${target.shell}).`,
      '  The `claude` function persists in already-open shells until they restart',
      '  or you `unset -f claude`.',
      '',
    ].join('\n'),
  );
  return 0;
}

async function runWarmEmbeddingsCommand(flags: Record<string, string | boolean>): Promise<number> {
  const result = await warmEmbeddings({
    model: typeof flags['model'] === 'string' ? flags['model'] : undefined,
  });
  if (!result.ok) {
    process.stderr.write(`brain: warm-embeddings failed (${result.detail})\n`);
    return 1;
  }
  process.stdout.write(`brain: ${result.detail}\n`);
  return 0;
}

export async function runCli(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (!command || command === 'help' || flags['help']) {
    printHelp();
    return 0;
  }

  switch (command) {
    case 'setup':
      return runSetupCommand(flags);

    case 'migrate':
      runMigrate({ dryRun: !!flags['dry-run'] });
      return 0;

    case 'install-shim':
      return runInstallShimCommand(flags);

    case 'uninstall-shim':
      return runUninstallShimCommand(flags);

    case 'warm-embeddings':
      return runWarmEmbeddingsCommand(flags);

    default:
      process.stderr.write(`brain: unknown command "${command}"\n\n`);
      printHelp();
      return 1;
  }
}

const rawEntrypoint = process.argv[1];
let resolvedEntrypoint: string | null = null;
if (rawEntrypoint) {
  try {
    resolvedEntrypoint = realpathSync(rawEntrypoint);
  } catch {
    resolvedEntrypoint = rawEntrypoint;
  }
}
if (resolvedEntrypoint && import.meta.url === pathToFileURL(resolvedEntrypoint).href) {
  void runCli(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(message + '\n');
      process.exit(1);
    });
}
