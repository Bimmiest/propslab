import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server';
import { DEFAULT_MAX_CONCURRENT_WORKERS } from '../runInWorker';

/**
 * End to end through the SDK (#319): a real Client talking to the server from
 * `createServer` over an in-memory transport pair. tools.test.ts calls the
 * handlers directly with every argument spelled out, which skips the two
 * things only the protocol path does — the SDK applying the zod input schemas
 * (and with them every `.default()`), and `registerTools` handing each call's
 * `extra.signal` to the sandbox. Both have been easy to break without any
 * handler-level test noticing.
 *
 * As in tools.test.ts, the worker is the built bundle (`pretest` builds it).
 */
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };
const payload = (r: unknown) => JSON.parse((r as TextResult).content[0].text);

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
    expect((result as TextResult).content[0].text).toMatch(/timeout_ms/);
  });

  it('frees sandbox slots when the client cancels a call', async () => {
    // Occupy every slot of the process-wide concurrency cap with a run that
    // would hold it for its whole 30s budget: (a|aa)+ with a trailing
    // lookahead declines V8's linear-time fallback (see tools.test.ts).
    const evilProps = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
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

describe('built launcher', () => {
  it('starts with a shebang so the `propslab-mcp` bin runs directly', () => {
    const index = readFileSync(
      fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
      'utf8',
    );
    expect(index.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('keeps the shebang off the worker bundle', () => {
    const worker = readFileSync(WORKER_PATH, 'utf8');
    expect(worker.startsWith('#!')).toBe(false);
  });
});
