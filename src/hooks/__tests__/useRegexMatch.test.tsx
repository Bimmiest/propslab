// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useRegexMatch.test.tsx
// Results are tagged with what produced them.
//
// The request is posted from an effect, so the commit in which the caller's
// pattern or inputs change still carries the previous request's results. The
// pattern tag and the inputs tag let the Regex tab index results against the
// pattern and events they were matched over rather than whatever `allEvents`
// has become.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRegexMatch, type RegexMatchState } from '../useRegexMatch';
import { matchInputs } from '../../engine/regexMatch';
import type { RegexMatchRequest, RegexMatchResponse } from '../../engine/regexMatchWorker';
import { lastRequest, requestsIn } from '../../test/workerInputs';
import { isWorkerInputsMessage } from '../../engine/workerProtocol';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<RegexMatchResponse>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: unknown[] = [];

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: unknown) {
    this.posted.push(message);
  }
  terminate() {}
  /** Answer the latest request as the real worker would. */
  respond() {
    const { request: req, inputs } = lastRequest<RegexMatchRequest, string[]>(this.posted, (r) => r.inputs);
    this.onmessage?.({ data: { id: req.id, results: matchInputs(req.pattern, inputs) } } as MessageEvent<RegexMatchResponse>);
  }
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

const first = ['a1', 'b2', 'c'];
const second = ['x', 'y', 'z9', 'a1'];

function setup() {
  const renders: RegexMatchState[] = [];
  const hook = renderHook(
    ({ pattern, inputs }: { pattern: string; inputs: string[] }) => {
      const state = useRegexMatch(pattern, inputs);
      renders.push(state);
      return state;
    },
    { initialProps: { pattern: '\\d', inputs: first } },
  );
  act(() => { vi.advanceTimersByTime(250); });
  act(() => { latest().respond(); });
  return { ...hook, renders };
}

describe('useRegexMatch — results carry their inputs (#329)', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports the inputs array an ok result was matched over', () => {
    const { result } = setup();
    expect(result.current.status).toBe('ok');
    expect(result.current.inputs).toBe(first);
    expect(result.current.results.map((r) => r?.match ?? null)).toEqual(['1', '2', null]);
  });

  it('never pairs results with inputs they were not matched over', () => {
    const { rerender, renders } = setup();
    renders.length = 0;

    rerender({ pattern: '\\d', inputs: second });
    for (const r of renders) {
      // Whatever it reports, `results` index `inputs`: the first commit after the
      // change still describes `first`, and says so.
      if (r.status === 'ok') {
        expect(r.inputs).toBe(first);
        expect(r.results).toHaveLength(first.length);
      } else {
        expect(r.results).toHaveLength(0);
      }
    }
  });

  it('keeps the last settled outcome, with its inputs, while a re-run is pending', () => {
    const { result, rerender } = setup();

    rerender({ pattern: '\\d', inputs: second });
    expect(result.current.status).toBe('pending');
    expect(result.current.settled?.pattern).toBe('\\d');
    expect(result.current.settled?.inputs).toBe(first);
    expect(result.current.settled?.results).toHaveLength(first.length);

    act(() => { latest().respond(); });
    expect(result.current.status).toBe('ok');
    expect(result.current.inputs).toBe(second);
    expect(result.current.settled?.inputs).toBe(second);
    expect(result.current.results.map((r) => r?.match ?? null)).toEqual([null, null, '9', '1']);
  });

  it('drops the settled outcome once a request times out', () => {
    const { result, rerender } = setup();
    rerender({ pattern: '\\d', inputs: second });
    act(() => { vi.advanceTimersByTime(2_000); });
    expect(result.current.status).toBe('timeout');
    expect(result.current.settled).toBeNull();
  });
});

// The events used to be cloned into the worker with every debounced pattern
// (about 10 MB a keystroke at 20k events). They go once per set now.
describe('useRegexMatch — posts the events once per set (#496)', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends a pattern per change, and the inputs only when they change', () => {
    const { rerender } = setup();
    for (const pattern of ['\\d+', '[a-z]\\d', 'a']) {
      rerender({ pattern, inputs: first });
      act(() => { vi.advanceTimersByTime(250); });
    }
    const posted = latest().posted;
    const inputsMessages = posted.filter(isWorkerInputsMessage);
    expect(inputsMessages).toEqual([{ type: 'inputs', inputsId: 1, inputs: first }]);
    const requests = requestsIn<RegexMatchRequest>(posted);
    expect(requests.map((r) => r.pattern)).toEqual(['\\d', '\\d+', '[a-z]\\d', 'a']);
    for (const r of requests) {
      expect(r.inputs).toBeUndefined();
      expect(r.latestOnly).toBe(true);
    }

    rerender({ pattern: 'a', inputs: second });
    expect(latest().posted.filter(isWorkerInputsMessage)).toHaveLength(2);
  });
});
