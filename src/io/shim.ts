import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve as pathResolve } from 'node:path';

export const BEGIN_SHIM_SENTINEL = '# >>> brain-mcp shim (auto-managed; do not edit between markers) >>>';
export const END_SHIM_SENTINEL = '# <<< brain-mcp shim <<<';

export const SHIM_BODY = [
  BEGIN_SHIM_SENTINEL,
  '# Transparently wrap `claude` so brain_respawn can relaunch it in-place.',
  '# Safe to remove with: brain uninstall-shim',
  'claude() {',
  '  if command -v brain-claude >/dev/null 2>&1; then',
  '    command brain-claude "$@"',
  '  else',
  '    command claude "$@"',
  '  fi',
  '}',
  END_SHIM_SENTINEL,
].join('\n');

export type SupportedShell = 'zsh' | 'bash';

export interface ShimTarget {
  shell: SupportedShell;
  rcPath: string;
}

export interface InstallShimOptions {
  shell?: string;
  rcFile?: string;
  dryRun?: boolean;
  home?: string;
  shellEnv?: string;
}

export interface UninstallShimOptions {
  shell?: string;
  rcFile?: string;
  dryRun?: boolean;
  home?: string;
  shellEnv?: string;
}

export type InstallShimResult =
  | { ok: true; status: 'installed' | 'already-installed' | 'dry-run'; target: ShimTarget; backupPath?: string; preview?: string }
  | { ok: false; reason: string };

export type UninstallShimResult =
  | { ok: true; status: 'removed' | 'not-installed' | 'dry-run'; target: ShimTarget }
  | { ok: false; reason: string };

export function detectShellTarget(opts: {
  shellOverride?: string;
  rcFileOverride?: string;
  home?: string;
  shellEnv?: string;
}): ShimTarget | null {
  const home = opts.home ?? homedir();

  if (opts.rcFileOverride) {
    const rcPath = pathResolve(opts.rcFileOverride);
    const base = basename(rcPath).toLowerCase();
    const inferredShell: SupportedShell = base.includes('zsh') ? 'zsh' : 'bash';
    const shell = normaliseShellName(opts.shellOverride) ?? inferredShell;
    return { shell, rcPath };
  }

  const shell = normaliseShellName(opts.shellOverride) ?? normaliseShellName(opts.shellEnv ?? process.env.SHELL);
  if (!shell) return null;

  const rcFile = shell === 'zsh' ? '.zshrc' : '.bashrc';
  return { shell, rcPath: pathResolve(home, rcFile) };
}

export function installShim(opts: InstallShimOptions = {}): InstallShimResult {
  const target = detectShellTarget({
    shellOverride: opts.shell,
    rcFileOverride: opts.rcFile,
    home: opts.home,
    shellEnv: opts.shellEnv,
  });
  if (!target) {
    return {
      ok: false,
      reason: `could not detect shell (SHELL=${process.env.SHELL ?? 'unset'}). Pass --shell zsh|bash or --rc-file <path>.`,
    };
  }

  const existing = safeReadFile(target.rcPath) ?? '';
  if (existing.includes(BEGIN_SHIM_SENTINEL)) {
    return { ok: true, status: 'already-installed', target };
  }

  const needsBlankLine = existing.length > 0 && !existing.endsWith('\n\n');
  const separator = existing.length === 0 ? '' : existing.endsWith('\n') ? (needsBlankLine ? '\n' : '') : '\n\n';
  const next = `${existing}${separator}${SHIM_BODY}\n`;

  if (opts.dryRun) {
    return { ok: true, status: 'dry-run', target, preview: SHIM_BODY };
  }

  const backupPath = writeBackupIfMissing(target.rcPath, existing);
  writeFileSync(target.rcPath, next, 'utf8');
  return { ok: true, status: 'installed', target, backupPath: backupPath ?? undefined };
}

export function uninstallShim(opts: UninstallShimOptions = {}): UninstallShimResult {
  const target = detectShellTarget({
    shellOverride: opts.shell,
    rcFileOverride: opts.rcFile,
    home: opts.home,
    shellEnv: opts.shellEnv,
  });
  if (!target) {
    return {
      ok: false,
      reason: `could not detect shell (SHELL=${process.env.SHELL ?? 'unset'}). Pass --shell zsh|bash or --rc-file <path>.`,
    };
  }

  const existing = safeReadFile(target.rcPath);
  if (existing === null) return { ok: true, status: 'not-installed', target };

  const beginIdx = existing.indexOf(BEGIN_SHIM_SENTINEL);
  if (beginIdx < 0) return { ok: true, status: 'not-installed', target };

  const endIdx = existing.indexOf(END_SHIM_SENTINEL, beginIdx);
  if (endIdx < 0) {
    return {
      ok: false,
      reason: `found BEGIN sentinel in ${target.rcPath} but no matching END sentinel; edit manually.`,
    };
  }

  const before = existing.slice(0, beginIdx).replace(/\n+$/, '');
  const after = existing.slice(endIdx + END_SHIM_SENTINEL.length).replace(/^\n+/, '');
  const joiner = before.length === 0 ? '' : after.length === 0 ? '\n' : '\n\n';
  const next = `${before}${joiner}${after}${after.endsWith('\n') || after.length === 0 ? '' : '\n'}`;

  if (opts.dryRun) {
    return { ok: true, status: 'dry-run', target };
  }

  writeFileSync(target.rcPath, next, 'utf8');
  return { ok: true, status: 'removed', target };
}

function normaliseShellName(name: string | undefined): SupportedShell | null {
  if (!name) return null;
  const base = basename(name).toLowerCase();
  if (base.includes('zsh')) return 'zsh';
  if (base.includes('bash')) return 'bash';
  return null;
}

function safeReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function writeBackupIfMissing(rcPath: string, contents: string): string | null {
  if (contents.length === 0) return null;
  const primary = `${rcPath}.brain-backup`;
  if (!existsSync(primary)) {
    writeFileSync(primary, contents, 'utf8');
    return primary;
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(primary, `${primary}-${ts}`);
  writeFileSync(primary, contents, 'utf8');
  return primary;
}
