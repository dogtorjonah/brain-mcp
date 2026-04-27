#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { BrainDaemon } from '../daemon/server.js';

interface CliOptions {
  socketPath?: string;
  brainHome?: string;
  homeDbPath?: string;
  healthPort?: number;
  atlasPoolSize?: number;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const daemon = new BrainDaemon({
    paths: {
      socketPath: options.socketPath,
      brainHome: options.brainHome,
      homeDbPath: options.homeDbPath,
      healthPort: options.healthPort,
    },
    atlasPoolSize: options.atlasPoolSize,
  });

  await daemon.start();
  process.stderr.write('[brain-daemon] ready\n');

  const shutdown = (): void => {
    void daemon.stop().finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (!arg) continue;

    if (arg === '--socket' && next) {
      options.socketPath = next;
      index += 1;
    } else if (arg === '--home' && next) {
      options.brainHome = next;
      index += 1;
    } else if (arg === '--db' && next) {
      options.homeDbPath = next;
      index += 1;
    } else if (arg === '--health-port' && next) {
      options.healthPort = readPositiveInt(next);
      index += 1;
    } else if (arg === '--atlas-pool-size' && next) {
      options.atlasPoolSize = readPositiveInt(next);
      index += 1;
    }
  }

  return options;
}

function readPositiveInt(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
