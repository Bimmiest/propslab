import { describe, expect, it } from 'vitest';
import type {
  ProcessingResult,
  SplunkEvent,
  ValidationDiagnostic,
} from '../../../../src/engine/types';
import { MAX_RESPONSE_CHARS, serializeSimulation } from '../serialize';

// #351: everything in a simulate response that grows with the sample is bounded.

const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function event(i: number, rawChars: number, steps: number): SplunkEvent {
  const raw = `${i}:${'x'.repeat(rawChars)}`;
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata,
    lineNumbers: { start: i + 1, end: i + 1 },
    processingTrace: Array.from({ length: steps }, (_, s) => ({
      processor: `step${s}`,
      phase: 'index-time' as const,
      description: 'did something',
      inputSnapshot: raw,
      outputSnapshot: raw,
    })),
  };
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

const size = (v: unknown) => JSON.stringify(v, null, 2).length;

describe('serializeSimulation', () => {
  it('bounds processingSteps to the returned events', () => {
    const events = Array.from({ length: 10_000 }, (_, i) => event(i, 1, 3));
    const out = serializeSimulation(result(events), [], { maxEvents: 2, includeSnapshots: false });
    expect(out.eventCount).toBe(10_000);
    expect(out.returnedEvents).toBe(2);
    expect(out.processingSteps).toHaveLength(6);
    expect(out.truncationNote).toMatch(/max_events/);
    expect(out.truncationNote).toMatch(/processingSteps covers the returned events only/);
    expect(size(out)).toBeLessThan(5_000);
  });

  it('returns fewer events than max_events when they would exceed the size cap, and says so', () => {
    // 500 events of ~20k characters, each step carrying two snapshots of it:
    // far past the cap with snapshots, well inside it without.
    const events = Array.from({ length: 500 }, (_, i) => event(i, 20_000, 2));
    const out = serializeSimulation(result(events), [], { maxEvents: 500, includeSnapshots: true });
    expect(size(out)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
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
    const out = serializeSimulation(result([event(0, MAX_RESPONSE_CHARS, 0)]), [], {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(out.returnedEvents).toBe(0);
    expect(out.eventCount).toBe(1);
    expect(out.truncationNote).toMatch(/capped at/);
    expect(size(out)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
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
    expect(size(out)).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    expect(out.diagnostics.length).toBeLessThan(50_000);
    expect(out.diagnosticCount).toBe(50_000);
    expect(out.truncationNote).toMatch(/diagnostics/);
    // Diagnostics take at most half the budget; the event still fits.
    expect(out.returnedEvents).toBe(1);
  });

  it('adds nothing when nothing was cut', () => {
    const out = serializeSimulation(result([event(0, 10, 1)]), [], {
      maxEvents: 20,
      includeSnapshots: false,
    });
    expect(out).not.toHaveProperty('truncationNote');
    expect(out).not.toHaveProperty('diagnosticCount');
    expect(out.processingSteps).toHaveLength(1);
  });
});
