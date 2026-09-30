import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { createServer } from '../server';
import { DEFAULT_MAX_CONCURRENT_WORKERS, DEFAULT_MAX_QUEUED_CALLS } from '../runInWorker';
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

  it('conforms to the advertised outputSchema with every optional field present (#489)', async () => {
    const { tools } = await client.listTools();
    const validator = new AjvJsonSchemaValidator();
    const conforms = (name: string, result: TextResult) => {
      expect(result.isError, `${name}: ${resultText(result).slice(0, 500)}`).toBeFalsy();
      const schema = tools.find((t) => t.name === name)?.outputSchema;
      const check = validator.getValidator(schema as JsonSchemaType)(result.structuredContent);
      expect(check.errorMessage, name).toBeUndefined();
      return payload(result) as Record<string, unknown>;
    };

    // fieldOffsets (capture_offsets), noOps (an EXTRACT that never matches),
    // clonedFrom (CLONE_SOURCETYPE), and events cut by max_events.
    const simulated = conforms(
      'simulate',
      (await client.callTool({
        name: 'simulate',
        arguments: {
          raw: 'user=alice\nuser=bob\nuser=carol\n',
          sourcetype: 'app',
          props_conf: [
            '[app]',
            'SHOULD_LINEMERGE = false',
            'TRANSFORMS-copy = copy',
            'EXTRACT-user = user=(?<user>\\w+)',
            'EXTRACT-never = nothing=(?<never>\\w+)',
          ].join('\n'),
          transforms_conf: '[copy]\nREGEX = alice\nCLONE_SOURCETYPE = app_copy',
          capture_offsets: true,
          max_events: 3,
        },
      })) as TextResult,
    ) as { events: Record<string, unknown>[]; truncationNote?: string };
    const events = simulated.events;
    expect(events[0]?.fieldOffsets).toEqual({ user: [[5, 10]] });
    expect(events.some((e) => (e.noOps as { directive: string }[] | undefined)?.some((n) => n.directive === 'EXTRACT-never'))).toBe(true);
    expect(events.some((e) => e.clonedFrom === 'app')).toBe(true);
    expect(simulated.truncationNote).toMatch(/max_events/);

    // Every list cut to the size cap, with its count: 90,000 malformed lines,
    // each a diagnostic, fill far more than the budget allows.
    const malformed = Array.from({ length: 90_000 }, (_, i) => `bad ${i}`).join('\n');
    const cutSimulate = conforms(
      'simulate',
      (await client.callTool({
        name: 'simulate',
        arguments: { raw: 'x\n', sourcetype: 'app', props_conf: malformed, timeout_ms: 30_000 },
      })) as TextResult,
    );
    expect(cutSimulate.diagnosticCount).toBe(90_000);
    const cutValidate = conforms(
      'validate',
      (await client.callTool({ name: 'validate', arguments: { props_conf: malformed, timeout_ms: 30_000 } })) as TextResult,
    );
    expect(cutValidate.diagnosticCount).toBe(90_000);
    expect(cutValidate.truncationNote).toMatch(/diagnostics/);
    const stanzas = Array.from({ length: 30_000 }, (_, i) => `[s${i}]\nk=${'v'.repeat(20)}`).join('\n');
    const cutExplain = conforms(
      'explain_precedence',
      (await client.callTool({
        name: 'explain_precedence',
        arguments: {
          conf: [
            { layer: 'default', text: malformed },
            { layer: 'local', text: stanzas },
          ],
          sourcetype: 's1',
          timeout_ms: 30_000,
        },
      })) as TextResult,
    );
    expect(cutExplain.parseErrorCount).toBe(90_000);
    expect(cutExplain.stanzaCount ?? (cutExplain.stanzas as { directiveCount?: number }[]).at(-1)?.directiveCount).toBeGreaterThan(0);
    expect(cutExplain.truncationNote).toMatch(/capped at/);
  }, 120_000);

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
    // terminated the workers. Had it not, every slot would stay held for the
    // full 30s budget and this call would queue behind them. No wall-clock
    // assertion (#507): the bound is structural. The workers' budget (30s)
    // exceeds this test's timeout (20s), so a slot that was not freed makes the
    // call below overrun the test timeout and fail, whatever the machine's speed.
    const result = await client.callTool({
      name: 'validate',
      arguments: { props_conf: '[st]\nSHOULD_LINEMERGE = false\n' },
    });
    expect(result.isError).toBeFalsy();
  }, 20_000);
});

describe('a flood of calls (#490)', () => {
  it('refuses what the queue cannot hold with `busy`, at once, and serves the rest', async () => {
    const evilProps = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
      'MATCH_LIMIT = 0',
      'DEPTH_LIMIT = 0',
      'EXTRACT-boom = ^(?<boom>(a|aa)+)(?=b)$',
    ].join('\n');
    const held = DEFAULT_MAX_CONCURRENT_WORKERS + DEFAULT_MAX_QUEUED_CALLS;
    const extra = 3;
    const controller = new AbortController();
    const startedAt = Date.now();
    const calls = Array.from({ length: held + extra }, () =>
      client.callTool(
        {
          name: 'simulate',
          arguments: { raw: `${'a'.repeat(200)}\n`, sourcetype: 'evil', props_conf: evilProps, timeout_ms: 30_000 },
        },
        undefined,
        { signal: controller.signal, timeout: 60_000 },
      ),
    );
    try {
      // The calls past the queue's bound come back as soon as they arrive,
      // while the others hold every slot and queue position.
      const settled = await Promise.race([
        Promise.all(calls.slice(held)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no busy refusal')), 5_000)),
      ]);
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      for (const result of settled) {
        expect(result.isError).toBe(true);
        expect(payload(result)).toMatchObject({
          error: 'busy',
          max_concurrent: DEFAULT_MAX_CONCURRENT_WORKERS,
          max_queued: DEFAULT_MAX_QUEUED_CALLS,
        });
      }
    } finally {
      controller.abort();
      await Promise.allSettled(calls);
    }
    // Cancelling the held calls freed every slot: the server still answers.
    const result = await client.callTool({ name: 'validate', arguments: { props_conf: '[st]\n' } });
    expect(result.isError).toBeFalsy();
  }, 30_000);
});

describe('client disconnect', () => {
  it('stops running and queued calls when stdin closes, and the server exits', async () => {
    // One more call than there are slots, so one is queued behind runs that
    // would each hold their slot for the whole budget. Before, nothing closed
    // the transport at stdin EOF: the running workers ran to their budget and
    // then the queued call started its own.
    // The longest budget a call may ask for, and longer than this test's own
    // timeout below: workers that outlived the disconnect would hold the
    // process open past it, so a prompt exit is proved by the test finishing
    // rather than by a stopwatch (#507).
    const TIMEOUT_MS = 30_000;
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
      child.stdin.end();
      // The process only exits once no worker is left running, so a prompt
      // exit shows the running workers were terminated and the queued call
      // never started one.
      expect(await exited).toBe(0);
    } finally {
      child.kill('SIGKILL');
    }
  }, 25_000);
});

describe('built launcher', () => {
  it('starts with a shebang so the `propslab-mcp` bin runs directly', () => {
    const index = readFileSync(
      fileURLToPath(new URL('../../dist/index.js', import.meta.url)),
      'utf8',
    );
    expect(index.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it('bundles the same pcre2-wasm-utf16 commit the app is tested against', () => {
    // The package declares the regex engine itself and the build resolves the
    // engine's import to that copy, while the app's suite runs the same engine
    // source against the root's. Two different releases would mean the server
    // ships a regex engine nothing tested.
    const read = (rel: string) =>
      JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as {
        dependencies?: Record<string, string>;
        packages?: Record<string, { resolved?: string }>;
      };
    const spec = (rel: string) => read(rel).dependencies?.['pcre2-wasm-utf16'];
    const pinned = (rel: string) => read(rel).packages?.['node_modules/pcre2-wasm-utf16']?.resolved;
    expect(spec('../../package.json')).toBeDefined();
    expect(spec('../../package.json')).toBe(spec('../../../../package.json'));
    expect(pinned('../../package-lock.json')).toMatch(/#[0-9a-f]{40}$/);
    expect(pinned('../../package-lock.json')).toBe(pinned('../../../../package-lock.json'));
  });

  it('keeps the shebang off the worker bundle', () => {
    const worker = readFileSync(WORKER_PATH, 'utf8');
    expect(worker.startsWith('#!')).toBe(false);
  });
});
