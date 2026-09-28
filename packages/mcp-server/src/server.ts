/**
 * The MCP server proper: stdio transport, four tools. `index.ts` is the
 * launcher that re-execs node with the V8 regex-fallback flags before this
 * module (and through it, the engine) ever loads — `./v8Flags` stays first as
 * the fallback for embedders that skip the launcher.
 */
import './v8Flags';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createStdioTransport } from './messageLimit';
import { registerTools } from './tools';
import { regexEngineModule } from './regexEngine';
// The version the server reports in its MCP `initialize` handshake, read from
// package.json so there is one copy to bump. esbuild inlines the JSON at build
// time — and, with a named import, only this one field of it — so nothing is
// read from disk at run time and dist/ still works when copied away from the
// package.
import { version } from '../package.json';

export interface CreateServerOptions {
  /**
   * Worker script for the sandboxed engine runs. Defaults to the
   * `simulateWorker.js` bundle next to the running code — which is right in
   * dist/, and wrong when the server is imported from source, as the
   * end-to-end test does.
   */
  workerPath?: string;
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'propslab', version });
  registerTools(server, options);
  return server;
}

export async function start(): Promise<void> {
  // Compiled now rather than on the first call: a missing or broken module
  // fails the start, not a request.
  regexEngineModule();
  const server = createServer();
  // Bounds each message before the SDK buffers and parses it.
  await server.connect(createStdioTransport());
  // stdout belongs to the protocol; anything human-facing goes to stderr.
  console.error('propslab MCP server listening on stdio');
}
