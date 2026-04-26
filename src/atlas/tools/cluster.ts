import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AtlasRuntime } from '../types.js';
import { listClusterFiles } from '../db.js';
import { toolWithDescription } from './helpers.js';

export function listClusters(runtime: AtlasRuntime, workspace: string): string[] {
  const rows = runtime.db.prepare(
    'SELECT DISTINCT cluster FROM atlas_files WHERE workspace = ? ORDER BY cluster ASC',
  ).all(workspace) as Array<{ cluster: string | null }>;
  return rows
    .map((row) => row.cluster)
    .filter((cluster): cluster is string => typeof cluster === 'string' && cluster.trim().length > 0);
}

export interface AtlasClusterArgs {
  cluster: string;
  workspace?: string;
}

type AtlasToolTextResult = {
  content: Array<{ type: 'text'; text: string }>;
};

export async function runClusterCatalog(runtime: AtlasRuntime, workspace?: string): Promise<AtlasToolTextResult> {
  const ws = workspace ?? runtime.config.workspace;
  const clusters = listClusters(runtime, ws);
  if (clusters.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `No clusters found in workspace "${ws}". Clusters are assigned during atlas indexing (community detection). Run \`atlas_admin action=reindex\` to populate.`,
      }],
    };
  }

  // Count files per cluster for a useful summary
  const clusterCounts = new Map<string, number>();
  for (const name of clusters) {
    const rows = listClusterFiles(runtime.db, ws, name);
    clusterCounts.set(name, rows.length);
  }

  const lines = clusters.map((name) => {
    const count = clusterCounts.get(name) ?? 0;
    return `  • ${name} (${count} file${count === 1 ? '' : 's'})`;
  });

  return {
    content: [{
      type: 'text',
      text: `Available clusters in "${ws}" (${clusters.length}):\n${lines.join('\n')}\n\n💡 Use \`atlas_query action=cluster cluster=<name>\` to list files in a specific cluster.`,
    }],
  };
}

export async function runClusterTool(runtime: AtlasRuntime, { cluster, workspace }: AtlasClusterArgs): Promise<AtlasToolTextResult> {
  const ws = workspace ?? runtime.config.workspace;
  const rows = listClusterFiles(runtime.db, ws, cluster);

  if (rows.length === 0) {
    const clusters = listClusters(runtime, ws);
    return {
      content: [{
        type: 'text',
        text: clusters.length > 0
          ? `No cluster "${cluster}". Available clusters:\n${clusters.map((name) => `  - ${name}`).join('\n')}`
          : `No cluster "${cluster}" in workspace "${ws}".`,
      }],
    };
  }

  const lines = rows.map((row) => {
    const shortPurpose = row.purpose.length > 120 ? `${row.purpose.slice(0, 120)}...` : row.purpose;
    return `  📄 ${row.file_path} (${row.loc} LOC)\n     ${shortPurpose}`;
  });

  const totalLoc = rows.reduce((sum, row) => sum + (row.loc || 0), 0);
  return {
    content: [{
      type: 'text',
      text: `Cluster: ${cluster} (${rows.length} files, ${totalLoc} LOC)\n\n${lines.join('\n\n')}`,
    }],
  };
}

export function registerClusterTool(server: McpServer, runtime: AtlasRuntime): void {
  toolWithDescription(server)(
    'atlas_cluster',
    'List all files in a named cluster from the codebase atlas. Clusters group related files by domain (e.g., "instance-lifecycle", "signal-coordination"). Returns file paths with purpose summaries. Use before planning multi-file changes.',
    {
      cluster: z.string().min(1),
      workspace: z.string().optional(),
    },
    async (args: AtlasClusterArgs) => runClusterTool(runtime, args),
  );
}
