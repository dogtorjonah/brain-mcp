import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { BrainDaemonClient } from './client.js';
import { ensureBrainDaemon } from './daemonProcess.js';
import { buildCallerContext } from './env.js';
import type { BrainToolResult, ToolDefinition } from '../daemon/protocol.js';
import {
  BRAIN_REBIRTH_ADAPTER_ACTION,
  isBrainRebirthAdapterAction,
} from '../tools/brain_rebirth.js';
import { parentLooksLikeClaude, scheduleParentKill, spawnReplacementClaude } from '../io/selfSpawn.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<BrainToolResult>;

interface RuntimeMcpServer {
  registerTool?: (
    name: string,
    config: { title?: string; description?: string; inputSchema?: unknown },
    handler: ToolHandler,
  ) => unknown;
  tool?: (...args: unknown[]) => unknown;
}

const passthroughSchema = z.object({}).passthrough();

export async function registerDaemonProxyTools(server: McpServer): Promise<void> {
  const caller = buildCallerContext();
  await ensureBrainDaemon({ caller });

  const client = new BrainDaemonClient();
  const tools = await client.listTools(caller);

  if (tools.length === 0) {
    registerTool(server, {
      name: 'brain_daemon_status',
      description: 'Report that the brain daemon is reachable but returned no tool definitions.',
    }, async () => ({
      content: [{ type: 'text', text: 'brain-daemon is reachable, but no tools are currently registered.' }],
      isError: true,
    }));
    return;
  }

  for (const tool of tools) {
    registerTool(server, tool, async (args) => {
      const perCallCaller = buildCallerContext();
      try {
        return executeAdapterActions(await client.callTool(tool.name, args, perCallCaller));
      } catch {
        await ensureBrainDaemon({ caller: perCallCaller });
        return executeAdapterActions(await client.callTool(tool.name, args, perCallCaller));
      }
    });
  }
}

function executeAdapterActions(result: BrainToolResult): BrainToolResult {
  const action = result._meta?.[BRAIN_REBIRTH_ADAPTER_ACTION];
  if (!isBrainRebirthAdapterAction(action)) return result;

  if (action.requireClaudeParent && !parentLooksLikeClaude(process.ppid)) {
    return {
      content: [{
        type: 'text',
        text:
          'brain_rebirth refused self-spawn because the adapter parent does not look like Claude. ' +
          'Launch through brain-claude for wrapper respawn, or retry with require_claude_parent=false.',
      }],
      isError: true,
    };
  }

  try {
    const spawnResult = spawnReplacementClaude({
      handoffMarkdown: action.handoffMarkdown,
      cwd: action.cwd,
      claudeBin: action.claudeBin,
      extraArgv: action.extraArgv,
    });
    scheduleParentKill(spawnResult.parentPid, action.killDelayMs);

    const structuredContent = {
      ok: true,
      method: 'self-spawn',
      handoff_path: spawnResult.handoffPath,
      bytes: spawnResult.bytes,
      new_pid: spawnResult.newPid,
      parent_pid: spawnResult.parentPid,
      claude_bin: spawnResult.claudeBin,
      kill_delay_ms: action.killDelayMs,
    };

    return {
      content: [{
        type: 'text',
        text: [
          'brain_rebirth self-spawn scheduled.',
          `new_pid: ${spawnResult.newPid}`,
          `parent_pid: ${spawnResult.parentPid}`,
          `handoff_bytes: ${spawnResult.bytes}`,
        ].join('\n'),
      }],
      structuredContent,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function registerTool(server: McpServer, definition: ToolDefinition, handler: ToolHandler): void {
  const runtimeServer = server as unknown as RuntimeMcpServer;
  if (typeof runtimeServer.registerTool === 'function') {
    runtimeServer.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: passthroughSchema,
      },
      handler,
    );
    return;
  }

  if (typeof runtimeServer.tool !== 'function') {
    throw new Error('MCP server does not expose registerTool or tool');
  }

  runtimeServer.tool(
    definition.name,
    definition.description ?? definition.name,
    {},
    async (args: unknown) => handler(isRecord(args) ? args : {}),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
