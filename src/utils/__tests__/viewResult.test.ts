import { describe, it, expect } from 'vitest';
import { runPipeline } from '../../engine/pipeline';
import type { ProcessingResult, ProcessingStep, SplunkEvent } from '../../engine/types';
import { summarizeSteps, toViewResult } from '../viewResult';

const meta = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function event(raw: string, trace: ProcessingStep[], extra: Partial<SplunkEvent> = {}): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { ...meta },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: trace,
    ...extra,
  };
}

function resultOf(events: SplunkEvent[]): ProcessingResult {
  return {
    events,
    originalRaw: events.map((e) => e._raw).join('\n'),
    eventCount: events.length,
    processingSteps: events.flatMap((e) => e.processingTrace),
    inputMetadata: meta,
  };
}

const kv = (n: number): ProcessingStep => ({
  processor: 'KV_MODE(auto)',
  phase: 'search-time',
  description: `Extracted ${n} fields via KV_MODE=auto`,
  fieldsAdded: ['a', 'b'].slice(0, n),
});
const lineBreak = (line: number): ProcessingStep => ({
  processor: 'lineBreaker',
  phase: 'index-time',
  description: `LINE_BREAKER split raw data into segment (lines ${line}-${line})`,
  outputSnapshot: `line ${line}`,
});

describe('toViewResult', () => {
  it('drops prose and snapshots from every step and keeps the rest', () => {
    const step: ProcessingStep = {
      processor: 'SEDCMD-mask',
      phase: 'index-time',
      description: 'Applied sed',
      inputSnapshot: 'ssn=123',
      outputSnapshot: 'ssn=XXX',
      fieldsModified: ['ssn'],
      metadataChanges: [{ key: 'host', from: 'h', to: 'web01' }],
    };
    const [view] = toViewResult(resultOf([event('ssn=XXX', [step])])).events;
    expect(view!.processingTrace).toEqual([
      { processor: 'SEDCMD-mask', phase: 'index-time', fieldsModified: ['ssn'], metadataChanges: [{ key: 'host', from: 'h', to: 'web01' }] },
    ]);
  });

  it('shares one trace array between events whose steps match, prose aside', () => {
    const view = toViewResult(resultOf([
      event('a=1', [lineBreak(1), kv(2)]),
      event('a=2', [lineBreak(2), kv(2)]),
      event('a=3', [lineBreak(3), kv(1)]),
    ]));
    const [first, second, third] = view.events.map((e) => e.processingTrace);
    expect(first).toBe(second);
    expect(third).not.toBe(first);
    expect(third![1]!.fieldsAdded).toEqual(['a']);
  });

  it('keeps steps apart when any structured field differs', () => {
    const variants: ProcessingStep[] = [
      { processor: 'p', phase: 'index-time', description: '' },
      { processor: 'p', phase: 'search-time', description: '' },
      { processor: 'p', phase: 'index-time', description: '', timeSource: 'TIME_FORMAT' },
      { processor: 'p', phase: 'index-time', description: '', fieldsAdded: ['x'] },
      { processor: 'p', phase: 'index-time', description: '', fieldsModified: ['x'] },
      { processor: 'p', phase: 'index-time', description: '', fieldsRemoved: ['x'] },
      { processor: 'p', phase: 'index-time', description: '', fieldAliases: [{ target: 'x', source: 'y' }] },
      { processor: 'p', phase: 'index-time', description: '', evalExpressions: { x: '1' } },
      { processor: 'p', phase: 'index-time', description: '', metadataChanges: [{ key: 'host', from: 'a', to: 'b' }] },
      { processor: 'p', phase: 'index-time', description: '', truncation: { lines: 1, limitBytes: 5, isDefault: false } },
      { processor: 'q', phase: 'index-time', description: '' },
      // A list boundary moving must not collide: ['x,y'] vs ['x', 'y'].
      { processor: 'p', phase: 'index-time', description: '', fieldsAdded: ['x', 'y'] },
      { processor: 'p', phase: 'index-time', description: '', fieldsAdded: ['x,y'] },
    ];
    const traces = toViewResult(resultOf(variants.map((s) => event('e', [s])))).events.map((e) => e.processingTrace);
    expect(new Set(traces).size).toBe(variants.length);
  });

  it('shares metadata objects between events with equal metadata', () => {
    const view = toViewResult(resultOf([
      event('a', []),
      event('b', []),
      event('c', [], { metadata: { ...meta, host: 'other' } }),
    ]));
    expect(view.events[0]!.metadata).toBe(view.events[1]!.metadata);
    expect(view.events[2]!.metadata).toEqual({ ...meta, host: 'other' });
  });

  it('drops timestampText only where it is the same as _raw', () => {
    const view = toViewResult(resultOf([
      event('t=1 a', [], { timestampText: 't=1 a' }),
      event('a', [], { timestampText: 't=1 a' }),
      event('b', []),
    ]));
    expect(view.events.map((e) => e.timestampText)).toEqual([undefined, 't=1 a', undefined]);
    expect('timestampText' in view.events[0]!).toBe(false);
  });

  it('replaces processingSteps with the Pipeline tab summary and keeps the rest of the result', () => {
    const result = resultOf([event('a', [kv(2)])]);
    const view = toViewResult(result);
    expect('processingSteps' in view).toBe(false);
    expect(view.stepSummaries).toEqual(summarizeSteps(result.events));
    expect(view.originalRaw).toBe(result.originalRaw);
    expect(view.eventCount).toBe(1);
    expect(view.inputMetadata).toBe(meta);
  });

  it('survives a structured clone with its sharing intact', () => {
    const view = toViewResult(resultOf([event('a', [kv(2)]), event('b', [kv(2)])]));
    const copy = structuredClone(view);
    expect(copy.events[0]!.processingTrace).toBe(copy.events[1]!.processingTrace);
    expect(copy).toEqual(view);
  });

  it('matches the stripped trace of every event of a real run', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `t=${1_700_000_000 + i} host=web${i % 3} user=u${i % 4} ssn=123-45-${String(1000 + i)}`).join('\n');
    const props = [
      '[st]',
      'SHOULD_LINEMERGE = false',
      'TIME_PREFIX = ^t=',
      'TIME_FORMAT = %s',
      'SEDCMD-mask = s/ssn=\\d{3}-\\d{2}/ssn=XXX-XX/',
      'TRANSFORMS-h = set_host',
      'KV_MODE = auto',
      'FIELDALIAS-u = user AS account',
      'EVAL-n = len(user)',
    ].join('\n');
    const transforms = '[set_host]\nREGEX = host=(\\S+)\nFORMAT = host::$1\nDEST_KEY = MetaData:Host\n';
    const { result } = runPipeline(raw, meta, props, transforms);
    const view = toViewResult(result);
    expect(view.events).toHaveLength(30);
    view.events.forEach((viewEvent, i) => {
      const original = result.events[i]!;
      expect(viewEvent.processingTrace).toEqual(
        original.processingTrace.map(({ description: _d, inputSnapshot: _i, outputSnapshot: _o, ...rest }) => rest),
      );
      expect(viewEvent.fields).toBe(original.fields);
      expect(viewEvent.metadata).toEqual(original.metadata);
    });
    // Three hosts, so at most three distinct traces once the prose is gone.
    expect(new Set(view.events.map((e) => e.processingTrace)).size).toBeLessThanOrEqual(3);
  });
});

describe('summarizeSteps', () => {
  it('groups by processor and counts events, not steps', () => {
    const twice: ProcessingStep = { processor: 'SEDCMD-x', phase: 'index-time', description: 'd', fieldsModified: ['m'] };
    const [sed, kvRow] = summarizeSteps([
      event('a', [twice, { ...twice, fieldsRemoved: ['r'] }, kv(2)]),
      event('b', [kv(1)]),
    ]);
    expect(sed).toMatchObject({ processor: 'SEDCMD-x', eventsAffected: 1, totalEvents: 2, fieldsModified: ['m'], fieldsRemoved: ['r'] });
    expect(kvRow).toMatchObject({
      processor: 'KV_MODE(auto)',
      eventsAffected: 2,
      descriptions: ['Extracted 2 fields via KV_MODE=auto', 'Extracted 1 fields via KV_MODE=auto'],
      fieldsAdded: ['a', 'b'],
    });
  });

  it('shows the shared description once per-event detail is stripped, else the first', () => {
    const [lb] = summarizeSteps([event('a', [lineBreak(1)]), event('b', [lineBreak(2)])]);
    expect(lb!.summaryText).toBe('LINE_BREAKER split raw data into segment');
    expect(lb!.descriptions).toHaveLength(2);

    const [kvRow] = summarizeSteps([event('a', [kv(2)]), event('b', [kv(1)])]);
    expect(kvRow!.summaryText).toBe('Extracted 2 fields via KV_MODE=auto');
  });

  it('is empty for no events', () => {
    expect(summarizeSteps([])).toEqual([]);
  });
});
