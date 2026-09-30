// ---------------------------------------------------------------------------
// toolsProperties.test.ts
// Property-based tests for the MCP tool handlers.
//
// Inputs are generated from what an agent can send: samples of log-like and
// arbitrary text, props/transforms confs (flat or layered) whose directives
// carry valid, invalid and ReDoS-prone regexes, malformed lines and odd
// values, and every combination of max_events and include_snapshots. The
// properties:
//  - no handler throws: every outcome is a tool result, errors included;
//  - a simulate response stays under the response budget (responseBudget.ts),
//    in bytes, however large the events, traces and diagnostics behind it;
//  - validate reports every regex-bearing directive whose pattern fails
//    validateRegex;
//  - every success carries structuredContent that equals the text payload
//    and parses against the tool's output schema.
//
// The handlers run in a worker thread per call, so those properties take few
// runs; the cap and the regex lint are also checked in-process, where runs
// are cheap. Whether a pattern is valid is always validateRegex's answer, so
// nothing here depends on regex semantics.
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { handleExplainPrecedence, handleSimulate, handleValidate } from '../tools';
import { serializeSimulation } from '../serialize';
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES, responseBytes } from '../responseBudget';
import { explainOutputShape, simulateOutputShape, validateOutputShape } from '../outputSchemas';
import { lintRegexDirectives } from '../regexLint';
import { regexEngineModule } from '../regexEngine';
import { resultText } from './resultText';
import { parseConf } from '../../../../src/engine/parser/confParser';
import { getDirectivesForFile } from '../../../../src/engine/directiveRegistry';
import { validateRegex } from '../../../../src/utils/splunkRegex';
import type {
  ConfInput,
  ProcessingResult,
  SplunkEvent,
  ValidationDiagnostic,
} from '../../../../src/engine/types';
import { fcSeed } from './fcSeed';

fc.configureGlobal({ seed: fcSeed(371), numRuns: 100 });

/** Built by `pretest`; see tools.test.ts. */
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));

type File = 'props.conf' | 'transforms.conf';

// ── Generators ──────────────────────────────────────────

/** Regex fragments; concatenated, they make valid, invalid and ReDoS-prone patterns alike. */
const regexFragment = fc.constantFrom(
  '(\\d+)', '(?<f>\\w+)', '(?P<g>[a-z]+)', '[\\r\\n]+', 'a|b', '\\s*', '^', '$', 'x{2,3}',
  '(', ')', '[a', ']', '*', '+', '?', '{2,1}', '(?<1x>a)', '(?z)', '\\', '(a+)+', '(.*)*', '\\k<nope>',
);
const pattern = fc.array(regexFragment, { minLength: 1, maxLength: 4 }).map((fs) => fs.join(''));

const regexKeys = (file: File) =>
  getDirectivesForFile(file)
    .filter((d) => d.valueType === 'regex')
    .map((d) => d.key)
    // Class-based keys are listed by their prefix; give them a class.
    .map((k) => (k === 'EXTRACT' ? 'EXTRACT-f' : k));

const regexDirective = (file: File) =>
  fc.tuple(fc.constantFrom(...regexKeys(file)), pattern).map(([k, p]) => `${k} = ${p}`);

const sedDirective = pattern
  .filter((p) => !p.includes('/') && !p.endsWith('\\'))
  .map((p) => `SEDCMD-s = s/${p}/x/g`);

const otherLine = (file: File) =>
  fc.constantFrom(
    ...(file === 'props.conf'
      ? ['SHOULD_LINEMERGE = false', 'SHOULD_LINEMERGE = maybe', 'TIME_FORMAT = %Y-%m-%d %H:%M:%S', 'TIME_PREFIX = ^',
         'KV_MODE = json', 'TRUNCATE = 50', 'MAX_EVENTS = x', 'TRANSFORMS-t = t1', 'REPORT-r = t2, missing',
         'EVAL-z = len(_raw) + 1', 'EVAL-bad = (', 'FIELDALIAS-a = f AS g', 'DATETIME_CONFIG = CURRENT']
      : ['FORMAT = f::$1', 'FORMAT = $1', 'DEST_KEY = _raw', 'DEST_KEY = MetaData:Sourcetype', 'WRITE_META = true',
         'MV_ADD = true', 'SOURCE_KEY = _raw', 'DELIMS = ",", "="', 'FIELDS = a, b', 'INGEST_EVAL = x = 1']),
    'not a directive', '  INDENTED = 1', '# comment', '', 'LINE_BREAKER = \\', '[unclosed',
  );

const stanzaHeader = (file: File) =>
  fc.constantFrom(...(file === 'props.conf'
    ? ['[st]', '[default]', '[source::/var/log/*]', '[host::web*]', '[other]']
    : ['[t1]', '[t2]', '[t3]']));

const conf = (file: File) =>
  fc
    .array(
      fc.oneof(
        { weight: 1, arbitrary: stanzaHeader(file) },
        { weight: 3, arbitrary: regexDirective(file) },
        { weight: 1, arbitrary: file === 'props.conf' ? sedDirective : regexDirective(file) },
        { weight: 2, arbitrary: otherLine(file) },
      ),
      { maxLength: 12 },
    )
    .map((ls) => ls.join('\n'));

/** Flat, or split into default/local layers. */
const confInput = (file: File): fc.Arbitrary<ConfInput> =>
  fc.oneof(conf(file), fc.tuple(conf(file), conf(file)).map(([d, l]) => [
    { layer: 'default', text: d },
    { layer: 'local', text: l },
  ]));

const sampleLine = fc.oneof(
  fc.constantFrom(
    '2026-08-02 10:15:00 INFO start user=a status=200',
    '10.0.0.1 - - [02/Aug/2026:10:15:00 +0000] "GET / HTTP/1.1" 200 12',
    '{"a": 1, "b": {"c": [1, 2]}}',
    '<14>Aug  2 10:15:00 host app[1]: msg',
    '    at com.example.Main(Main.java:10)',
    '',
  ),
  fc.string({ maxLength: 40, unit: 'binary' }),
);
const sample = fc
  .tuple(fc.array(sampleLine, { minLength: 1, maxLength: 8 }), fc.constantFrom(1, 1, 20))
  .map(([ls, times]) => `${ls.join('\n')}\n`.repeat(times))
  .filter((s) => s.length > 0);

// ── Helpers ─────────────────────────────────────────────

const text = resultText;

/** A success's structuredContent is its text payload, valid against `shape`. */
function expectStructured(
  r: { content: { text: string }[]; structuredContent?: Record<string, unknown> },
  shape: z.ZodRawShape,
) {
  expect(r.structuredContent).toEqual(JSON.parse(text(r)));
  const parsed = z.strictObject(shape).safeParse(r.structuredContent);
  expect(parsed.error).toBeUndefined();
}

/** Every directive the regex lint must see, with the pattern it compiles. */
function regexBearing(input: ConfInput, file: File) {
  const keys = new Set(regexKeys(file).map((k) => (k === 'EXTRACT-f' ? 'EXTRACT' : k)));
  return parseConf(input, file).stanzas.flatMap((s) =>
    s.directives.flatMap((d) => {
      const base = d.className !== undefined ? d.directiveType : d.key;
      if (d.value.trim() === '') return [];
      if (d.directiveType === 'SEDCMD') {
        // The generator writes `s/<pattern>/x/g` with no `/` inside the pattern.
        const p = /^s\/(.*)\/x\/g$/.exec(d.value.trim())?.[1];
        return p === undefined ? [] : [{ d, pattern: p }];
      }
      return keys.has(base) ? [{ d, pattern: d.value.trim() }] : [];
    }),
  );
}

function expectEveryBadPatternReported(
  input: ConfInput,
  file: File,
  diagnostics: ValidationDiagnostic[],
): void {
  for (const { d, pattern: p } of regexBearing(input, file)) {
    if (validateRegex(p) === null) continue;
    const reported = diagnostics.some(
      (x) => x.file === file && x.directiveKey === d.key && x.line === d.line && x.layer === d.layer,
    );
    expect(reported, `${file} ${d.layer ?? ''}:${d.line} ${d.key} = ${d.value}`).toBe(true);
  }
}

// ── In-process ──────────────────────────────────────────

// The in-process properties call the regex engine on this thread, which the
// server otherwise loads only for its sandbox workers.
beforeAll(() => {
  regexEngineModule();
});

describe('validate — the regex lint reports every pattern validateRegex rejects', () => {
  it('in every stanza of props and transforms, flat or layered', () => {
    fc.assert(
      fc.property(confInput('props.conf'), confInput('transforms.conf'), (props, transforms) => {
        const diagnostics = lintRegexDirectives(
          parseConf(props, 'props.conf'),
          parseConf(transforms, 'transforms.conf'),
        );
        expectEveryBadPatternReported(props, 'props.conf', diagnostics);
        expectEveryBadPatternReported(transforms, 'transforms.conf', diagnostics);
      }),
    );
  });
});

describe('serializeSimulation — the response stays under MAX_PAYLOAD_BYTES', () => {
  const raw = (n: number) => 'r'.repeat(n);
  const event = (rawLength: number, steps: number): SplunkEvent => {
    const r = raw(rawLength);
    return {
      _raw: r,
      _time: new Date(0),
      _meta: {},
      fields: { f: r.slice(0, 100) },
      metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      lineNumbers: { start: 1, end: 1 },
      processingTrace: Array.from({ length: steps }, () => ({
        processor: 'SEDCMD-x',
        phase: 'index-time' as const,
        description: 'replaced',
        inputSnapshot: r,
        outputSnapshot: r,
      })),
    };
  };

  it('whatever the events, traces, diagnostics, max_events and include_snapshots', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 600 }),
        fc.constantFrom(10, 1_000, 20_000, 400_000),
        fc.integer({ min: 0, max: 4 }),
        fc.integer({ min: 0, max: 300 }),
        fc.constantFrom(50, 5_000, 300_000),
        fc.integer({ min: 1, max: 500 }),
        fc.boolean(),
        (eventCount, rawLength, steps, diagnosticCount, messageLength, maxEvents, includeSnapshots) => {
          const e = event(rawLength, steps);
          const result = { events: Array(eventCount).fill(e), eventCount } as unknown as ProcessingResult;
          const message = raw(messageLength);
          const diagnostics: ValidationDiagnostic[] = Array.from({ length: diagnosticCount }, () => ({
            level: 'warning',
            message,
            file: 'props.conf',
          }));
          const out = serializeSimulation(result, diagnostics, { maxEvents, includeSnapshots });
          expect(responseBytes(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
          expect(out.returnedEvents).toBeLessThanOrEqual(Math.min(maxEvents, eventCount));
        },
      ),
      { numRuns: 60 },
    );
    // Each run serializes up to 8 MB twice over; alongside the worker-heavy
    // suites that is past the default timeout, and coverage instrumentation
    // (npm run test:coverage) makes it about five times slower again.
  }, 120_000);
});

// ── Through the handlers (one worker per call) ──────────

describe('tool handlers — random input never throws out of the handler', () => {
  it('simulate: a result under the cap for any sample, conf and output options', async () => {
    await fc.assert(
      fc.asyncProperty(
        sample,
        confInput('props.conf'),
        confInput('transforms.conf'),
        fc.integer({ min: 1, max: 500 }),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        async (raw, props, transforms, maxEvents, includeSnapshots, perEvent, captureOffsets) => {
          const result = await handleSimulate(
            {
              raw,
              sourcetype: 'st',
              index: 'main',
              host: 'web1',
              source: '/var/log/app.log',
              props_conf: props,
              transforms_conf: transforms,
              per_event_pipeline: perEvent,
              capture_offsets: captureOffsets,
              include_snapshots: includeSnapshots,
              max_events: maxEvents,
              timeout_ms: 10_000,
            },
            WORKER_PATH,
          );
          expect(
            Buffer.byteLength(JSON.stringify({ result, jsonrpc: '2.0', id: 1 })),
          ).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
          const out = JSON.parse(text(result));
          // An error result is structured; the engine itself must not fail.
          if (result.isError) {
            expect(out.error).not.toBe('engine_failure');
            expect(result).not.toHaveProperty('structuredContent');
          } else {
            expect(out.returnedEvents).toBeLessThanOrEqual(maxEvents);
            expectStructured(result, simulateOutputShape);
          }
        },
      ),
      { numRuns: 12 },
    );
  }, 60_000);

  it('validate: reports every pattern validateRegex rejects', async () => {
    await fc.assert(
      fc.asyncProperty(confInput('props.conf'), confInput('transforms.conf'), async (props, transforms) => {
        const result = await handleValidate(
          { props_conf: props, transforms_conf: transforms, timeout_ms: 10_000 },
          WORKER_PATH,
        );
        expect(result.isError).toBeUndefined();
        expectStructured(result, validateOutputShape);
        const { diagnostics } = JSON.parse(text(result)) as { diagnostics: ValidationDiagnostic[] };
        expectEveryBadPatternReported(props, 'props.conf', diagnostics);
        expectEveryBadPatternReported(transforms, 'transforms.conf', diagnostics);
      }),
      { numRuns: 12 },
    );
  }, 60_000);

  it('explain_precedence: a result for any conf, file and sourcetype', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<File>('props.conf', 'transforms.conf'),
        confInput('props.conf'),
        fc.option(fc.constantFrom('st', 'other', 'x'), { nil: undefined }),
        async (file, input, sourcetype) => {
          const result = await handleExplainPrecedence(
            { file, conf: input, sourcetype, index: 'main', host: 'web1', source: '/var/log/app.log', timeout_ms: 10_000 },
            WORKER_PATH,
          );
          expect(result.isError).toBeUndefined();
          expect(JSON.parse(text(result))).toHaveProperty('stanzas');
          expectStructured(result, explainOutputShape);
        },
      ),
      { numRuns: 8 },
    );
  }, 60_000);
});
