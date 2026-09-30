import { describe, expect, it } from 'vitest';
import type { ProcessingResult, SplunkEvent, ValidationDiagnostic } from '../../../../src/engine/types';
import { serializeSimulation } from '../serialize';
import { MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES, responseBytes } from '../responseBudget';
import { makeEvent } from '../../../../src/test/makeEvent';

// Everything in a simulate response that grows with the sample is bounded.

const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function event(i: number, rawChars: number, steps: number): SplunkEvent {
  const raw = `${i}:${'x'.repeat(rawChars)}`;
  return makeEvent(raw, {
    metadata,
    lineNumbers: { start: i + 1, end: i + 1 },
    processingTrace: Array.from({ length: steps }, (_, s) => ({
      processor: `step${s}`,
      phase: 'index-time' as const,
      description: 'did something',
      inputSnapshot: raw,
      outputSnapshot: raw,
    })),
  });
}

function result(events: SplunkEvent[]): ProcessingResult {
  return {
    events,
    originalRaw: '',
    eventCount: events.length,
    processingSteps: events.flatMap((e) => e.processingTrace),
    inputMetadata: metadata,
  };
}

// Bytes of both copies on the wire (responseBudget.ts), checked against a
// literal serialization of them.
const size = (v: unknown) => {
  const bytes = responseBytes(v);
  const text = JSON.stringify(v);
  expect(bytes).toBe(Buffer.byteLength(JSON.stringify(text)) + Buffer.byteLength(text));
  return bytes;
};

describe('serializeSimulation', () => {
  it('returns max_events events and nothing per event beyond them', () => {
    const events = Array.from({ length: 10_000 }, (_, i) => event(i, 1, 3));
    const out = serializeSimulation(result(events), [], { maxEvents: 2, includeSnapshots: false });
    expect(out.eventCount).toBe(10_000);
    expect(out.returnedEvents).toBe(2);
    expect(out.truncationNote).toMatch(/max_events/);
    expect(size(out)).toBeLessThan(5_000);
  });

  it('sends each trace once: no processingSteps copy beside the events (#489)', () => {
    const out = serializeSimulation(result([event(0, 1, 3)]), [], { maxEvents: 20, includeSnapshots: false });
    expect(out).not.toHaveProperty('processingSteps');
    expect(JSON.stringify(out).match(/did something/g)).toHaveLength(3);
  });

  it('emits fieldOffsets only when asked, and noOps and clonedFrom whenever present (#489)', () => {
    const noOp = {
      directive: 'EXTRACT-user',
      file: 'props.conf' as const,
      line: 3,
      phase: 'search-time' as const,
      reason: { kind: 'no-match' as const },
    };
    const e: SplunkEvent = {
      ...event(0, 3, 0),
      fieldOffsets: { user: [[2, 5]] },
      noOps: [noOp],
      clonedFrom: 'original_st',
    };
    const off = serializeSimulation(result([e]), [], { maxEvents: 20, includeSnapshots: false });
    expect(off.events[0]).not.toHaveProperty('fieldOffsets');
    expect(off.events[0]?.clonedFrom).toBe('original_st');
    expect(off.events[0]?.noOps).toEqual([
      { ...noOp, description: 'the pattern did not match anywhere in the source' },
    ]);
    const on = serializeSimulation(result([e]), [], {
      maxEvents: 20,
      includeSnapshots: false,
      includeOffsets: true,
    });
    expect(on.events[0]?.fieldOffsets).toEqual({ user: [[2, 5]] });
    // Neither appears on an event that has none.
    const plain = serializeSimulation(result([{ ...event(0, 3, 0), noOps: [] }]), [], {
      maxEvents: 20,
      includeSnapshots: false,
      includeOffsets: true,
    });
    for (const key of ['fieldOffsets', 'noOps', 'clonedFrom']) expect(plain.events[0]).not.toHaveProperty(key);
  });

  it('returns fewer events than max_events when they would exceed the size cap, and says so', () => {
    // 500 events of ~20k characters, each step carrying two snapshots of it:
    // far past the cap with snapshots, well inside it without.
    const events = Array.from({ length: 500 }, (_, i) => event(i, 20_000, 2));
    const out = serializeSimulation(result(events), [], { maxEvents: 500, includeSnapshots: true });
    expect(size(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(out.returnedEvents).toBeGreaterThan(0);
    expect(out.returnedEvents).toBeLessThan(500);
    expect(out.events).toHaveLength(out.returnedEvents);
    expect(out.truncationNote).toMatch(/capped at/);
    // The cap fills rather than halving: the next event would not have fit.
    const oneMore = serializeSimulation(result(events.slice(0, out.returnedEvents + 1)), [], {
      maxEvents: out.returnedEvents + 1,
      includeSnapshots: true,
    });
    expect(oneMore.returnedEvents).toBe(out.returnedEvents);
  });

  it('returns no event at all rather than one over the cap', () => {
    const out = serializeSimulation(result([event(0, MAX_PAYLOAD_BYTES, 0)]), [], {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(out.returnedEvents).toBe(0);
    expect(out.eventCount).toBe(1);
    expect(out.truncationNote).toMatch(/capped at/);
    expect(size(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
  });

  it('caps diagnostics too, keeping the total count', () => {
    const diagnostics: ValidationDiagnostic[] = Array.from({ length: 50_000 }, (_, i) => ({
      level: 'warning',
      message: `diagnostic ${i} ${'y'.repeat(100)}`,
      file: 'props.conf',
      line: i,
    }));
    const out = serializeSimulation(result([event(0, 10, 1)]), diagnostics, {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(size(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(out.diagnostics.length).toBeLessThan(50_000);
    expect(out.diagnosticCount).toBe(50_000);
    expect(out.truncationNote).toMatch(/diagnostics/);
    // Diagnostics take at most half the budget; the event still fits.
    expect(out.returnedEvents).toBe(1);
  });

  it('counts bytes, not characters: non-ASCII and quote-heavy events stay under the cap (#414)', () => {
    // 940k characters of CJK held under a character cap came out as an
    // 11 MB line: three bytes each, in both copies.
    for (const unit of ['日本語', '"\\', '😀']) {
      const e = event(0, 0, 1);
      e._raw = unit.repeat(Math.ceil(940_000 / unit.length));
      for (const step of e.processingTrace) {
        step.inputSnapshot = e._raw;
        step.outputSnapshot = e._raw;
      }
      const events = [e, e, e];
      for (const includeSnapshots of [false, true]) {
        const out = serializeSimulation(result(events), [], { maxEvents: 20, includeSnapshots });
        expect(size(out)).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
        expect(out.returnedEvents).toBeLessThan(3);
      }
    }
  });

  it('returns null for an Invalid Date instead of throwing (#417)', () => {
    const e = { ...event(0, 1, 0), _time: new Date(1e20) };
    const out = serializeSimulation(result([e]), [], { maxEvents: 20, includeSnapshots: false });
    expect(out.events[0]?._time).toBeNull();
  });

  it("keeps the simulator's _queue routing slot out of indexedFields", () => {
    const e = { ...event(0, 1, 0), _meta: { _queue: 'myQueue', env: 'prod', tag: ['a', 'b'] } };
    const out = serializeSimulation(result([e]), [], { maxEvents: 20, includeSnapshots: false });
    expect(out.events[0]?.indexedFields).toEqual({ env: 'prod', tag: ['a', 'b'] });
  });

  it('adds nothing when nothing was cut', () => {
    const out = serializeSimulation(result([event(0, 10, 1)]), [], {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(out).not.toHaveProperty('truncationNote');
    expect(out).not.toHaveProperty('diagnosticCount');
  });

  it('shapes an event: ISO _time, and trace snapshots only when asked for', () => {
    const e = { ...event(0, 3, 1), _time: new Date(0) };
    const step = { processor: 'step0', phase: 'index-time', description: 'did something' };
    const shaped = {
      _raw: '0:xxx',
      _time: '1970-01-01T00:00:00.000Z',
      metadata,
      fields: {},
      indexedFields: {},
      lineNumbers: { start: 1, end: 1 },
    };
    const without = serializeSimulation(result([e]), [], { maxEvents: 20, includeSnapshots: false });
    expect(without.events).toStrictEqual([{ ...shaped, processingTrace: [step] }]);
    const withSnapshots = serializeSimulation(result([e]), [], { maxEvents: 20, includeSnapshots: true });
    const full = { ...step, inputSnapshot: '0:xxx', outputSnapshot: '0:xxx' };
    expect(withSnapshots.events).toStrictEqual([{ ...shaped, processingTrace: [full] }]);
  });

  it('says which limit cut the events, and what to change', () => {
    const events = Array.from({ length: 10 }, (_, i) => event(i, 1, 1));
    const byMaxEvents = serializeSimulation(result(events), [], { maxEvents: 2, includeSnapshots: false });
    expect(byMaxEvents.truncationNote).toBe(
      'Only the first 2 of 10 events are returned; raise max_events or use a smaller sample ' + 'to see the rest.',
    );
    const byCap = serializeSimulation(result([event(0, MAX_PAYLOAD_BYTES, 0)]), [], {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(byCap.truncationNote).toBe(
      `Only the first 0 of 1 events are returned: the response is capped at ${MAX_RESPONSE_BYTES} ` +
        'bytes. Use include_snapshots=false, a lower max_events or a smaller sample to see more ' +
        'of each event.',
    );
  });

  it('says how many diagnostics were cut', () => {
    const diagnostics: ValidationDiagnostic[] = Array.from({ length: 50_000 }, (_, i) => ({
      level: 'warning',
      message: `diagnostic ${i} ${'y'.repeat(100)}`,
      file: 'props.conf',
    }));
    const out = serializeSimulation(result([event(0, 10, 1)]), diagnostics, {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(out.truncationNote).toBe(
      `Only the first ${out.diagnostics.length} of 50000 diagnostics are returned, to keep the ` +
        'response under its size cap.',
    );
  });
});
