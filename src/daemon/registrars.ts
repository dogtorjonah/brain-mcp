import type { BrainDaemonRuntime } from './runtime.js';
import type { ToolRegistry } from './toolRegistry.js';
import { registerAllTools } from '../tools/registerAllTools.js';

export async function registerDefaultTools(registry: ToolRegistry, runtime: BrainDaemonRuntime): Promise<void> {
  registerAtlasToolProxies(registry, runtime);
  await registerAllTools({ registry, runtime });
}

function registerAtlasToolProxies(registry: ToolRegistry, runtime: BrainDaemonRuntime): void {
  for (const definition of runtime.atlasTools.listToolDefinitions()) {
    registry.register(definition, (args, caller) => runtime.atlasTools.callTool(caller.cwd, definition.name, args, caller));
  }
}
