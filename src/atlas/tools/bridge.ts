import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { toolWithDescription } from './helpers.js';
import {
  closeBridgeDb,
  closeWritableBridgeDb,
  discoverAllRoots,
  discoverWorkspaces,
  getWritableAtlasPathForRoot,
  normalizeCurrentWorkspaceAlias,
  openBridgeDb,
  openWritableBridgeDb,
  preferredAtlasDbPath,
  resolveExistingAtlasDbPath,
  resolveWorkspaceDb,
  slugifyWorkspaceName,
  type BridgeDb,
  type DiscoveredRoot,
  type ResolvedWorkspace,
} from '../../bridge/index.js';

export {
  closeBridgeDb,
  closeWritableBridgeDb,
  discoverAllRoots,
  discoverWorkspaces,
  getWritableAtlasPathForRoot,
  normalizeCurrentWorkspaceAlias,
  openBridgeDb,
  openWritableBridgeDb,
  preferredAtlasDbPath,
  resolveExistingAtlasDbPath,
  resolveWorkspaceDb,
  slugifyWorkspaceName,
  type BridgeDb,
  type DiscoveredRoot,
  type ResolvedWorkspace,
};

export function registerBridgeTools(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_bridge_list',
    'List local brain-mcp Atlas workspaces and git repos that can be indexed.',
    {
      format: z.enum(['json', 'text']).optional(),
    },
    async ({ format }: { format?: 'json' | 'text' }) => {
      const roots = discoverAllRoots(runtime.config.sourceRoot);
      const indexed = roots.filter((root) => root.indexed);
      const indexable = roots.filter((root) => !root.indexed && root.hasGit);

      if (format === 'json') {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ indexed, indexable }, null, 2),
          }],
        };
      }

      const indexedLines = indexed.map((root) => {
        const mode = root.legacy ? 'legacy .atlas' : '.brain';
        return `📦 ${root.workspace} (${mode})\n   ${root.sourceRoot}\n   ${root.existingDbPath ?? root.dbPath}`;
      });
      const indexableLines = indexable.map((root) =>
        `🌱 ${root.workspace} — not indexed yet\n   ${root.sourceRoot}\n   ${root.dbPath}`,
      );

      return {
        content: [{
          type: 'text' as const,
          text: [
            `Atlas Bridge — ${indexed.length} indexed, ${indexable.length} indexable`,
            indexedLines.length > 0 ? `\nIndexed:\n${indexedLines.join('\n\n')}` : '',
            indexableLines.length > 0 ? `\nIndexable:\n${indexableLines.join('\n\n')}` : '',
          ].filter(Boolean).join('\n'),
        }],
      };
    },
  );
}
