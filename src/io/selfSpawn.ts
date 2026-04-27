import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

export interface SelfSpawnInput {
  handoffMarkdown: string;
  cwd?: string;
  claudeBin?: string;
  extraArgv?: string[];
}

export interface SelfSpawnResult {
  handoffPath: string;
  bytes: number;
  newPid: number;
  parentPid: number;
  claudeBin: string;
}

const ARGV_INLINE_LIMIT = 96 * 1024;
const SELFSPAWN_WAIT_MS = 0.05;
const SELFSPAWN_PYTHON =
  process.env.BRAIN_SELFSPAWN_PYTHON ?? process.env.REBIRTH_SELFSPAWN_PYTHON ?? 'python3';

const PYTHON_FOREGROUND_LAUNCHER = [
  'import os',
  'import signal',
  'import sys',
  'import time',
  '',
  'old_parent = int(sys.argv[1])',
  'argv = sys.argv[2:]',
  '',
  "DEBUG = os.environ.get('BRAIN_SELFSPAWN_DEBUG') == '1' or os.environ.get('REBIRTH_SELFSPAWN_DEBUG') == '1'",
  "DEBUG_LOG = f'/tmp/brain-selfspawn-{os.getpid()}.log'",
  'def dlog(msg):',
  '    if not DEBUG:',
  '        return',
  '    try:',
  "        with open(DEBUG_LOG, 'a', encoding='utf-8') as fh:",
  "            fh.write(f'[{time.time():.3f}] {msg}\\n')",
  '    except Exception:',
  '        pass',
  '',
  'def parent_reaped(pid):',
  '    try:',
  '        os.kill(pid, 0)',
  '        return False',
  '    except ProcessLookupError:',
  '        return True',
  '    except PermissionError:',
  '        return False',
  '',
  'signal.signal(signal.SIGHUP, signal.SIG_IGN)',
  'signal.signal(signal.SIGTTOU, signal.SIG_IGN)',
  'signal.signal(signal.SIGTTIN, signal.SIG_IGN)',
  '',
  "dlog(f'launcher start pid={os.getpid()} ppid={os.getppid()} old_parent={old_parent}')",
  'reap_deadline = time.monotonic() + 5.0',
  'while not parent_reaped(old_parent):',
  '    if time.monotonic() > reap_deadline:',
  "        dlog('reap deadline exceeded, proceeding anyway')",
  '        break',
  `    time.sleep(${SELFSPAWN_WAIT_MS})`,
  '',
  "tty_fd = os.open('/dev/tty', os.O_RDWR)",
  'os.setpgid(0, 0)',
  'claim_deadline = time.monotonic() + 2.0',
  'settle_stable = 0',
  'settle_required = 2',
  'attempt = 0',
  'pgrp = os.getpgrp()',
  'while time.monotonic() < claim_deadline:',
  '    attempt += 1',
  '    try:',
  '        os.tcsetpgrp(tty_fd, pgrp)',
  '    except OSError:',
  '        pass',
  '    fg = os.tcgetpgrp(tty_fd)',
  '    if fg == pgrp:',
  '        settle_stable += 1',
  '        if settle_stable >= settle_required:',
  '            break',
  '    else:',
  '        settle_stable = 0',
  '    backoff = min(0.02 * (2 ** min(attempt - 1, 4)), 0.2)',
  '    time.sleep(backoff)',
  '',
  'os.dup2(tty_fd, 0)',
  'os.dup2(tty_fd, 1)',
  'os.dup2(tty_fd, 2)',
  'if tty_fd > 2:',
  '    os.close(tty_fd)',
  '',
  "dlog(f'execvp {argv[0]!r}')",
  'os.execvp(argv[0], argv)',
].join('\n');

let monotonic = 0;

export function spawnReplacementClaude(input: SelfSpawnInput): SelfSpawnResult {
  const { handoffMarkdown, extraArgv = [] } = input;
  const cwd = input.cwd ?? process.cwd();
  const claudeBin =
    input.claudeBin ?? process.env.BRAIN_CLAUDE_BIN ?? process.env.REBIRTH_CLAUDE_BIN ?? 'claude';

  const seq = ++monotonic;
  const handoffPath = join(tmpdir(), `brain-selfspawn-handoff-${process.pid}-${Date.now()}-${seq}.md`);
  if (!existsSync(tmpdir())) mkdirSync(tmpdir(), { recursive: true });
  writeFileSync(handoffPath, handoffMarkdown, 'utf8');

  const bytes = Buffer.byteLength(handoffMarkdown, 'utf8');
  const argv = [...extraArgv];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (bytes <= ARGV_INLINE_LIMIT) {
    argv.push(handoffMarkdown);
  } else {
    env.BRAIN_SELFSPAWN_HANDOFF_PATH = handoffPath;
    env.REBIRTH_SELFSPAWN_HANDOFF_PATH = handoffPath;
  }

  let ttyIn = -1;
  let ttyOut = -1;
  let ttyErr = -1;
  try {
    ttyIn = openSync('/dev/tty', 'r');
    ttyOut = openSync('/dev/tty', 'w');
    ttyErr = openSync('/dev/tty', 'w');
  } catch (error) {
    throw new Error(
      `no controlling tty available for self-spawn: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    execFileSync(SELFSPAWN_PYTHON, ['--version'], { stdio: 'ignore' });
  } catch (error) {
    closeIfOpen(ttyIn);
    closeIfOpen(ttyOut);
    closeIfOpen(ttyErr);
    throw new Error(
      `no python launcher available for self-spawn: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let child;
  try {
    child = spawn(SELFSPAWN_PYTHON, ['-c', PYTHON_FOREGROUND_LAUNCHER, String(process.ppid), claudeBin, ...argv], {
      cwd,
      env,
      stdio: [ttyIn, ttyOut, ttyErr],
    });
  } finally {
    closeIfOpen(ttyIn);
    closeIfOpen(ttyOut);
    closeIfOpen(ttyErr);
  }

  return {
    handoffPath,
    bytes,
    newPid: child.pid ?? -1,
    parentPid: process.ppid,
    claudeBin,
  };
}

export function parentLooksLikeClaude(parentPid: number): boolean {
  if (!parentPid || parentPid <= 1) return false;

  try {
    const cmdline = readFileSync(`/proc/${parentPid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    if (/\bclaude\b/.test(cmdline)) return true;
  } catch {
    // /proc is Linux-specific; fall back to ps below.
  }

  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(parentPid)], {
      encoding: 'utf8',
    }).trim();
    return /\bclaude\b/.test(command);
  } catch {
    return false;
  }
}

export function scheduleParentKill(parentPid: number, delayMs = 200): NodeJS.Timeout {
  const timer = setTimeout(() => {
    if (parentPid <= 1) return;
    if (parentPid !== process.ppid) return;
    try {
      process.kill(parentPid, 'SIGTERM');
    } catch {
      // Parent already exited, permission denied, or PID was recycled.
    }
  }, delayMs);
  timer.unref();
  return timer;
}

function closeIfOpen(fd: number): void {
  if (fd < 0) return;
  try {
    closeSync(fd);
  } catch {
    // ignore
  }
}
