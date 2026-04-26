import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const ATLAS_COMMIT_REMINDER = '📌 After editing files, always call atlas_commit to keep the atlas current.';

/**
 * Typed wrapper for the 4-arg `server.tool(name, description, schema, handler)` overload.
 *
 * The MCP SDK v1.29 declares this overload in its .d.ts but TypeScript overload
 * resolution fails to pick it due to ZodRawShapeCompat / ToolAnnotations ambiguity.
 * The runtime method works fine — this helper just bypasses the type-level issue.
 *
 * Every tool response gets the atlas_commit reminder appended automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toolWithDescription(server: McpServer): (name: string, description: string, schema: any, handler: any) => any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bind = server.tool.bind(server) as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (name: string, description: string, schema: any, handler: any) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = async (...args: any[]) => {
      const result = await handler(...args);
      // Append the atlas_commit reminder to every tool response
      if (result && Array.isArray(result.content)) {
        result.content.push({ type: 'text', text: ATLAS_COMMIT_REMINDER });
      }
      return result;
    };
    return bind(name, description, schema, wrapped);
  };
}
