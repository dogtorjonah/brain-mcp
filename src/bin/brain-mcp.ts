#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerDaemonProxyTools } from '../adapter/registerProxyTools.js';

export async function main(): Promise<void> {
  const server = new McpServer({
    name: '@voxxo/brain-mcp',
    version: '0.1.0',
  });

  await registerDaemonProxyTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = (): void => {
    const closeable = server as unknown as { close?: () => Promise<void> | void };
    void Promise.resolve(closeable.close?.()).finally(() => {
      process.exit(0);
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
