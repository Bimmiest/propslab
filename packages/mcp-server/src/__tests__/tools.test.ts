import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  explainInputShape,
  handleExplainPrecedence,
  handleLookupDirective,
  handleSimulate,
  handleValidate,
  MAX_TOTAL_CONF_CHARS,
  validateInputShape,
} from '../tools';
import { z } from 'zod';
import { collectRegexSuspects } from '../suspects';

/**
 * The handlers run engine code in a worker thread, and a worker loads
 * compiled JS — so these tests run against the built bundle (`pretest`
 * builds it) while the handler logic itself is imported from source.
 */
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

const ACCESS_PROPS = [
  '[access_log]',
  'SHOULD_LINEMERGE = false',
  'LINE_BREAKER = ([\\r\\n]+)',
  'TIME_PREFIX = \\[',
  'TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z',
  'EXTRACT-status = HTTP/1.1" (?<status>\\d{3})',
].join('\n');

const ACCESS_RAW =
  '10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET /a HTTP/1.1" 200 123\n' +
  '10.0.0.2 - - [02/Aug/2026:10:16:00 +0000] "GET /b HTTP/1.1" 404 55\n';

const simulateArgs = (overrides: Record<string, unknown> = {}) => ({
  raw: ACCESS_RAW,
  sourcetype: 'access_log',
  index: 'main',
  host: 'localhost',
  source: '/var/log/access.log',
  props_conf: ACCESS_PROPS,
  transforms_conf: '',
  per_event_pipeline: false,
  capture_offsets: false,
  include_snapshots: false,
  max_events: 20,
  timeout_ms: 10_000,
  ...overrides,
});

describe('simulate', () => {
  it('runs the pipeline and returns events with _time, fields, and a trace', async () => {
    const out = payload(await handleSimulate(simulateArgs(), WORKER_PATH));
    expect(out.eventCount).toBe(2);
    expect(out.events[0]._time).toBe('2026-08-02T10:15:00.000Z');
    expect(out.events[0].fields.status).toBe('200');
    expect(out.events[1].fields.status).toBe('404');
    const processors = out.events[0].processingTrace.map((s: { processor: string }) => s.processor);
    expect(processors).toContain('lineBreaker');
    expect(processors).toContain('EXTRACT-status');
    expect(out.diagnostics).toEqual([]);
  });

  it('caps returned events at max_events and says so', async () => {
    const out = payload(await handleSimulate(simulateArgs({ max_events: 1 }), WORKER_PATH));
    expect(out.eventCount).toBe(2);
    expect(out.returnedEvents).toBe(1);
    expect(out.truncationNote).toMatch(/max_events/);
  });

  it('strips trace snapshots unless include_snapshots is set', async () => {
    const lean = payload(await handleSimulate(simulateArgs(), WORKER_PATH));
    for (const step of lean.events[0].processingTrace) {
      expect(step).not.toHaveProperty('inputSnapshot');
    }
    const full = payload(
      await handleSimulate(simulateArgs({ include_snapshots: true }), WORKER_PATH),
    );
    const withSnapshot = full.events[0].processingTrace.some(
      (s: Record<string, unknown>) => 'inputSnapshot' in s || 'outputSnapshot' in s,
    );
    expect(withSnapshot).toBe(true);
  });

  it('hard-terminates a catastrophic regex and returns a structured timeout', async () => {
    // (a|aa)+ is the documented blind spot of the engine's structural ReDoS
    // heuristic (docs/engine.md): safeRegex compiles it, and the trailing
    // lookahead declines V8's linear-time fallback — so only the worker
    // watchdog can end this run.
    const evilProps = [
      '[evil]',
      'SHOULD_LINEMERGE = false',
      'EXTRACT-boom = ^(?<boom>(a|aa)+)(?=b)$',
    ].join('\n');
    const raw = `${'a'.repeat(200)}\n`;
    const result = await handleSimulate(
      simulateArgs({ raw, sourcetype: 'evil', props_conf: evilProps, timeout_ms: 1_000 }),
      WORKER_PATH,
    );
    expect(result.isError).toBe(true);
    const out = payload(result);
    expect(out.error).toBe('timeout');
    expect(out.budget_ms).toBe(1_000);
    const suspect = out.regex_directives.find(
      (s: { key: string }) => s.key === 'EXTRACT-boom',
    );
    expect(suspect).toBeDefined();
    expect(suspect.stanza).toBe('evil');
    expect(out.guidance).toMatch(/retry/i);
  }, 20_000);
});

describe('validate', () => {
  it('reports conf problems with no sample data', async () => {
    const props = ['[access_log]', 'TRANSFORMS-x = missing_stanza', 'SHOULD_LINEMERGE = maybe'].join(
      '\n',
    );
    const result = await handleValidate(
      { props_conf: props, transforms_conf: '', timeout_ms: 10_000 },
      WORKER_PATH,
    );
    const out = payload(result);
    const messages = out.diagnostics.map((d: { message: string }) => d.message);
    expect(messages.some((m: string) => m.includes('missing_stanza'))).toBe(true);
    expect(messages.some((m: string) => m.match(/boolean/i))).toBe(true);
    // Nothing event-level leaks out of the dummy-sample run.
    expect(out.diagnostics.every((d: { file: string }) => d.file !== 'raw')).toBe(true);
  });

  it('flags transforms settings that are inert in the phase they are used in', async () => {
    const props = ['[app]', 'TRANSFORMS-idx = t1'].join('\n');
    const transforms = ['[t1]', 'REGEX = (x)', 'FORMAT = f::$1', 'MV_ADD = true'].join('\n');
    const out = payload(
      await handleValidate(
        { props_conf: props, transforms_conf: transforms, timeout_ms: 10_000 },
        WORKER_PATH,
      ),
    );
    expect(
      out.diagnostics.some((d: { message: string }) => d.message.includes('MV_ADD')),
    ).toBe(true);
  });
});

describe('explain_precedence', () => {
  const layered = [
    { layer: 'default', text: '[access_log]\nTIME_FORMAT = %b %d\nCHARSET = UTF-8\n' },
    { layer: 'local', text: '[access_log]\nTIME_FORMAT = %Y-%m-%d\n' },
  ];

  it('reports which layer won each attribute', async () => {
    const out = payload(
      await handleExplainPrecedence(
        {
          file: 'props.conf',
          conf: layered,
          index: 'main',
          host: 'localhost',
          source: '/var/log/x',
          timeout_ms: 10_000,
        },
        WORKER_PATH,
      ),
    );
    expect(out.parseErrors).toEqual([]);
    const stanza = out.stanzas.find((s: { name: string }) => s.name === 'access_log');
    expect(stanza.layers.map((l: { layer: string }) => l.layer)).toEqual(['default', 'local']);
    const winner = stanza.directives.find(
      (d: { key: string; layer: string }) => d.key === 'TIME_FORMAT' && d.layer === 'local',
    );
    expect(winner.overrides).toEqual([{ layer: 'default', line: 2, value: '%b %d' }]);
    const loser = stanza.directives.find(
      (d: { key: string; layer: string }) => d.key === 'TIME_FORMAT' && d.layer === 'default',
    );
    expect(loser.overriddenBy).toEqual({ layer: 'local', line: 2, value: '%Y-%m-%d' });
  });

  it('resolves the effective directive set for a sourcetype', async () => {
    const out = payload(
      await handleExplainPrecedence(
        {
          file: 'props.conf',
          conf: layered,
          sourcetype: 'access_log',
          index: 'main',
          host: 'localhost',
          source: '/var/log/x',
          timeout_ms: 10_000,
        },
        WORKER_PATH,
      ),
    );
    expect(out.resolution).toBeDefined();
    expect(
      out.resolution.matchedStanzas.map((s: { name: string }) => s.name),
    ).toContain('access_log');
    const effective = Object.fromEntries(
      out.resolution.effectiveDirectives.map((d: { key: string; value: string }) => [
        d.key,
        d.value,
      ]),
    );
    // local/ wins the contested key; the default/-only key survives the merge.
    expect(effective.TIME_FORMAT).toBe('%Y-%m-%d');
    expect(effective.CHARSET).toBe('UTF-8');
  });
});

describe('lookup_directive', () => {
  it('returns the registry entry, including the simulation-support level', () => {
    const out = payload(handleLookupDirective({ key: 'LINE_BREAKER' }));
    expect(out.matches).toHaveLength(1);
    expect(out.matches[0].file).toBe('props.conf');
    expect(out.matches[0].valueType).toBe('regex');
    expect(out.matches[0]).toHaveProperty('support');
  });

  it('resolves class-based keys', () => {
    const out = payload(handleLookupDirective({ key: 'EXTRACT-status' }));
    expect(out.matches[0].key).toBe('EXTRACT');
    expect(out.classBased).toEqual({ base: 'EXTRACT', className: 'status' });
  });

  it('suggests the canonical casing for a mis-cased key', () => {
    const result = handleLookupDirective({ key: 'kv_mode' });
    expect(result.isError).toBe(true);
    const out = payload(result);
    expect(out.suggestions).toContainEqual({ file: 'props.conf', canonical: 'KV_MODE' });
  });

  it('lists directives per file when no key is given', () => {
    const out = payload(handleLookupDirective({ file: 'transforms.conf' }));
    expect(out['transforms.conf'].some((d: { key: string }) => d.key === 'REGEX')).toBe(true);
    expect(out).not.toHaveProperty('props.conf');
  });
});

// #335: the per-field limits admit 20 layers of 1M characters per file; the
// combined bound keeps a call inside what the worker heap and the timeout
// path's main-thread re-parse were sized for.
describe('conf size bound', () => {
  // Half the limit plus one in each file: each alone is under the combined
  // limit, together over. (As one flat string it exceeds the 1M per-field
  // limit, but the handlers are called directly here, past the schema.)
  const half = 'x'.repeat(MAX_TOTAL_CONF_CHARS / 2 + 1);
  const layers = (n: number, size: number) =>
    Array.from({ length: n }, (_, i) => ({ layer: `l${i}`, text: 'x'.repeat(size) }));

  it('refuses props + transforms over the combined limit before running anything', async () => {
    // A worker path that does not exist: had the handler spawned one, the
    // error would be an engine failure, not input_too_large.
    const nowhere = '/nonexistent/worker.js';
    for (const result of [
      await handleSimulate(simulateArgs({ props_conf: half, transforms_conf: half }), nowhere),
      await handleValidate({ props_conf: half, transforms_conf: half, timeout_ms: 1_000 }, nowhere),
    ]) {
      expect(result.isError).toBe(true);
      const out = payload(result);
      expect(out.error).toBe('input_too_large');
      expect(out.conf_chars).toBe(2 * half.length);
      expect(out.max_conf_chars).toBe(MAX_TOTAL_CONF_CHARS);
    }
  });

  it('counts every layer, not just each layer against its own limit', async () => {
    // Three layers of 700k: each under the 1M per-layer limit, 2.1M in all.
    const result = await handleExplainPrecedence(
      {
        file: 'props.conf',
        conf: layers(3, 700_000),
        index: 'main',
        host: 'localhost',
        source: '/var/log/x',
        timeout_ms: 1_000,
      },
      '/nonexistent/worker.js',
    );
    expect(payload(result).error).toBe('input_too_large');
  });

  it('is enforced by the schema for a single conf', () => {
    const explain = z.object(explainInputShape);
    expect(explain.safeParse({ conf: layers(3, 700_000) }).success).toBe(false);
    expect(explain.safeParse({ conf: layers(2, 700_000) }).success).toBe(true);
    // The combined sum is a cross-field rule the shape cannot express; the
    // handler owns it (above). Each field alone still passes the schema.
    const big = layers(2, 600_000);
    expect(
      z.object(validateInputShape).safeParse({ props_conf: big, transforms_conf: big }).success,
    ).toBe(true);
  });

  it('accepts input at the limit', async () => {
    const result = await handleValidate(
      { props_conf: half.slice(1), transforms_conf: half.slice(1), timeout_ms: 10_000 },
      WORKER_PATH,
    );
    expect(result.isError).toBeUndefined();
  }, 20_000);
});

describe('collectRegexSuspects', () => {
  it('flags structurally ReDoS-prone patterns and includes SEDCMD', () => {
    const props = ['[st]', 'EXTRACT-x = (?<x>(a+)+b)', 'SEDCMD-mask = s/\\d{4}/xxxx/g'].join('\n');
    const suspects = collectRegexSuspects(props, '');
    const extract = suspects.find((s) => s.key === 'EXTRACT-x');
    expect(extract?.redos_risk).toBe(true);
    expect(suspects.some((s) => s.key === 'SEDCMD-mask')).toBe(true);
    // Flagged suspects sort first.
    expect(suspects[0].key).toBe('EXTRACT-x');
  });
});
