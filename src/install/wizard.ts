import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { installShim } from './shim.js';
import { initBrainHome } from './brainHome.js';
import { warmEmbeddings } from './embeddings.js';
import { installClaudeGuidance } from './claudeMd.js';

/**
 * `brain setup` — one-command install wizard for brain-mcp.
 *
 * Steps (each independent, each idempotent):
 *   1. shim       — append `claude() { brain-claude "$@"; }` to user's rc file
 *   2. mcp        — `claude mcp add brain-mcp -s user -- ...`
 *   3. brain-home — create ~/.brain/, run home migrations on brain.sqlite
 *   4. claude-md  — append atlas-first usage primer to ~/.claude/CLAUDE.md
 *   5. embeddings — pre-fetch the HF model so first MCP call isn't slow
 *
 * Failures in one step do not abort the others. Re-running on an already-
 * installed system is a no-op (each step reports already-installed).
 */

export type WizardStep = 'shim' | 'mcp' | 'brain-home' | 'claude-md' | 'embeddings';

export type WizardStatus =
  | 'installed'
  | 'already-installed'
  | 'updated'
  | 'created'
  | 'warmed'
  | 'already-warm'
  | 'skipped'
  | 'dry-run'
  | 'failed'
  | 'failed-precondition';

export interface WizardStepResult {
  step: WizardStep;
  status: WizardStatus;
  detail: string;
}

export interface WizardResult {
  steps: WizardStepResult[];
  ok: boolean;
}

export interface WizardOptions {
  dryRun?: boolean;
  noShim?: boolean;
  noMcp?: boolean;
  noBrainHome?: boolean;
  noClaudeMd?: boolean;
  noEmbeddings?: boolean;
  shell?: string;
  rcFile?: string;
  home?: string;
  packageRoot?: string;
  claudeBin?: string;
  embeddingModel?: string;
}

/**
 * Resolve our own package root by walking up from this module. Handles dev
 * (tsx from src/), unbundled compiled (dist/install/wizard.js → 2 up), and
 * `npm link` symlinks (realpath-resolved by Node before import.meta.url).
 */
function detectPackageRoot(): string {
  const fallback = process.cwd();
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    here = fallback;
  }
  let cur = here;
  for (let i = 0; i < 5; i += 1) {
    const pkg = join(cur, 'package.json');
    if (existsSync(pkg)) {
      try {
        const parsed = JSON.parse(readFileSync(pkg, 'utf8')) as { name?: string };
        if (parsed.name === '@voxxo/brain-mcp') return cur;
      } catch {
        // unreadable / invalid JSON — keep walking
      }
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return pathResolve(here, '..', '..');
}

export async function runWizard(opts: WizardOptions = {}): Promise<WizardResult> {
  const home = opts.home ?? homedir();
  const packageRoot = opts.packageRoot ?? detectPackageRoot();
  const dryRun = !!opts.dryRun;
  const steps: WizardStepResult[] = [];

  if (!opts.noShim) {
    steps.push(runShimStep({ shell: opts.shell, rcFile: opts.rcFile, dryRun, home }));
  }

  if (!opts.noMcp) {
    steps.push(runMcpStep({ dryRun, claudeBin: opts.claudeBin, packageRoot }));
  }

  if (!opts.noBrainHome) {
    steps.push(runBrainHomeStep({ dryRun }));
  }

  if (!opts.noClaudeMd) {
    steps.push(runClaudeMdStep({ dryRun, home }));
  }

  if (!opts.noEmbeddings) {
    steps.push(await runEmbeddingsStep({ dryRun, model: opts.embeddingModel }));
  }

  const ok = steps.every((s) => s.status !== 'failed' && s.status !== 'failed-precondition');
  return { steps, ok };
}

// ── Step: shell shim ─────────────────────────────────────────────────

function runShimStep(opts: {
  shell?: string;
  rcFile?: string;
  dryRun: boolean;
  home: string;
}): WizardStepResult {
  const result = installShim({
    shell: opts.shell,
    rcFile: opts.rcFile,
    dryRun: opts.dryRun,
    home: opts.home,
  });
  if (!result.ok) {
    return { step: 'shim', status: 'failed', detail: result.reason };
  }
  if (result.status === 'already-installed') {
    return {
      step: 'shim',
      status: 'already-installed',
      detail: `shim present in ${result.target.rcPath} (shell=${result.target.shell})`,
    };
  }
  if (result.status === 'dry-run') {
    return {
      step: 'shim',
      status: 'dry-run',
      detail: `would append shim to ${result.target.rcPath} (shell=${result.target.shell})`,
    };
  }
  const backupNote = result.backupPath ? ` (backup: ${result.backupPath})` : '';
  return {
    step: 'shim',
    status: 'installed',
    detail: `appended shim to ${result.target.rcPath} (shell=${result.target.shell})${backupNote}`,
  };
}

// ── Step: MCP server registration ────────────────────────────────────

/**
 * Pick the brain-mcp invocation for `claude mcp add`. Preference order:
 *   1. `brain-mcp` on PATH (installed via npm link or npm install -g)
 *   2. absolute path to this package's dist/bin/brain-mcp.js (dev/local)
 *
 * Skipping `npx -y @voxxo/brain-mcp` until the package is on a registry —
 * an offline machine would silently fail otherwise.
 */
function chooseBrainMcpInvocation(packageRoot: string): { command: string; args: string[] } | null {
  const onPath = spawnSync('command', ['-v', 'brain-mcp'], { encoding: 'utf8', shell: true });
  if (onPath.status === 0 && (onPath.stdout ?? '').trim()) {
    return { command: 'brain-mcp', args: [] };
  }
  const abs = join(packageRoot, 'dist', 'bin', 'brain-mcp.js');
  if (existsSync(abs)) {
    return { command: 'node', args: [abs] };
  }
  return null;
}

function runMcpStep(opts: { dryRun: boolean; claudeBin?: string; packageRoot: string }): WizardStepResult {
  const claude = opts.claudeBin ?? 'claude';

  const probe = spawnSync(claude, ['mcp', 'list'], { encoding: 'utf8' });
  if (probe.error) {
    const code = (probe.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        step: 'mcp',
        status: 'failed-precondition',
        detail:
          '`claude` CLI not on PATH — install Claude Code first, then re-run `brain setup`. ' +
          'Manual fallback: `claude mcp add brain-mcp -s user -- brain-mcp`',
      };
    }
    return {
      step: 'mcp',
      status: 'failed',
      detail: `\`claude mcp list\` failed: ${probe.error.message}`,
    };
  }
  const listOutput = (probe.stdout ?? '') + (probe.stderr ?? '');
  if (/^brain-mcp:/m.test(listOutput)) {
    return {
      step: 'mcp',
      status: 'already-installed',
      detail: '`brain-mcp` MCP server already registered (use `claude mcp list` to inspect)',
    };
  }

  const invocation = chooseBrainMcpInvocation(opts.packageRoot);
  if (!invocation) {
    return {
      step: 'mcp',
      status: 'failed-precondition',
      detail:
        `could not find brain-mcp binary on PATH or at ${opts.packageRoot}/dist/bin/brain-mcp.js — ` +
        'run `npm install` + `npm run build` first, or `npm link` the package globally.',
    };
  }

  if (opts.dryRun) {
    const cmd = ['claude', 'mcp', 'add', 'brain-mcp', '-s', 'user', '--', invocation.command, ...invocation.args].join(' ');
    return {
      step: 'mcp',
      status: 'dry-run',
      detail: `would run: ${cmd}`,
    };
  }

  const add = spawnSync(
    claude,
    ['mcp', 'add', 'brain-mcp', '-s', 'user', '--', invocation.command, ...invocation.args],
    { encoding: 'utf8' },
  );
  if (add.status !== 0) {
    const out = ((add.stdout ?? '') + (add.stderr ?? '')).trim();
    return {
      step: 'mcp',
      status: 'failed',
      detail: `\`claude mcp add\` exited ${add.status}: ${out || '(no output)'}`,
    };
  }
  return {
    step: 'mcp',
    status: 'installed',
    detail: `registered \`brain-mcp\` at user scope (command: ${invocation.command} ${invocation.args.join(' ')})`,
  };
}

// ── Step: brain home init ────────────────────────────────────────────

function runBrainHomeStep(opts: { dryRun: boolean }): WizardStepResult {
  const result = initBrainHome({ dryRun: opts.dryRun });
  if (!result.ok) {
    return { step: 'brain-home', status: 'failed', detail: result.detail };
  }
  if (opts.dryRun) {
    return { step: 'brain-home', status: 'dry-run', detail: result.detail };
  }
  if (result.status === 'created') {
    return { step: 'brain-home', status: 'created', detail: result.detail };
  }
  if (result.status === 'updated') {
    return { step: 'brain-home', status: 'updated', detail: result.detail };
  }
  return { step: 'brain-home', status: 'already-installed', detail: result.detail };
}

// ── Step: ~/.claude/CLAUDE.md guidance ───────────────────────────────

function runClaudeMdStep(opts: { dryRun: boolean; home: string }): WizardStepResult {
  const result = installClaudeGuidance({ home: opts.home, dryRun: opts.dryRun });
  if (!result.ok) {
    return {
      step: 'claude-md',
      status: 'failed',
      detail: result.reason ?? `failed to update ${result.targetPath}`,
    };
  }
  if (result.status === 'already-installed') {
    return {
      step: 'claude-md',
      status: 'already-installed',
      detail: `atlas guidance already present in ${result.targetPath}`,
    };
  }
  if (result.status === 'dry-run') {
    return {
      step: 'claude-md',
      status: 'dry-run',
      detail: `would append atlas guidance to ${result.targetPath}`,
    };
  }
  const backupNote = result.backupPath ? ` (backup: ${result.backupPath})` : '';
  return {
    step: 'claude-md',
    status: 'installed',
    detail: `appended atlas guidance to ${result.targetPath}${backupNote}`,
  };
}

// ── Step: embedding warmup ───────────────────────────────────────────

async function runEmbeddingsStep(opts: { dryRun: boolean; model?: string }): Promise<WizardStepResult> {
  const result = await warmEmbeddings({ dryRun: opts.dryRun, model: opts.model });
  if (!result.ok) {
    return { step: 'embeddings', status: 'failed', detail: result.detail };
  }
  if (opts.dryRun) {
    return { step: 'embeddings', status: 'dry-run', detail: result.detail };
  }
  if (result.status === 'already-warm') {
    return { step: 'embeddings', status: 'already-warm', detail: result.detail };
  }
  return { step: 'embeddings', status: 'warmed', detail: result.detail };
}

// ── Reporting ────────────────────────────────────────────────────────

const STATUS_GLYPH: Record<WizardStatus, string> = {
  installed: '✓',
  'already-installed': '·',
  updated: '✓',
  created: '✓',
  warmed: '✓',
  'already-warm': '·',
  skipped: '·',
  'dry-run': '?',
  failed: '✗',
  'failed-precondition': '!',
};

const STEP_LABEL: Record<WizardStep, string> = {
  shim: 'shell shim   ',
  mcp: 'MCP server   ',
  'brain-home': 'brain home   ',
  'claude-md': 'CLAUDE.md    ',
  embeddings: 'embeddings   ',
};

export function formatWizardResult(result: WizardResult): string {
  const lines: string[] = [];
  for (const s of result.steps) {
    lines.push(`  ${STATUS_GLYPH[s.status]} ${STEP_LABEL[s.step]}  ${s.detail}`);
  }
  return lines.join('\n');
}

export function formatWizardFooter(result: WizardResult): string {
  const lines: string[] = [];

  const shim = result.steps.find((s) => s.step === 'shim');
  if (shim && shim.status === 'installed') {
    lines.push(
      'Open a NEW terminal (or `source ~/.zshrc` / `source ~/.bashrc`) so the',
      '`claude` shell function is live. From then on, every `claude` invocation',
      'runs through the brain-claude wrapper.',
    );
  }

  const mcp = result.steps.find((s) => s.step === 'mcp');
  if (mcp && (mcp.status === 'installed' || mcp.status === 'already-installed')) {
    if (lines.length > 0) lines.push('');
    lines.push(
      'If Claude Code is already running, restart it so the new MCP server',
      'connects (existing sessions stay bound to whatever was registered',
      'when they started).',
    );
  }

  if (mcp && mcp.status === 'failed-precondition') {
    if (lines.length > 0) lines.push('');
    lines.push(mcp.detail);
  }

  return lines.length === 0 ? '' : lines.join('\n');
}
