import type { CallerContext, ToolDefinition, BrainToolResult } from './protocol.js';
import { normalizeError, normalizeToolResult } from './protocol.js';

export type BrainToolHandler = (
  args: Record<string, unknown>,
  caller: CallerContext,
  runtime: unknown,
) => Promise<BrainToolResult> | BrainToolResult;

interface RegisteredBrainTool {
  definition: ToolDefinition;
  handler: BrainToolHandler;
}

type CapturedHandler = (args: unknown, extra?: unknown) => Promise<unknown> | unknown;

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredBrainTool>();

  register(definition: ToolDefinition, handler: BrainToolHandler): void {
    if (!definition.name.trim()) {
      throw new Error('Tool name cannot be empty');
    }
    this.tools.set(definition.name, { definition, handler });
  }

  listTools(): ToolDefinition[] {
    return [...this.tools.values()]
      .map((tool) => tool.definition)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    caller: CallerContext,
    runtime: unknown,
  ): Promise<BrainToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return normalizeError(new Error(`Unknown brain-mcp tool: ${name}`));
    }

    try {
      return await tool.handler(args, caller, runtime);
    } catch (error) {
      return normalizeError(error);
    }
  }

  createCaptureServer(defaultDescriptionPrefix = ''): unknown {
    const registerCapturedTool = (name: unknown, ...rest: unknown[]): void => {
      if (typeof name !== 'string') return;

      let description: string | undefined;
      let handler: CapturedHandler | undefined;

      if (typeof rest[0] === 'string') {
        description = rest[0];
        handler = typeof rest[2] === 'function' ? rest[2] as CapturedHandler : undefined;
      } else {
        handler = typeof rest[1] === 'function' ? rest[1] as CapturedHandler : undefined;
      }

      if (!handler) {
        throw new Error(`Cannot capture MCP tool "${name}": missing handler`);
      }

      this.register(
        {
          name,
          description: description ?? (defaultDescriptionPrefix ? `${defaultDescriptionPrefix}${name}` : undefined),
        },
        async (args) => normalizeToolResult(await handler(args)),
      );
    };

    return {
      tool: registerCapturedTool,
      registerTool: (name: string, config: { description?: string; title?: string }, handler: CapturedHandler) => {
        this.register(
          {
            name,
            title: config.title,
            description: config.description,
          },
          async (args) => normalizeToolResult(await handler(args)),
        );
      },
      resource: () => undefined,
      registerResource: () => undefined,
      sendResourceListChanged: () => undefined,
      connect: async () => undefined,
      server: {
        setRequestHandler: () => undefined,
      },
    };
  }
}
