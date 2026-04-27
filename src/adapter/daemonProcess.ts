import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainDaemonClient } from './client.js';
import type { CallerContext } from '../daemon/protocol.js';
import { resolveBrainPaths } from '../daemon/paths.js';

export interface EnsureDaemonOptions {
  caller?: CallerContext;
  startupTimeoutMs?: number;
}

export async function ensureBrainDaemon(options: EnsureDaemonOptions = {}): Promise<void> {
  const client = new BrainDaemonClient();
  if (await canPing(client, options.caller)) return;

  spawnDaemonProcess();
  const deadline = Date.now() + (options.startupTimeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    await sleep(100);
    if (await canPing(client, options.caller)) return;
  }

  throw new Error('brain-daemon did not become ready before startup timeout');
}

async function canPing(client: BrainDaemonClient, caller?: CallerContext): Promise<boolean> {
  try {
    await client.ping(caller);
    return true;
  } catch {
    return false;
  }
}

function spawnDaemonProcess(): void {
  const overrideCommand = process.env.BRAIN_DAEMON_COMMAND?.trim();
  if (overrideCommand) {
    const overrideArgs = parseArgs(process.env.BRAIN_DAEMON_ARGS);
    const child = spawn(overrideCommand, overrideArgs, {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
    return;
  }

  const currentFile = fileURLToPath(import.meta.url);
  const paths = resolveBrainPaths();
  const distDaemon = path.join(paths.packageRoot, 'dist', 'bin', 'brain-daemon.js');
  const srcDaemon = path.join(paths.packageRoot, 'src', 'bin', 'brain-daemon.ts');

  const command = process.execPath;
  const args = fs.existsSync(distDaemon)
    ? [distDaemon]
    : ['--import', 'tsx', srcDaemon];

  const child = spawn(command, args, {
    cwd: paths.packageRoot,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      BRAIN_SOCKET_PATH: process.env.BRAIN_SOCKET_PATH ?? paths.socketPath,
      BRAIN_HOME: process.env.BRAIN_HOME ?? paths.brainHome,
    },
  });
  child.unref();

  if (!fs.existsSync(distDaemon) && !currentFile.endsWith('.ts')) {
    process.stderr.write('[brain-mcp] spawned daemon through tsx because dist/bin/brain-daemon.js is not built yet\n');
  }
}

function parseArgs(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Fall back to whitespace split.
  }
  return value.split(/\s+/).filter(Boolean);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
