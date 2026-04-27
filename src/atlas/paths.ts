import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CURRENT_FILE = fileURLToPath(import.meta.url);
const ATLAS_DIR = path.dirname(CURRENT_FILE);
const SRC_DIR = path.resolve(ATLAS_DIR, '..');
const PACKAGE_ROOT = path.resolve(SRC_DIR, '..');

export function getAtlasCorePackageRoot(): string {
  return PACKAGE_ROOT;
}

export function getAtlasCoreMigrationsDir(): string {
  return path.join(PACKAGE_ROOT, 'migrations', 'atlas');
}
