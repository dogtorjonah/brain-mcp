/**
 * Test helpers — in-memory database factories for unit/integration tests.
 *
 * Uses HomeDb.open({ path: ':memory:', migrationsDir }) for ephemeral
 * databases that don't pollute the filesystem.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HomeDb } from '../src/home/db.js';
import { EdgeEmitter } from '../src/edges/emitter.js';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const MIGRATIONS_DIR = resolve(__dirname, '..', 'migrations', 'home');

/**
 * Create an in-memory HomeDb with all migrations applied.
 * The database is fully ephemeral — nothing persists after close().
 */
export function createTestHomeDb(): HomeDb {
  return HomeDb.open({ path: ':memory:', migrationsDir: MIGRATIONS_DIR });
}

/**
 * Create an EdgeEmitter backed by an in-memory HomeDb.
 * Useful for edge emission/query tests without touching the filesystem.
 */
export function createTestEdgeEmitter(): { emitter: EdgeEmitter; homeDb: HomeDb } {
  const homeDb = createTestHomeDb();
  const emitter = new EdgeEmitter(homeDb);
  return { emitter, homeDb };
}
