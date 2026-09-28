import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { createServer } from '../server';
import { DEFAULT_MAX_CONCURRENT_WORKERS } from '../runInWorker';
import { resultText } from './resultText';

/**
 * End to end through the SDK: a real Client talking to the server from
 * `createServer` over an in-memory transport pair. tools.test.ts calls the
 * handlers directly with every argument spelled out, which skips the two
 * things only the protocol path does — the SDK applying the zod input schemas
 * (and with them every `.default()`), and `registerTools` handing each call's
 * `extra.signal` to the sandbox. No handler-level test sees either.
 *
 * As in tools.test.ts, the worker is the built bundle (`pretest` builds it).
 */
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

type TextResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
const payload = (r: unknown) => JSON.parse(resultText(r as TextResult));

let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  const server = createServer({ workerPath: WORKER_PATH });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'propslab-e2e', version: '0.0.0' });
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
  };
});

afterEach(async () => {
  await close();
});

describe('MCP server end to end', () => {
  it('reports the version from package.json in the handshake', () => {
    const { version } = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version: string };
    expect(client.getServerVersion()).toMatchObject({ name: 'propslab', version });
  });

  it('lists all four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'explain_precedence',
      'lookup_directive',
      'simulate',
      'validate',
    ]);
  });

  it('advertises an object outputSchema and read-only annotations for every tool', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object' });
      expect(tool.annotations, tool.name).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it('returns structuredContent that matches the advertised outputSchema', async () => {
    const { tools } = await client.listTools();
    const validator = new AjvJsonSchemaValidator();
    const props = [
      '[default]',
      'TRUNCATE = 5000',
      '[access_log]',
      'SHOULD_LINEMERGE = false',
      'TIME_PREFIX = \\[',
      'TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z',
      'EXTRACT-status = HTTP/1.1" (?<status>\\d{3})',
      'FIELDALIAS-code = status AS code',
      'BOGUS_KEY = 1',
    ].join('\n');
    const layered = [
      { layer: 'default', text: props },
      { layer: 'local', text: '[access_log]\nTRUNCATE = 100\n' },
    ];
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      {
        name: 'simulate',
        arguments: {
          raw: '10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET /a HTTP/1.1" 200 123\n',
          sourcetype: 'access_log',
          props_conf: props,
          include_snapshots: true,
        },
      },
      { name: 'validate', arguments: { props_conf: props } },
      {
        name: 'explain_precedence',
        arguments: { conf: layered, sourcetype: 'access_log' },
      },
      { name: 'lookup_directive', arguments: { key: 'EXTRACT-status' } },
      { name: 'lookup_directive', arguments: {} },
    ];
    for (const call of calls) {
      const result = (await client.callTool(call)) as TextResult;
      expect(result.isError, call.name).toBeFalsy();
      // The same payload as the text, so text-only clients lose nothing.
      expect(result.structuredContent, call.name).toEqual(payload(result));
      const schema = tools.find((t) => t.name === call.name)?.outputSchema;
      const check = validator.getValidator(schema as JsonSchemaType)(result.structuredContent);
      expect(check.errorMessage, call.name).toBeUndefined();
      expect(check.valid, call.name).toBe(true);
    }
  }, 20_000);

  it('leaves structuredContent off an error result', async () => {
    // Its payload is an error object, which the output schema does not
    // describe; the error stays in the text.
    const result = (await client.callTool({
      name: 'lookup_directive',
      arguments: { key: 'line_breaker' },
    })) as TextResult;
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty('structuredContent');
    expect(payload(result).error).toBe('unknown_directive');
  });

  it('fills schema defaults for everything a caller leaves out', async () => {
    // Only the required fields plus a conf. index/host/source, the booleans,
    // max_events and timeout_ms all come from the zod defaults; a missing one
    // would reach the worker as undefined and either fail validation or run
    // with no budget.
    const result = await client.callTool({
      name: 'simulate',
      arguments: {
        raw: '10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET /a HTTP/1.1" 200 123\n',
        sourcetype: 'access_log',
        props_conf: [
          '[access_log]',
          'SHOULD_LINEMERGE = false',
          'TIME_PREFIX = \\[',
          'TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z',
          'EXTRACT-status = HTTP/1.1" (?<status>\\d{3})',
        ].join('\n'),
      },
    });
    expect(result.isError).toBeFalsy();
    const out = payload(result);
    expect(out.eventCount).toBe(1);
    expect(out.events[0]._time).toBe('2026-08-02T10:15:00.000Z');
    expect(out.events[0].fields.status).toBe('200');
    // The defaulted metadata reached the engine...
    expect(out.events[0].metadata).toMatchObject({
      sourcetype: 'access_log',
      index: 'main',
      host: 'localhost',
      source: '/var/log/sample.log',
    });
    // ...and include_snapshots defaulted to false.
    expect(out.events[0].processingTrace.length).toBeGreaterThan(0);
    for (const step of out.events[0].processingTrace) {
      expect(step).not.toHaveProperty('inputSnapshot');
    }
  }, 20_000);

  it('rejects input the schema does not allow before anything runs', async () => {
    const result = await client.callTool({
      name: 'simulate',
      arguments: { raw: 'x\n', sourcetype: 'st', timeout_ms: 5 },
    });
    expect(result.isError).toBe(true);
    expect(resultText(result as TextResult)).toMatch(/timeout_ms/);
  });

  it('frees sandbox slots when the client cancels a call', async () => {
    // Occupy every slot of the process-wide concurrency cap with a run that
    // would hold it for its whole 30s budget: (a|aa)+ with the PCRE limits
    // switched off (see tools.test.ts).
    const evilProps = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
      'MATCH_LIMIT = 0',
      'DEPTH_LIMIT = 0',
      'EXTRACT-boom = ^(?<boom>(a|aa)+)(?=b)$',
    ].join('\n');
    const controller = new AbortController();
    const stuck = Array.from({ length: DEFAULT_MAX_CONCURRENT_WORKERS }, () =>
      client.callTool(
        {
          name: 'simulate',
          arguments: {
            raw: `${'a'.repeat(200)}\n`,
            sourcetype: 'evil',
            props_conf: evilProps,
            timeout_ms: 30_000,
          },
        },
        undefined,
        { signal: controller.signal, timeout: 60_000 },
      ),
    );
    // Let the workers start before cancelling them.
    await new Promise((r) => setTimeout(r, 500));
    controller.abort();
    await Promise.allSettled(stuck);
    for (const call of stuck) await expect(call).rejects.toThrow();

    // The client's cancellation reached the handler as extra.signal and
    // terminated the workers. Had it not, every slot would stay held for ~30s
    // and this call would queue far past the test's timeout.
    const startedAt = Date.now();
    const result = await client.callTool({
      name: 'validate',
      arguments: { props_conf: '[st]\nSHOULD_LINEMERGE = false\n' },
    });
    expect(result.isError).toBeFalsy();
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 20_000);
});

describe('client disconnect', () => {
  it('stops running and queued calls when stdin closes, and the server exits', async () => {
    // One more call than there are slots, so one is queued behind runs that
    // would each hold their slot for the whole budget. Before, nothing closed
    // the transport at stdin EOF: the running workers ran to their budget and
    // then the queued call started its own.
    const TIMEOUT_MS = 15_000;
    const evilProps = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
      'MATCH_LIMIT = 0',
      'DEPTH_LIMIT = 0',
      'EXTRACT-boom = ^(?<boom>(a|aa)+)(?=b)$',
    ].join('\n');
    const launcher = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
    const child = spawn(process.execPath, [launcher], { stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise<number | null>((resolve) =>
      child.once('exit', (code) => resolve(code)),
    );
    try {
      const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
      const initialized = new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));
      send({
        jsonrpc: '2.0',
        id: 0,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'propslab-disconnect-test', version: '0.0.0' },
        },
      });
      await initialized;
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      for (let id = 1; id <= DEFAULT_MAX_CONCURRENT_WORKERS + 1; id++) {
        send({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: 'simulate',
            arguments: {
              raw: `${'a'.repeat(200)}\n`,
              sourcetype: 'evil',
              props_conf: evilProps,
              timeout_ms: TIMEOUT_MS,
            },
          },
        });
      }
      // Let the workers start before disconnecting.
      await new Promise((r) => setTimeout(r, 1_000));
      const closedAt = Date.now();
      child.stdin.end();
      // The process only exits once no worker is left running, so a prompt
      // exit shows the running workers were terminated and the queued call
      // never started one.
      expect(await exited).toBe(0);
      expect(Date.now() - closedAt).toBeLessThan(5_000);
    } finally {
      child.kill('SIGKILL');
    }
  }, 60_000);
});

describe('built launcher', () => {
  it('starts with a shebang so the `propslab-mcp` bin runs directly', () => {
    const index = readFileSync(
      fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
      'utf8',
    );
    expect(index.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it("README's setup installs the repository root before the package", () => {
    // The engine imports pcre2-wasm-utf16 from the root node_modules, so on a
    // fresh clone the package's build fails without the root install.
    const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
    const setup = /## Setup[\s\S]*?```bash\n([\s\S]*?)```/.exec(readme)?.[1] ?? '';
    const commands = setup.split('\n').filter((l) => l && !l.startsWith('#'));
    expect(commands.slice(0, 3)).toEqual(['npm install', 'cd packages/mcp-server', 'npm install']);
  });

  it('keeps the shebang off the worker bundle', () => {
    const worker = readFileSync(WORKER_PATH, 'utf8');
    expect(worker.startsWith('#!')).toBe(false);
  });
});
