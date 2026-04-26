import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATION_DIR_RELATIVE_CANDIDATES = [
  './migrations/',
  // Built relay output does not currently copy SQL assets into dist/.
  // Fall back to the source tree so atlas init/reindex still finds migrations.
  '../../src/atlas/migrations/',
  '../../../../src/atlas/migrations/',
];

export function resolveAtlasMigrationDir(moduleUrl: string = import.meta.url): string {
  const candidates = MIGRATION_DIR_RELATIVE_CANDIDATES.map((relativePath) =>
    fileURLToPath(new URL(relativePath, moduleUrl)),
  );
  return candidates.find((dir) => fs.existsSync(dir)) ?? candidates[0];
}

export const ATLAS_MIGRATION_DIR = resolveAtlasMigrationDir();
