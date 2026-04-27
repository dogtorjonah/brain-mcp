import type { CallerContext } from '../daemon/protocol.js';

const FORWARDED_ENV_KEYS = [
  'CLAUDE_IDENTITY',
  'CLAUDE_SESSION_ID',
  'CLAUDE_PROJECT_DIR',
  'BRAIN_WRAPPER_PID',
  'BRAIN_WRAPPER_PROJECT_DIR',
  'BRAIN_CLAUDE_BIN',
  'REBIRTH_WRAPPER_PID',
  'REBIRTH_WRAPPER_PROJECT_DIR',
  'REBIRTH_CLAUDE_BIN',
  'BRAIN_HOME',
  'BRAIN_SOCKET_PATH',
];

export function buildCallerContext(): CallerContext {
  const env: Record<string, string> = {};
  for (const key of FORWARDED_ENV_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  const wrapperPid = readInt(process.env.BRAIN_WRAPPER_PID) ?? readInt(process.env.REBIRTH_WRAPPER_PID);
  const identity = process.env.CLAUDE_IDENTITY?.trim() || undefined;
  const sessionId = process.env.CLAUDE_SESSION_ID?.trim() || undefined;
  const projectDir =
    process.env.BRAIN_WRAPPER_PROJECT_DIR?.trim() ||
    process.env.REBIRTH_WRAPPER_PROJECT_DIR?.trim() ||
    process.env.CLAUDE_PROJECT_DIR?.trim() ||
    undefined;

  return {
    cwd: process.cwd(),
    pid: process.pid,
    ppid: process.ppid,
    startedAt: Date.now(),
    identity,
    sessionId,
    wrapperPid,
    projectDir,
    env,
  };
}

function readInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}
