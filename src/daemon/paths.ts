import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BrainPathConfig {
  brainHome: string;
  socketPath: string;
  homeDbPath: string;
  homeMigrationsDir: string;
  healthPort: number;
  packageRoot: string;
}

export function resolvePackageRoot(fromUrl: string = import.meta.url): string {
  let cursor = path.dirname(fileURLToPath(fromUrl));

  for (let depth = 0; depth < 8; depth += 1) {
    if (fs.existsSync(path.join(cursor, 'package.json'))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }

  return process.cwd();
}

export function resolveBrainHome(): string {
  const configured = process.env.BRAIN_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.brain');
}

export function resolveBrainPaths(overrides: Partial<BrainPathConfig> = {}): BrainPathConfig {
  const packageRoot = overrides.packageRoot ?? resolvePackageRoot();
  const brainHome = overrides.brainHome ?? resolveBrainHome();
  const socketPath = overrides.socketPath ?? process.env.BRAIN_SOCKET_PATH ?? path.join(brainHome, 'sock');
  const homeDbPath = overrides.homeDbPath ?? process.env.BRAIN_HOME_DB ?? path.join(brainHome, 'brain.sqlite');
  const healthPort = overrides.healthPort ?? readPositiveInt(process.env.BRAIN_HEALTH_PORT, 4815);
  const homeMigrationsDir = overrides.homeMigrationsDir ?? path.join(packageRoot, 'migrations', 'home');

  return {
    brainHome,
    socketPath,
    homeDbPath,
    homeMigrationsDir,
    healthPort,
    packageRoot,
  };
}

export function ensureBrainHome(paths: BrainPathConfig): void {
  fs.mkdirSync(paths.brainHome, { recursive: true });
  fs.mkdirSync(path.dirname(paths.socketPath), { recursive: true });
}

function readPositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
