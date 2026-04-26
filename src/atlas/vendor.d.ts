declare module 'better-sqlite3' {
  type Params = readonly unknown[] | Record<string, unknown>;

  interface RunResult {
    changes: number;
    lastInsertRowid: number;
  }

  interface Statement {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): RunResult;
  }

  interface Database {
    pragma(statement: string): unknown;
    loadExtension(path: string): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
    transaction<T extends (...args: any[]) => any>(fn: T): T;
    close(): void;
  }

  interface DatabaseConstructor {
    new (filename: string, options?: { readonly?: boolean }): Database;
  }

  const Database: DatabaseConstructor;
  export default Database;
}

declare module '@modelcontextprotocol/sdk/server/mcp.js' {
  export interface ToolResponse {
    content: Array<{ type: 'text'; text: string }>;
  }

  export class McpServer {
    constructor(info: { name: string; version: string });
    readonly server: import('@modelcontextprotocol/sdk/server/index.js').Server;
    tool<Input>(
      name: string,
      schema: unknown,
      handler: (input: Input) => Promise<ToolResponse> | ToolResponse,
    ): void;
    registerResource(
      name: string,
      uriOrTemplate: string,
      config: { title?: string; description?: string; mimeType?: string },
      readCallback: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }> | { contents: Array<{ uri: string; mimeType?: string; text: string }> },
    ): void;
    sendResourceListChanged(): void;
    resource(name: string, uri: string, metadata: { title?: string; description?: string; mimeType?: string }, readCallback: (uri: URL) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }> | { contents: Array<{ uri: string; mimeType?: string; text: string }> }): void;
    connect(transport: unknown): Promise<void>;
  }
}

declare module '@modelcontextprotocol/sdk/server/stdio.js' {
  export class StdioServerTransport {}
}
