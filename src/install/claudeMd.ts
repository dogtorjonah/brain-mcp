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
  '## brain-mcp',
  '',
  'If brain-mcp tools are available in this session, use them as the memory and codebase context layer.',
  '',
  '- **`brain_resume`** — call at session start to pick up where the last session left off.',
  '- **`atlas_query`** — prefer over `Read`/`Grep`/`Glob` for codebase investigation.',
  '  `search` to find files, `lookup` to read one (returns source + metadata in one call),',
  '  `plan_context` for multi-file orientation.',
  '- **`atlas_commit`** — run on files you edited. Keeps the atlas fresh for future sessions.',
  '- **`brain_search`** — cross-silo search across transcripts, atlas files, changelogs, and source',
  '  highlights. BM25 + vector fusion. Use it to find past decisions, prior work on a file, or anything',
  '  the atlas and transcript history know about.',
  '- **`brain_search action="star"`** — pin cognitive waypoints (`category=decision|discovery|pivot|handoff|gotcha|result`)',
  '  that persist into the rebirth handoff package. Pin decisions and pivots as they happen.',
  '- **`brain_rebirth`** — trigger a rebirth when context is noisy or a task phase is complete.',
  '  The successor wakes up with a curated handoff including your starred waypoints.',
  '',
  'Fall back to raw `Read`/`Grep` for non-indexed files, exact known snippets, or stale atlas entries.',
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
