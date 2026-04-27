import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';

/**
 * Append a brain-mcp / atlas usage primer to the user's global
 * ~/.claude/CLAUDE.md so every Claude Code session in any project picks
 * up the workflow guidance without the user having to author it.
 *
 * Append-only with BEGIN/END sentinels — never overwrites user content
 * outside the marker block. Re-running on an already-installed system
 * is a no-op (status: 'already-installed'). The block can be safely
 * removed by hand by deleting between the sentinels.
 *
 * The block lives at the END of CLAUDE.md (so user-authored guidance
 * above it stays visually primary); a future update could replace just
 * the marker block in place if we need to ship a revised primer.
 */

export const BEGIN_GUIDANCE_SENTINEL =
  '<!-- >>> brain-mcp atlas guidance (auto-managed; do not edit between markers) >>> -->';
export const END_GUIDANCE_SENTINEL = '<!-- <<< brain-mcp atlas guidance <<< -->';

export const GUIDANCE_BODY = [
  BEGIN_GUIDANCE_SENTINEL,
  '',
  '## Brain & Atlas — use these tools first',
  '',
  'When the project has brain-mcp tools available (look for `mcp__brain-mcp__atlas_*` or',
  '`mcp__brain-mcp__brain_*` in your tool list), **prefer them over raw `Read` / `Grep` / `Glob`',
  'for codebase investigation.** The atlas already knows what every indexed file does, what it',
  'exports, what depends on it, and what hazards it carries — built up over many prior sessions.',
  '',
  '### Default pattern',
  '',
  '1. **`brain_resume`** — call at session start. Returns open hazards, recent commits, files',
  '   last touched, active SOPs, and a synthesized next-step hint.',
  '2. **`atlas_query action="search"`** — find files by keyword, symbol, or natural-language query.',
  '3. **`atlas_query action="plan_context"`** — orientation: given a task description, returns a',
  '   curated pack of the files most likely to matter.',
  '4. **`atlas_query action="lookup"`** — read a specific file. **Replaces `Read`** for indexed',
  '   codebase files because it returns the source plus structured metadata (purpose, public API,',
  '   hazards, patterns, conventions, cross-references). Files ≤500 lines come back in full;',
  '   larger files auto-paginate via the `offset` param in the returned footer.',
  '5. **`atlas_graph`** — import / call / reachability queries for cross-references and blast radius.',
  '6. **`atlas_audit`** — find gaps, smells, hotspots affecting a file or the whole workspace.',
  '',
  '### When raw `Read` / `Grep` / `Glob` is still correct',
  '',
  '- You already know the exact file + line range and atlas is overkill.',
  '- Atlas reports the file is stale (hash mismatch) — verify against raw source.',
  '- Files outside the indexed workspace (e.g. `/tmp`, generated dirs).',
  '- Non-source files (images, binaries, lockfiles, data dumps).',
  '',
  '### After editing',
  '',
  'Run `atlas_commit` on the files you touched. It records purpose / hazards / patterns /',
  'source highlights so the next agent that looks the file up benefits from your context.',
  'This is how the graph stays fresh.',
  '',
  '### The one-line rule',
  '',
  '**Atlas first; raw reads second; commit to atlas after meaningful edits.**',
  '',
  END_GUIDANCE_SENTINEL,
].join('\n');

export type GuidanceStatus = 'installed' | 'already-installed' | 'dry-run';

export interface InstallGuidanceResult {
  ok: boolean;
  status: GuidanceStatus;
  reason?: string;
  targetPath: string;
  backupPath?: string;
}

export function claudeMdPath(home?: string): string {
  return pathResolve(home ?? homedir(), '.claude', 'CLAUDE.md');
}

/**
 * Append the atlas guidance block to ~/.claude/CLAUDE.md.
 *   - Creates the file (and parent dir) if missing.
 *   - Returns 'already-installed' if the BEGIN sentinel is already present.
 *   - Otherwise appends with a backup copy of the prior file (if any).
 */
export function installClaudeGuidance(opts: {
  home?: string;
  dryRun?: boolean;
} = {}): InstallGuidanceResult {
  const targetPath = claudeMdPath(opts.home);
  const dryRun = !!opts.dryRun;

  const existing = existsSync(targetPath) ? safeRead(targetPath) : '';
  if (existing.includes(BEGIN_GUIDANCE_SENTINEL)) {
    return {
      ok: true,
      status: 'already-installed',
      targetPath,
    };
  }

  if (dryRun) {
    return { ok: true, status: 'dry-run', targetPath };
  }

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
  } catch (err) {
    return {
      ok: false,
      status: 'installed',
      reason: `could not ensure parent dir: ${err instanceof Error ? err.message : String(err)}`,
      targetPath,
    };
  }

  let backupPath: string | undefined;
  if (existing) {
    backupPath = `${targetPath}.brain-mcp.bak`;
    try {
      renameSync(targetPath, backupPath);
    } catch {
      // Backup is best-effort; if rename fails (e.g. read-only mount), keep
      // going with the in-memory copy and skip the backup file.
      backupPath = undefined;
    }
  }

  const separator = existing && !existing.endsWith('\n') ? '\n\n' : existing ? '\n' : '';
  const newContent = `${existing}${separator}${GUIDANCE_BODY}\n`;

  try {
    writeFileSync(targetPath, newContent, 'utf8');
  } catch (err) {
    return {
      ok: false,
      status: 'installed',
      reason: `could not write CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`,
      targetPath,
      ...(backupPath ? { backupPath } : {}),
    };
  }

  return {
    ok: true,
    status: 'installed',
    targetPath,
    ...(backupPath ? { backupPath } : {}),
  };
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}
