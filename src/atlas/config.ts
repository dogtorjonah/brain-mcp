import fs from 'node:fs';
import path from 'node:path';
import type { AtlasServerConfig } from './types.js';
import { DEFAULT_EMBED_CONFIG } from '../persistence/denseRetrieval/types.js';

export interface AtlasConfigDefaults {
  sourceRoot?: string;
  dbPath?: string;
  workspace?: string;
}

function readArgValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : undefined;
}

function readInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readAtlasEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const result: Record<string, string> = {};
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex < 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if (!key) {
      continue;
    }

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\''))) {
      value = value.slice(1, -1).replaceAll('\\n', '\n').replaceAll('\\"', '"').replaceAll("\\'", '\'');
    }

    result[key] = value;
  }

  return result;
}

function normalizeEnvValue(value: string | undefined): string {
  return value && value.trim() !== '' ? value.trim() : '';
}

function readAtlasEnv(name: string, atlasEnv: Record<string, string>): string | undefined {
  const value = normalizeEnvValue(atlasEnv[name]);
  return value || undefined;
}

function readConfigValue(
  args: string[],
  argName: string,
  envName: string,
  atlasEnv: Record<string, string>,
): string | undefined {
  return readArgValue(args, argName) ?? readEnv(envName) ?? readAtlasEnv(envName, atlasEnv);
}

export function writeAtlasEnvFile(filePath: string, values: Record<string, string | undefined | null>): void {
  const existing = readAtlasEnvFile(filePath);
  const merged: Record<string, string> = {
    ...existing,
  };

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      merged[key] = value;
    } else if (value == null) {
      merged[key] = '';
    }
  }

  const keys = Object.keys(merged).sort((left, right) => left.localeCompare(right));
  const content = keys.map((key) => `${key}=${JSON.stringify(merged[key] ?? '')}`).join('\n');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, 'utf8');
}

export function loadAtlasConfig(
  argv = process.argv.slice(2),
  defaults: AtlasConfigDefaults = {},
): AtlasServerConfig {
  const cwd = process.cwd();
  const seedSourceRoot = readArgValue(argv, '--source-root') ?? readEnv('ATLAS_SOURCE_ROOT') ?? defaults.sourceRoot ?? cwd;
  const seedAtlasEnv = readAtlasEnvFile(path.join(seedSourceRoot, '.atlas', '.env'));
  const sourceRoot = readConfigValue(argv, '--source-root', 'ATLAS_SOURCE_ROOT', seedAtlasEnv) ?? defaults.sourceRoot ?? cwd;
  const atlasEnv = sourceRoot === seedSourceRoot
    ? seedAtlasEnv
    : {
        ...seedAtlasEnv,
        ...readAtlasEnvFile(path.join(sourceRoot, '.atlas', '.env')),
      };
  const workspace = readConfigValue(argv, '--workspace', 'ATLAS_WORKSPACE', atlasEnv)
    ?? defaults.workspace
    ?? path.basename(sourceRoot).toLowerCase();
  const dbPath = readConfigValue(argv, '--db', 'ATLAS_DB_PATH', atlasEnv)
    ?? defaults.dbPath
    ?? path.join(sourceRoot, '.atlas', 'atlas.sqlite');
  const concurrency = readInt(
    readArgValue(argv, '--concurrency') ?? readEnv('ATLAS_CONCURRENCY') ?? readAtlasEnv('ATLAS_CONCURRENCY', atlasEnv),
    10,
  );

  return {
    workspace,
    sourceRoot,
    dbPath,
    concurrency,
    sqliteVecExtension: readArgValue(argv, '--sqlite-vec-extension')
      ?? readEnv('ATLAS_SQLITE_VEC_EXTENSION')
      ?? readAtlasEnv('ATLAS_SQLITE_VEC_EXTENSION', atlasEnv)
      ?? '',
    embeddingModel: readArgValue(argv, '--embedding-model')
      ?? readEnv('ATLAS_EMBED_MODEL')
      ?? readAtlasEnv('ATLAS_EMBED_MODEL', atlasEnv)
      ?? DEFAULT_EMBED_CONFIG.model,
    embeddingDimensions: readInt(
      readArgValue(argv, '--embedding-dimensions')
        ?? readEnv('ATLAS_EMBED_DIMENSIONS')
        ?? readAtlasEnv('ATLAS_EMBED_DIMENSIONS', atlasEnv),
      DEFAULT_EMBED_CONFIG.dimensions,
    ),
  };
}
