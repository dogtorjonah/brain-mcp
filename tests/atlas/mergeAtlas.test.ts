import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverWorktreeAtlases, resolveSourceDb } from '../../src/atlas/mergeAtlas.js';

const tempRoots: string[] = [];

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepoWithAtlasWorktree(): {
  repoRoot: string;
  worktreeRoot: string;
  worktreeDbPath: string;
} {
  const tempRoot = path.join(tmpdir(), `brain-mcp-merge-${process.pid}-${Date.now()}`);
  tempRoots.push(tempRoot);
  const repoRoot = path.join(tempRoot, 'repo');
  const worktreeRoot = path.join(tempRoot, 'feature-worktree');
  mkdirSync(repoRoot, { recursive: true });

  git(repoRoot, ['init']);
  git(repoRoot, ['config', 'user.email', 'test@example.com']);
  git(repoRoot, ['config', 'user.name', 'Test User']);
  writeFileSync(path.join(repoRoot, 'README.md'), '# test\n', 'utf8');
  git(repoRoot, ['add', 'README.md']);
  git(repoRoot, ['commit', '-m', 'initial']);
  git(repoRoot, ['worktree', 'add', '-b', 'feature/atlas', worktreeRoot]);

  const worktreeAtlasDir = path.join(worktreeRoot, '.brain');
  const worktreeDbPath = path.join(worktreeAtlasDir, 'atlas.sqlite');
  mkdirSync(worktreeAtlasDir, { recursive: true });
  writeFileSync(worktreeDbPath, 'placeholder', 'utf8');

  return { repoRoot, worktreeRoot, worktreeDbPath };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('mergeAtlas worktree discovery', () => {
  const runIfGit = gitAvailable() ? it : it.skip;

  runIfGit('discovers standard git worktrees with brain-mcp Atlas databases', () => {
    const { repoRoot, worktreeRoot, worktreeDbPath } = createRepoWithAtlasWorktree();

    expect(discoverWorktreeAtlases(repoRoot)).toEqual([
      {
        branch: 'feature/atlas',
        dbPath: worktreeDbPath,
        worktreePath: worktreeRoot,
      },
    ]);
  });

  runIfGit('resolves branch names and explicit worktree directories', () => {
    const { repoRoot, worktreeRoot, worktreeDbPath } = createRepoWithAtlasWorktree();

    expect(resolveSourceDb(repoRoot, 'feature/atlas')).toEqual({
      dbPath: worktreeDbPath,
      label: 'feature/atlas',
    });
    expect(resolveSourceDb(repoRoot, worktreeRoot)).toEqual({
      dbPath: worktreeDbPath,
      label: worktreeRoot,
    });
  });
});
