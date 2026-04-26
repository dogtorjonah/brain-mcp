import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const DEFAULT_WINDOWS_PATHEXT = ['.EXE', '.CMD', '.BAT', '.COM'];

export const DEFAULT_COMMON_RG_LOCATIONS = [
  '/opt/homebrew/bin/rg',
  '/usr/local/bin/rg',
  '/usr/bin/rg',
  '/home/linuxbrew/.linuxbrew/bin/rg',
];

const DEFAULT_CODEX_VENDOR_ROOTS = [
  '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai',
  '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai',
  '/usr/lib/node_modules/@openai/codex/node_modules/@openai',
  '/home/linuxbrew/.linuxbrew/lib/node_modules/@openai/codex/node_modules/@openai',
];

function uniquePaths(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    results.push(trimmed);
  }

  return results;
}

export function resolveHomeDirectory(): string | null {
  const fromEnv = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  try {
    const detected = homedir().trim();
    return detected ? detected : null;
  } catch {
    return null;
  }
}

export function resolveHomePath(...segments: string[]): string | null {
  const home = resolveHomeDirectory();
  return home ? path.join(home, ...segments) : null;
}

function candidateExecutableNames(command: string): string[] {
  if (process.platform !== 'win32') {
    return [command];
  }

  const extensions = uniquePaths(
    (process.env.PATHEXT ?? '')
      .split(';')
      .map((value) => value.toUpperCase()),
  );
  const pathext = extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATHEXT;
  const lowerCommand = command.toLowerCase();

  const names = new Set<string>([command]);
  for (const ext of pathext) {
    if (lowerCommand.endsWith(ext.toLowerCase())) {
      names.add(command);
    } else {
      names.add(`${command}${ext}`);
    }
  }

  return [...names];
}

export function findExecutableOnPath(
  command: string,
  pathValue = process.env.PATH ?? '',
): string | null {
  if (!command || !pathValue) {
    return null;
  }

  const candidates = candidateExecutableNames(command);
  for (const dir of pathValue.split(path.delimiter)) {
    const trimmedDir = dir.trim().replace(/^"(.*)"$/, '$1');
    if (!trimmedDir) {
      continue;
    }

    for (const candidate of candidates) {
      const fullPath = path.join(trimmedDir, candidate);
      if (existsSync(fullPath)) {
        return fullPath;
      }
    }
  }

  return null;
}

function findCodexVendoredRipgrep(): string | null {
  const codexOnPath = findExecutableOnPath('codex');
  const inferredPrefix = codexOnPath ? path.dirname(path.dirname(codexOnPath)) : null;
  const homeDir = resolveHomeDirectory();

  const roots = uniquePaths([
    ...DEFAULT_CODEX_VENDOR_ROOTS,
    inferredPrefix ? path.join(inferredPrefix, 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai') : null,
    homeDir ? path.join(homeDir, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai') : null,
    homeDir ? path.join(homeDir, '.local', 'lib', 'node_modules', '@openai', 'codex', 'node_modules', '@openai') : null,
  ]);

  for (const root of roots) {
    if (!existsSync(root)) {
      continue;
    }
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.startsWith('codex-')) {
          continue;
        }
        const vendorRoot = path.join(root, entry, 'vendor');
        if (!existsSync(vendorRoot)) {
          continue;
        }
        for (const target of readdirSync(vendorRoot)) {
          for (const binaryName of candidateExecutableNames('rg')) {
            const candidate = path.join(vendorRoot, target, 'path', binaryName);
            if (existsSync(candidate)) {
              return candidate;
            }
          }
        }
      }
    } catch {
      // Ignore vendor scan failures and continue to other resolution paths.
    }
  }

  return null;
}

export function resolveRipgrepExecutablePath(
  missingMessage: string,
  commonLocations: string[] = DEFAULT_COMMON_RG_LOCATIONS,
): string {
  const configured = process.env.RG_BIN?.trim() || process.env.RIPGREP_BIN?.trim();
  if (configured) {
    if (existsSync(configured)) {
      return configured;
    }
    const onPath = findExecutableOnPath(configured);
    if (onPath) {
      return onPath;
    }
  }

  const rgOnPath = findExecutableOnPath('rg');
  if (rgOnPath) {
    return rgOnPath;
  }

  for (const candidate of uniquePaths([...commonLocations, ...DEFAULT_COMMON_RG_LOCATIONS])) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const vendored = findCodexVendoredRipgrep();
  if (vendored) {
    return vendored;
  }

  throw new Error(missingMessage);
}
