// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useTimestampMatch.test.tsx
// What the Timestamp tab is allowed to draw (#316) and how a prober failure is
// reported (#322). The worker is faked so a response can be held back: every
// bug here lives in the window between posting a request and its answer.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimestampMatch } from '../useTimestampMatch';
import type { TimeConfig, TimestampProbe } from '../../engine/timestampMatch';
import type { TimestampMatchRequest, TimestampMatchResponse } from '../../engine/timestampMatchWorker';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<TimestampMatchResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: TimestampMatchRequest[] = [];
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: TimestampMatchRequest) {
    this.posted.push(message);
  }
  terminate() {}
  respond(response: TimestampMatchResponse) {
    this.onmessage?.({ data: response } as MessageEvent<TimestampMatchResponse>);
  }
}

const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;
const lastPosted = () => worker().posted[worker().posted.length - 1]!;

const config = (overrides: Partial<TimeConfig> = {}): TimeConfig => ({
  timePrefix: null,
  timeFormat: '%Y-%m-%d',
  maxLookahead: 128,
  tz: null,
  ...overrides,
});

/** A probe whose offsets identify it, so a stale one is recognisable. */
const probeAt = (tsStart: number): TimestampProbe => ({
  match: {
    prefixStart: 0,
    prefixEnd: 0,
    lookaheadEnd: 20,
    tsStart,
    tsEnd: tsStart + 10,
    parsedTimeMs: 0,
    matchedText: 'x',
  },
  prefix: null,
});

describe('useTimestampMatch', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does not re-post for a config that is equal by value (#316)', () => {
    const raws = ['2026-01-01'];
    const { rerender } = renderHook(({ c }) => useTimestampMatch(raws, c), {
      initialProps: { c: config() },
    });
    expect(worker().posted).toHaveLength(1);
    // What the tab produces on a keystroke outside the time directives: a new
    // object with the same contents.
    rerender({ c: config() });
    expect(worker().posted).toHaveLength(1);
    rerender({ c: config({ timeFormat: '%Y' }) });
    expect(worker().posted).toHaveLength(2);
  });

  it("never returns one page's probes for another page (#316)", () => {
    const page1 = ['a 2026-01-01'];
    const page2 = ['different text'];
    const { result, rerender } = renderHook(({ raws }) => useTimestampMatch(raws, config()), {
      initialProps: { raws: page1 },
    });
    act(() => worker().respond({ id: lastPosted().id, probes: [probeAt(2)] }));
    expect(result.current.status).toBe('ok');
    expect(result.current.probes).toEqual([probeAt(2)]);

    rerender({ raws: page2 });
    expect(result.current.status).toBe('pending');
    expect(result.current.probes).toEqual([]);

    act(() => worker().respond({ id: lastPosted().id, probes: [{ match: null, prefix: null }] }));
    expect(result.current.status).toBe('ok');
    expect(result.current.probes).toEqual([{ match: null, prefix: null }]);
  });

  it('keeps the same page\'s probes, marked pending, while a new config is matched', () => {
    const raws = ['a 2026-01-01'];
    const { result, rerender } = renderHook(({ c }) => useTimestampMatch(raws, c), {
      initialProps: { c: config() },
    });
    act(() => worker().respond({ id: lastPosted().id, probes: [probeAt(2)] }));
    rerender({ c: config({ timeFormat: '%Y' }) });
    expect(result.current.status).toBe('pending');
    expect(result.current.probes).toEqual([probeAt(2)]);
  });

  it('reports a prober throw as an error with its message, not a timeout (#322)', () => {
    const raws = ['x'];
    const { result } = renderHook(() => useTimestampMatch(raws, config()));
    act(() => worker().respond({ id: lastPosted().id, probes: [], error: 'prober exploded' }));
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('prober exploded');
    expect(result.current.probes).toEqual([]);
  });
});
