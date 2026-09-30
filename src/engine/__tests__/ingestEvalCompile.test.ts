// INGEST_EVAL parses its assignments once per run and evaluates the compiled
// trees per event (#486), as EVAL- does.
//
// Not fidelity tests: parsing is invisible to Splunk's behaviour, so what these
// pin is that the result is the same as re-parsing, and how often the parser runs.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock('../processors/eval/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processors/eval/parser')>();
  return {
    ...actual,
    parseExpression: (expr: string) => {
      parses.count++;
      return actual.parseExpression(expr);
    },
  };
});

import { applyIngestEval } from '../transforms/ingestEval';
import { runPipeline } from '../pipeline';
import type { ConfDirective, EventMetadata, SplunkEvent } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const event = (raw: string): SplunkEvent => makeEvent(raw);
const ingest = (value: string, line = 1): ConfDirective => ({
  key: 'INGEST_EVAL',
  value,
  line,
  directiveType: 'INGEST_EVAL',
});

beforeEach(() => {
  parses.count = 0;
});

describe('INGEST_EVAL compiles once per run (#486)', () => {
  it('parses each assignment once however many events it evaluates', () => {
    const dirs = [ingest('a=len(_raw), b="k" . _raw, c=upper(_raw)')];
    const out = applyIngestEval(['x', 'yy', 'zzz', 'w'].map(event), dirs, runCtx(FIXED_NOW));
    expect(parses.count).toBe(3);
    // The compiled tree is evaluated against each event.
    expect(out.map((e) => e.fields['a'])).toEqual(['1', '2', '3', '1']);
    expect(out.map((e) => e.fields['b'])).toEqual(['kx', 'kyy', 'kzzz', 'kw']);
    expect(out.map((e) => e.fields['c'])).toEqual(['X', 'YY', 'ZZZ', 'W']);
  });

  it('keeps parsing once across separate calls in one run, one event at a time', () => {
    const ctx = runCtx(FIXED_NOW);
    const dirs = [ingest('a=len(_raw)')];
    for (const raw of ['x', 'yy', 'zzz']) applyIngestEval([event(raw)], dirs, ctx);
    expect(parses.count).toBe(1);
  });

  it('parses again in a new run, so an edited config is never served from the last one', () => {
    const dirs = [ingest('a=len(_raw)')];
    applyIngestEval([event('x')], dirs, runCtx(FIXED_NOW));
    applyIngestEval([event('x')], dirs, runCtx(FIXED_NOW));
    expect(parses.count).toBe(2);
  });

  it('parses the directive that applies (the last one), not the ones it replaced', () => {
    const dirs = [ingest('a=1', 1), ingest('b=2', 2)];
    const [out] = applyIngestEval([event('x')], dirs, runCtx(FIXED_NOW));
    expect(parses.count).toBe(1);
    expect(out!.fields).toEqual({ b: '2' });
  });

  it('a malformed assignment fails on every event without stopping the others', () => {
    const ctx = runCtx(FIXED_NOW);
    const out = applyIngestEval([event('x'), event('yy')], [ingest('a=1+, b=len(_raw)')], ctx);
    expect(parses.count).toBe(2);
    expect(out.map((e) => e.fields['b'])).toEqual(['1', '2']);
    expect(out.every((e) => e.fields['a'] === undefined)).toBe(true);
    // Reported once, not once per event.
    expect(ctx.diagnostics.list.filter((d) => d.level === 'error')).toHaveLength(1);
  });

  it('parses once per run through the pipeline, in both modes', () => {
    const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
    const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-e = ev\n';
    const transforms = '[ev]\nINGEST_EVAL = n=len(_raw), tag="t"\n';
    for (const perEventPipeline of [false, true]) {
      parses.count = 0;
      const { result } = runPipeline('one\ntwo\nthree\nfour\nfive', meta, props, transforms, { perEventPipeline });
      expect(result.events.map((e) => e.fields['n'])).toEqual(['3', '3', '5', '4', '4']);
      // Two assignments; the count is not multiplied by the five events.
      expect(parses.count).toBe(2);
    }
  });
});
