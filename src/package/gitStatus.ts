import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Captures a git working-tree snapshot at handoff time. Unlike every other
 * section, this one CAN'T be reconstructed from the .jsonl — the transcript
 * has no record of uncommitted changes or the current HEAD. A successor
 * reborn into an already-modified tree can't see diffs until they `git
 * status` themselves, which wastes a turn. Capturing it synchronously at
 * build time puts the tree state directly in the handoff.
 *
 * Soft-fails in every direction: not a repo, git binary missing, subprocess
 * timeout, non-zero exit — all return null and the section is omitted.
 */

export interface GitSnapshot {
  branch: string;
  ahead: number;
  behind: number;
  headOneline: string;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  renamed: string[];
  conflicted: string[];
}

interface RunResult {
  ok: boolean;
  stdout: string;
}

function run(cwd: string, args: string[], timeoutMs = 2000): RunResult {
  try {
    const stdout = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return { ok: true, stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
}

/**
 * Parse porcelain v1 `git status -b --porcelain` output. Format:
 *   ## branch...upstream [ahead N, behind M]
 *   XY path
 *   XY path1 -> path2   (rename)
 *
 * X = staged status, Y = unstaged status. '?' in both means untracked.
 * 'U' in either or 'AA'/'DD' means merge conflict.
 */
function parsePorcelain(text: string): Omit<GitSnapshot, 'headOneline'> {
  const lines = text.split('\n');
  let branch = '(detached)';
  let ahead = 0;
  let behind = 0;
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const renamed: string[] = [];
  const conflicted: string[] = [];

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('## ')) {
      const rest = line.slice(3);
      // Pull counters off the tail if present.
      const aheadMatch = /\[.*?ahead (\d+)/.exec(rest);
      const behindMatch = /\[.*?behind (\d+)/.exec(rest);
      if (aheadMatch?.[1]) ahead = Number(aheadMatch[1]);
      if (behindMatch?.[1]) behind = Number(behindMatch[1]);
      // Strip bracket block and split on ... for branch name.
      const head = rest.replace(/\s*\[.*?\]\s*$/, '');
      branch = head.split('...')[0] ?? '(unknown)';
      continue;
    }
    if (line.length < 3) continue;
    const x = line[0]!;
    const y = line[1]!;
    const path = line.slice(3);
    const isRename = x === 'R' || y === 'R';
    const isConflict =
      x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D');
    if (isConflict) {
      conflicted.push(path);
      continue;
    }
    if (x === '?' && y === '?') {
      untracked.push(path);
      continue;
    }
    if (isRename) {
      renamed.push(path);
    }
    if (x !== ' ' && x !== '?') staged.push(path);
    if (y !== ' ' && y !== '?') unstaged.push(path);
  }

  return { branch, ahead, behind, staged, unstaged, untracked, renamed, conflicted };
}

/**
 * Walk up from an arbitrary path (file or directory) until a `.git` entry
 * is found. Returns the repo root dir or null if none found before /. Uses
 * filesystem-only checks (no subprocess) so we can collect roots for every
 * file-in-context entry without paying a git fork per entry.
 *
 * `.git` may be a directory (normal repo) or a file (submodule or worktree
 * pointer); both are accepted. Missing paths resolve to their parent dir
 * before the walk begins so we tolerate file paths whose filename no
 * longer exists on disk.
 */
export function findRepoRoot(pathIn: string | undefined): string | null {
  if (!pathIn) return null;
  let cursor = resolve(pathIn);
  try {
    if (!existsSync(cursor) || statSync(cursor).isFile()) {
      cursor = dirname(cursor);
    }
  } catch {
    cursor = dirname(cursor);
  }
  while (cursor && cursor !== '/' && cursor.length > 1) {
    const marker = `${cursor}/.git`;
    if (existsSync(marker)) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}

export function collectGitSnapshot(cwd: string): GitSnapshot | null {
  // Quick sanity: is this a repo?
  const check = run(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (!check.ok || check.stdout.trim() !== 'true') return null;

  const status = run(cwd, ['status', '-b', '--porcelain']);
  if (!status.ok) return null;
  const parsed = parsePorcelain(status.stdout);

  const head = run(cwd, ['log', '-1', '--oneline', '--no-color']);
  const headOneline = head.ok ? head.stdout.trim() : '(no HEAD)';

  return { ...parsed, headOneline };
}

function fmtList(label: string, items: string[], maxShown = 20): string[] {
  if (items.length === 0) return [];
  const shown = items.slice(0, maxShown);
  const lines: string[] = [`  ${label} (${items.length}):`];
  for (const p of shown) lines.push(`    • ${p}`);
  if (items.length > maxShown) lines.push(`    …and ${items.length - maxShown} more`);
  return lines;
}

export interface RenderGitStatusOptions {
  /** Header label override. Defaults to the primary "Git Working Tree" title. */
  heading?: string;
  /** Extra line appended to the intro block (e.g. "cross-repo edits detected"). */
  subtitle?: string;
}

export function renderGitStatus(
  cwd: string | undefined,
  opts: RenderGitStatusOptions = {},
): string {
  if (!cwd) return '';
  const heading = opts.heading ?? 'Git Working Tree (captured at handoff time)';
  const snap = collectGitSnapshot(cwd);
  // Negative-assertion stub: if we tried and there's no repo (or git
  // failed), say so explicitly. Beats silent omission — the successor
  // knows whether "no git section" means "not a repo" vs "bug in rebirth".
  if (!snap) {
    return [`── ${heading} ──`, '', `(not a git repository at ${cwd}, or git unavailable)`, ''].join('\n');
  }

  const total =
    snap.staged.length +
    snap.unstaged.length +
    snap.untracked.length +
    snap.conflicted.length;
  const divergence =
    snap.ahead === 0 && snap.behind === 0
      ? 'in sync with upstream'
      : `ahead ${snap.ahead} / behind ${snap.behind}`;

  const parts: string[] = [`── ${heading} ──`, ''];
  if (opts.subtitle) {
    parts.push(opts.subtitle, '');
  }
  parts.push(
    `Repo:       ${cwd}`,
    `Branch:     ${snap.branch} — ${divergence}`,
    `HEAD:       ${snap.headOneline}`,
    `Dirty:      ${total === 0 ? 'clean' : `${total} file${total === 1 ? '' : 's'}`}`,
    '',
  );

  parts.push(...fmtList('Staged', snap.staged));
  parts.push(...fmtList('Unstaged', snap.unstaged));
  parts.push(...fmtList('Untracked', snap.untracked));
  parts.push(...fmtList('Renamed', snap.renamed));
  parts.push(...fmtList('Conflicted', snap.conflicted));
  parts.push('');
  return parts.join('\n');
}
