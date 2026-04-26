import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION_DIR_RELATIVE_CANDIDATES = [
  '../../migrations/atlas/',
  '../migrations/atlas/',
  './migrations/atlas/',
];

export function resolveAtlasMigrationDir(moduleUrl: string = import.meta.url): string {
  const candidates = MIGRATION_DIR_RELATIVE_CANDIDATES.map((relativePath) =>
    fileURLToPath(new URL(relativePath, moduleUrl)),
  );
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

export const ATLAS_MIGRATION_DIR = resolveAtlasMigrationDir();
