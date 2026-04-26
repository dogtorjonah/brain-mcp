import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { enqueueReextract } from '../db.js';
import { notifyAtlasContextUpdated } from '../resources/context.js';

export function registerFlushTool(server: McpServer, runtime: AtlasRuntime): void {
  server.tool(
    'atlas_flush',
    {
      files: z.array(z.string().min(1)).min(1),
    },
    async ({ files }: { files: string[] }) => {
      const workspace = runtime.config.workspace;
      const uniqueFiles = [...new Set(files.map((file) => file.trim()).filter(Boolean))];

      for (const filePath of uniqueFiles) {
        enqueueReextract(runtime.db, workspace, filePath, 'flush');
      }

      await notifyAtlasContextUpdated(runtime.server);

      return {
        content: [{
          type: 'text',
          text: `Queued ${uniqueFiles.length} file${uniqueFiles.length === 1 ? '' : 's'} for immediate re-extraction (heuristic pipeline).`,
        }],
      };
    },
  );
}
