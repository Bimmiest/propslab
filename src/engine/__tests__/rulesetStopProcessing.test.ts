// ---------------------------------------------------------------------------
// rulesetStopProcessing.test.ts
// RULESET-<class>, STOP_PROCESSING_IF and ROUTE_EVENTS_OLDER_THAN (#275).
//
// Doc-derived throughout: no fixture captures any of the three, and none can
// be added (see fixtures/README.md). The sources are props.conf.spec (RULESET,
// RULESET_DESC, ROUTE_EVENTS_OLDER_THAN) and transforms.conf.spec
// (STOP_PROCESSING_IF), as summarised in directiveRegistry.ts. Assertions are
// kept to what the spec states outright: the order between TRANSFORMS and
// RULESET, the skip within a list, and the nullQueue route after timestamping.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { parseAge } from '../processors/routeByAge';
import { stopConditionHolds } from '../transforms/stopProcessing';
import { DIRECTIVE_SUPPORT } from '../directiveSupport';
import type { EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const NOW = Date.parse('2026-01-20T00:00:00Z');
const opts = { perEventPipeline: false, now: NOW };

const run = (raw: string, props: string, transforms: string) => runPipeline(raw, META, props, transforms, opts);
const processors = (r: ReturnType<typeof run>, i = 0) =>
  r.result.events[i]?.processingTrace.map((s) => s.processor) ?? [];

// Three stanzas that each stamp `tag`, so the last one to run is visible.
const TAGGERS = [
  '[tag_a]\nINGEST_EVAL = tag="a"',
  '[tag_b]\nINGEST_EVAL = tag="b"',
  '[tag_c]\nINGEST_EVAL = tag="c"',
].join('\n\n');

describe('RULESET-<class> (#275)', () => {
  it('applies its transforms at index time', () => {
    const transforms = '[mask]\nREGEX = secret=\\S+\nFORMAT = secret=####\nDEST_KEY = _raw\n';
    const r = run('user=bob secret=hunter2', '[st]\nRULESET-mask = mask\n', transforms);
    expect(r.result.events[0]?._raw).toBe('secret=####');
    expect(processors(r)).toContain('RULESET-mask:mask');
  });

  it('runs after every TRANSFORMS class, whatever the class names', () => {
    // RULESET-a sorts before TRANSFORMS-z by name; the spec orders by kind first.
    const props = '[st]\nRULESET-a = tag_b\nTRANSFORMS-z = tag_a\n';
    const r = run('x', props, TAGGERS);
    expect(r.result.events[0]?.fields.tag).toBe('b');
  });

  it('orders rulesets by class name, then by position within one', () => {
    const props = '[st]\nRULESET-b = tag_a\nRULESET-a = tag_c, tag_b\n';
    const r = run('x', props, TAGGERS);
    // a: c then b; then b: a. The last write is from RULESET-b.
    expect(r.result.events[0]?.fields.tag).toBe('a');
  });

  it('routes to nullQueue like TRANSFORMS does', () => {
    const transforms = '[drop]\nREGEX = DEBUG\nDEST_KEY = queue\nFORMAT = nullQueue\n';
    const r = run('DEBUG noise', '[st]\nRULESET-drop = drop\n', transforms);
    expect(r.result.events[0]?._meta._queue).toBe('nullQueue');
  });

  it('is not applied at search time', () => {
    const transforms = '[kv]\nREGEX = user:(?<user>\\w+)\n';
    const r = run('user:bob', '[st]\nRULESET-kv = kv\n', transforms);
    // Index time without WRITE_META stores nothing, and no REPORT- runs it.
    expect(r.result.events[0]?.fields.user).toBeUndefined();
  });

  it('treats RULESET_DESC as description only', () => {
    const r = run('x', '[st]\nRULESET-t = tag_a\nRULESET_DESC-t = stamps a tag\n', TAGGERS);
    expect(r.result.events[0]?.fields.tag).toBe('a');
    expect(DIRECTIVE_SUPPORT.RULESET_DESC?.support).toBe('documented');
  });
});

describe('STOP_PROCESSING_IF (#275)', () => {
  const STOPPER = '[stop]\nSTOP_PROCESSING_IF = match(_raw, "halt")\n';

  it('skips every rule after it in the same ruleset when true', () => {
    const r = run('please halt', '[st]\nRULESET-r = tag_a, stop, tag_b, tag_c\n', `${TAGGERS}\n\n${STOPPER}`);
    const ev = r.result.events[0];
    expect(ev?.fields.tag).toBe('a');
    const step = ev?.processingTrace.find((s) => s.processor === 'RULESET-r:stop');
    expect(step?.description).toContain('skipped the rest of RULESET-r: tag_b, tag_c');
  });

  it('lets the rest of the list run when false', () => {
    const r = run('carry on', '[st]\nRULESET-r = tag_a, stop, tag_b\n', `${TAGGERS}\n\n${STOPPER}`);
    expect(r.result.events[0]?.fields.tag).toBe('b');
    expect(processors(r)).toContain('RULESET-r:stop');
  });

  it('does not reach into a later list', () => {
    // The spec scopes the skip to "that ruleset"; the next class still runs.
    const props = '[st]\nRULESET-a = stop, tag_a\nRULESET-b = tag_b\n';
    const r = run('halt', props, `${TAGGERS}\n\n${STOPPER}`);
    expect(r.result.events[0]?.fields.tag).toBe('b');
  });

  it('applies the same skip within a TRANSFORMS- list, and RULESETs still follow', () => {
    const props = '[st]\nTRANSFORMS-t = stop, tag_a\nRULESET-r = tag_c\n';
    const r = run('halt', props, `${TAGGERS}\n\n${STOPPER}`);
    const ev = r.result.events[0];
    expect(ev?.fields.tag).toBe('c');
    expect(processors(r)).toContain('TRANSFORMS-t:stop');
  });

  it('runs after the INGEST_EVAL in its own stanza, and sees its result', () => {
    const transforms = `${TAGGERS}\n\n[eval_then_stop]\nINGEST_EVAL = sev="high"\nSTOP_PROCESSING_IF = sev == "high"\n`;
    const r = run('x', '[st]\nRULESET-r = eval_then_stop, tag_a\n', transforms);
    expect(r.result.events[0]?.fields.sev).toBe('high');
    expect(r.result.events[0]?.fields.tag).toBeUndefined();
  });

  it('overrides the stanza’s other index-time settings, as INGEST_EVAL does', () => {
    const transforms = '[s]\nREGEX = .\nDEST_KEY = queue\nFORMAT = nullQueue\nSTOP_PROCESSING_IF = 0\n';
    const r = run('x', '[st]\nRULESET-r = s\n', transforms);
    expect(r.result.events[0]?._meta._queue).toBeUndefined();
  });

  it('keeps processing and reports an expression that will not evaluate', () => {
    const transforms = `${TAGGERS}\n\n[bad]\nSTOP_PROCESSING_IF = (((\n`;
    const r = run('x', '[st]\nRULESET-r = bad, tag_a\n', transforms);
    expect(r.result.events[0]?.fields.tag).toBe('a');
    expect(r.diagnostics.some((d) => d.directiveKey === 'STOP_PROCESSING_IF' && d.level === 'error')).toBe(true);
  });

  it('reports an unsimulated function and a bad regex once each, as INGEST_EVAL does', () => {
    const transforms = '[s1]\nSTOP_PROCESSING_IF = md5(_raw) == "x"\n\n[s2]\nSTOP_PROCESSING_IF = match(_raw, "(")\n';
    const r = run('one\ntwo', '[st]\nSHOULD_LINEMERGE = false\nRULESET-r = s1, s2\n', transforms);
    const stop = r.diagnostics.filter((d) => d.directiveKey === 'STOP_PROCESSING_IF');
    expect(stop.filter((d) => d.message.startsWith('md5() is not fully simulated'))).toHaveLength(1);
    expect(stop.filter((d) => d.message.startsWith('STOP_PROCESSING_IF: '))).toHaveLength(1);
  });

  it('reads the result as the spec says: numeric 0 and null false, the rest true', () => {
    expect(stopConditionHolds(null)).toBe(false);
    expect(stopConditionHolds(0)).toBe(false);
    expect(stopConditionHolds('0')).toBe(false);
    expect(stopConditionHolds(false)).toBe(false);
    expect(stopConditionHolds([])).toBe(false);
    expect(stopConditionHolds(1)).toBe(true);
    expect(stopConditionHolds(true)).toBe(true);
    // "everything else": the eval engine's own truthiness would call these false.
    expect(stopConditionHolds('false')).toBe(true);
    expect(stopConditionHolds('')).toBe(true);
    expect(stopConditionHolds(['a'])).toBe(true);
  });
});

describe('ROUTE_EVENTS_OLDER_THAN (#275)', () => {
  const props = (age: string) =>
    `[st]\nSHOULD_LINEMERGE = false\nTIME_FORMAT = %Y-%m-%dT%H:%M:%SZ\nROUTE_EVENTS_OLDER_THAN = ${age}\n`;
  // Ten days and one day before NOW.
  const RAW = '2026-01-10T00:00:00Z old\n2026-01-19T00:00:00Z recent';

  it('routes events older than the age to nullQueue, measured from the injected now', () => {
    const r = run(RAW, props('7d'), '');
    const [old, recent] = r.result.events;
    expect(old?._meta._queue).toBe('nullQueue');
    expect(recent?._meta._queue).toBeUndefined();
  });

  it('says so in the trace', () => {
    const r = run(RAW, props('7d'), '');
    const step = r.result.events[0]?.processingTrace.find((s) => s.processor === 'ROUTE_EVENTS_OLDER_THAN');
    expect(step?.description).toContain('routed to nullQueue');
    expect(r.result.events[1]?.processingTrace.some((s) => s.processor === 'ROUTE_EVENTS_OLDER_THAN')).toBe(false);
  });

  it('runs after timestamp extraction and before the index-time transforms', () => {
    const r = run(RAW, props('7d') + 'TRANSFORMS-t = tag_a\n', TAGGERS);
    const trace = processors(r);
    const route = trace.indexOf('ROUTE_EVENTS_OLDER_THAN');
    expect(route).toBeGreaterThan(trace.indexOf('timestampExtractor'));
    expect(route).toBeLessThan(trace.indexOf('INGEST_EVAL'));
  });

  it('honours each unit', () => {
    expect(parseAge('30s')).toBe(30_000);
    expect(parseAge('5m')).toBe(300_000);
    expect(parseAge('2h')).toBe(7_200_000);
    expect(parseAge('1d')).toBe(86_400_000);
    expect(parseAge('45')).toBe(45_000);
    expect(parseAge('-1d')).toBeNull();
    expect(parseAge('1w')).toBeNull();
  });

  it('keeps both events when the age reaches back past them', () => {
    const r = run(RAW, props('30d'), '');
    expect(r.result.events.every((e) => e._meta._queue === undefined)).toBe(true);
  });

  it('warns about a malformed value and routes nothing', () => {
    const r = run(RAW, props('a week'), '');
    expect(r.result.events.every((e) => e._meta._queue === undefined)).toBe(true);
    expect(r.diagnostics.some((d) => d.directiveKey === 'ROUTE_EVENTS_OLDER_THAN' && d.level === 'warning')).toBe(true);
  });
});
