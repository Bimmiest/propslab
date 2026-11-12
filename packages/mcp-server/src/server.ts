/**
 * The MCP server proper: stdio transport, four tools. `index.ts` is the
 * launcher that re-execs node with the V8 regex-fallback flags before this
 * module (and through it, the engine) ever loads — `./v8Flags` stays first as
 * the fallback for embedders that skip the launcher.
 */
import './v8Flags';
import type { Writable } from 'node:stream';
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

/**
 * Sent in the `initialize` result, for clients that give it to the model: the
 * order of work that the tool descriptions imply one tool at a time (#885).
 */
export const SERVER_INSTRUCTIONS = [
  "propslab simulates Splunk's props.conf and transforms.conf against sample data, so you can check what a config does instead of predicting it. Work in this order:",
  '1. lookup_directive: for each directive you are not sure of, read its registry entry, including its support level. A directive the simulator ignores or only documents is not simulated, so a run says nothing about it.',
  '2. validate: lint the conf you drafted, with no sample needed: parse errors, unknown or mis-cased keys, values of the wrong type, missing transforms, regexes that do not compile. Fix these first.',
  '3. simulate: run the conf on real sample events. Read each event, its processingTrace and the diagnostics, fix the conf, and run it again.',
  'For a conf in layers (default/ then local/), explain_precedence shows which layer wins each attribute.',
  'An error result carries JSON with an `error` code, which each tool description lists. busy and start_timeout mean retry later, not change the input. Send a progressToken to get progress notifications while a call waits for a slot or runs.',
].join('\n');

export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'propslab', version }, { instructions: SERVER_INSTRUCTIONS });
  registerTools(server, options);
  return server;
}

/**
 * A failed write to stdout — the client gone (EPIPE), or the pipe refusing
 * more (ENOBUFS) — is an `error` event nothing else listens for, which Node
 * turns into an uncaught exception and a stack trace. Nothing more can be
 * said over the protocol then, so say it on stderr and exit: 0 when the
 * client simply went away, 1 otherwise.
 */
export function exitOnStdoutError(
  stdout: Writable = process.stdout,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  stdout.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`propslab MCP server: cannot write to stdout (${err.code ?? err.message}); exiting`);
    exit(err.code === 'EPIPE' ? 0 : 1);
  });
}

export async function start(): Promise<void> {
  exitOnStdoutError();
  // Compiled now rather than on the first call: a missing or broken module
  // fails the start, not a request.
  regexEngineModule();
  const server = createServer();
  // Bounds each message before the SDK buffers and parses it.
  await server.connect(createStdioTransport());
  // stdout belongs to the protocol; anything human-facing goes to stderr.
  console.error(`propslab MCP server listening on stdio (pid ${process.pid})`);
}
