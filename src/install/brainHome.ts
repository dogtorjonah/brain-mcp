/**
 * Initialize ~/.brain/ — the brain-mcp home directory.
 *
 * Creates the directory if missing, opens the home DB (which runs all
 * pending migrations from the package's migrations/home/ dir), and
 * closes it. After this step, `brain.sqlite` exists with the latest
 * schema and the daemon can attach to it on first MCP call.
 *
 * Idempotent: re-running is cheap (mkdir is recursive, migrations are
 * versioned).
 */
import { existsSync, mkdirSync } from 'node:fs';

import { HomeDb } from '../home/db.js';
import { resolveBrainPaths } from '../daemon/paths.js';

export interface InitBrainHomeResult {
  ok: boolean;
  status: 'created' | 'updated' | 'already-initialized' | 'failed';
  brainHome: string;
  homeDbPath: string;
  detail: string;
}

export function initBrainHome(opts: { dryRun?: boolean } = {}): InitBrainHomeResult {
  const paths = resolveBrainPaths();

  if (opts.dryRun) {
    const willCreate = !existsSync(paths.homeDbPath);
    return {
      ok: true,
      status: willCreate ? 'created' : 'already-initialized',
      brainHome: paths.brainHome,
      homeDbPath: paths.homeDbPath,
      detail: `would ensure ${paths.brainHome}/ and run migrations on ${paths.homeDbPath}`,
    };
  }

  try {
    mkdirSync(paths.brainHome, { recursive: true });
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      brainHome: paths.brainHome,
      homeDbPath: paths.homeDbPath,
      detail: `could not create ${paths.brainHome}: ${(err as Error).message}`,
    };
  }

  const dbExisted = existsSync(paths.homeDbPath);
  let db: HomeDb;
  try {
    db = HomeDb.open({
      path: paths.homeDbPath,
      migrationsDir: paths.homeMigrationsDir,
    });
  } catch (err) {
    return {
      ok: false,
      status: 'failed',
      brainHome: paths.brainHome,
      homeDbPath: paths.homeDbPath,
      detail: `could not open ${paths.homeDbPath}: ${(err as Error).message}`,
    };
  }

  try {
    db.close();
  } catch {
    // ignore — migration ran fine, close failure is harmless.
  }

  return {
    ok: true,
    status: dbExisted ? 'updated' : 'created',
    brainHome: paths.brainHome,
    homeDbPath: paths.homeDbPath,
    detail: dbExisted
      ? `migrations applied to ${paths.homeDbPath}`
      : `created ${paths.brainHome}/ and initialized ${paths.homeDbPath}`,
  };
}
