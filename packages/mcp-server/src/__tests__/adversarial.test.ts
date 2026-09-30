import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server';
import { MAX_TOTAL_CONF_CHARS } from '../tools';
import { resultText } from './resultText';

/**
 * The adversarial suite (#517): input at the schemas' limits, of the shapes
 * most likely to cost the server something, through the real protocol. Every
 * call must be answered — a result, or a structured `timeout`, `out_of_memory`
 * or `busy` error — and the server's own thread must stay free throughout: a
 * stall there (the #468 shape) stops every response, cancellation and new
 * call, which SECURITY.md lists as in scope. A client disconnect mid-run is
 * covered in server.e2e.test.ts.
 *
 * Neither bound is a stopwatch in the test (#507). "Answered" is the request
 * timeout each call carries, which the SDK client enforces, and this file's
 * own test timeouts. "The thread stays free" is the one thing that ever
 * blocked it: the server parsing a caller's conf itself, where the worker
 * should. The parser is counted on this thread, which is the server's, since
 * createServer runs in-process; the worker has a copy of its own.
 */
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));

// Counts the confs parsed on this thread. The parser itself still runs.
const parseCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../../../src/engine/parser/confParser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/engine/parser/confParser')>();
  return {
    ...actual,
    parseConf: (...args: Parameters<typeof actual.parseConf>) => {
      parseCalls.count++;
      return actual.parseConf(...args);
    },
  };
});

/** The budget each heavy call gets, and the slack past it for start-up and shaping the answer. */
const BUDGET_MS = 2_000;
const SLACK_MS = 8_000;

const ACCEPTABLE = [undefined, 'timeout', 'out_of_memory', 'busy'];

type TextResult = { content: { type: string; text: string }[]; isError?: boolean };

let client: Client;
let close: () => Promise<void>;

beforeEach(async () => {
  const server = createServer({ workerPath: WORKER_PATH });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'propslab-adversarial', version: '0.0.0' });
  await client.connect(clientTransport);
  close = async () => {
    await client.close();
    await server.close();
  };
  parseCalls.count = 0;
});

afterEach(async () => {
  await close();
  expect(parseCalls.count, 'the server parsed a conf on its own thread').toBe(0);
});

/**
 * Calls a tool and checks it is answered acceptably. The request timeout is the
 * bound on when: a call not answered within its budget plus the slack rejects.
 */
async function expectAnswered(
  name: string,
  args: Record<string, unknown>,
  budgetMs = BUDGET_MS,
  acceptable: (string | undefined)[] = ACCEPTABLE,
) {
  const result = (await client.callTool({ name, arguments: args }, undefined, {
    timeout: budgetMs + SLACK_MS,
  })) as TextResult;
  const out = JSON.parse(resultText(result)) as { error?: string };
  expect(acceptable, `${name}: ${resultText(result).slice(0, 300)}`).toContain(out.error);
  return out;
}

/** Text of exactly `chars` characters made of `unit` repeated. */
const fill = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length)).slice(0, chars);

// Two layers, together just under the combined conf limit.
const half = MAX_TOTAL_CONF_CHARS / 2 - 100;
const layers = (text: string) => [
  { layer: 'default', text },
  { layer: 'local', text },
];

describe('adversarial input at the schema limits (#517)', () => {
  it('a maximum-length conf of continuation lines, for every conf-taking tool', async () => {
    const conf = `[st]\nEXTRACT-a = x\\\n${fill('a\\\n', half - 20)}`;
    await expectAnswered('validate', { props_conf: layers(conf), timeout_ms: BUDGET_MS });
    await expectAnswered('explain_precedence', { conf: layers(conf), sourcetype: 'st', timeout_ms: BUDGET_MS });
    await expectAnswered('simulate', { raw: 'x\n', sourcetype: 'st', props_conf: layers(conf), timeout_ms: BUDGET_MS });
  }, 60_000);

  it('a maximum-length conf of tiny stanzas and of malformed lines', async () => {
    for (const unit of ['[s]\n', 'x\n', 'EXTRACT-a=(\n']) {
      const conf = layers(fill(unit, half));
      await expectAnswered('validate', { props_conf: conf, transforms_conf: '', timeout_ms: BUDGET_MS });
      await expectAnswered('explain_precedence', { conf, sourcetype: 's', timeout_ms: BUDGET_MS });
    }
  }, 120_000);

  it('the maximum sample with an empty LINE_BREAKER group, breaking between every character', async () => {
    await expectAnswered('simulate', {
      raw: fill('ab', 1_000_000),
      sourcetype: 'st',
      props_conf: '[st]\nSHOULD_LINEMERGE = false\nLINE_BREAKER = ()\nTRUNCATE = 0',
      max_events: 500,
      include_snapshots: true,
      timeout_ms: BUDGET_MS,
    });
  }, 60_000);

  it('deeply nested JSON and XML, through every structured extraction', async () => {
    // Each as deep as the 1M-character sample limit allows.
    const samples = {
      json: `${'{"a":'.repeat(160_000)}1${'}'.repeat(160_000)}`,
      jsonArray: `${'['.repeat(490_000)}${']'.repeat(490_000)}`,
      xml: `${'<a>'.repeat(140_000)}x${'</a>'.repeat(140_000)}`,
    };
    // TRUNCATE = 0 so the whole depth reaches the parsers, not its first 10,000 bytes.
    const props = [
      '[json]\nTRUNCATE = 0\nINDEXED_EXTRACTIONS = json\nKV_MODE = json',
      '[xml]\nTRUNCATE = 0\nINDEXED_EXTRACTIONS = xml\nKV_MODE = xml',
      '[xmlkv]\nTRUNCATE = 0\nINDEXED_EXTRACTIONS = xmlkv',
    ].join('\n');
    for (const [sourcetype, raw] of [
      ['json', samples.json],
      ['json', samples.jsonArray],
      ['xml', samples.xml],
      ['xmlkv', samples.xml],
    ] as const) {
      await expectAnswered('simulate', { raw, sourcetype, props_conf: props, timeout_ms: BUDGET_MS });
    }
  }, 120_000);

  it('a flood of 20 concurrent calls: each answered, or refused with busy, in time', async () => {
    const evil = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
      'MATCH_LIMIT = 0',
      'DEPTH_LIMIT = 0',
      'EXTRACT-boom = ^(?<boom>(a|aa)+)(?=b)$',
    ].join('\n');
    const outs = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        i % 2 === 0
          ? expectAnswered(
              'simulate',
              { raw: `${'a'.repeat(200)}\n`, sourcetype: 'evil', props_conf: evil, timeout_ms: 500 },
              // Queued calls wait for the ones ahead: at most four budgets
              // (and start-ups) per slot, bounded by the queue.
              5 * (500 + 1_000),
            )
          : expectAnswered('lookup_directive', { key: '-'.repeat(200) }, BUDGET_MS, ['unknown_directive']),
      ),
    );
    expect(outs.filter((o) => o.error === 'timeout' || o.error === 'busy').length).toBe(10);
  }, 60_000);
});
