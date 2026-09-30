// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useWorkerRequest.test.tsx
// The lifecycle both live-matching hooks share.
//
// Staleness and teardown are the parts worth pinning, because both fail
// silently — a stale response renders results for a pattern the user has
// already changed, and a leaked worker only shows up as drift under a profiler.
//
// Restart bounds too: a worker whose script never loads fails through an
// `error` event rather than a throw, and must not be recreated forever. Only
// load failures count toward that bound: counting crashes would send the hook
// inline for good after two crashing patterns, losing the watchdog.
//
// A load failure is any error before the worker's ready signal, so the fake
// loads before it responds or crashes, and `throwOnLoad` is a module that
// throws while evaluating — which, on the first worker, must not be reported
// as the first request timing out.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkerRequest } from '../useWorkerRequest';

interface Req {
  value: string;
}
interface Res {
  id: number;
  echo: string;
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<Res>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: (Req & { id: number })[] = [];
  terminated = false;
  loaded = false;

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Req & { id: number }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** The module finished evaluating: what every worker entry posts first. */
  ready() {
    if (this.loaded) return;
    this.loaded = true;
    this.onmessage?.({ data: { type: 'ready' } } as unknown as MessageEvent<Res>);
  }
  /** What the browser fires when the script cannot be fetched: a plain Event, no message. */
  failToLoad() {
    this.onerror?.(new Event('error') as ErrorEvent);
  }
  /** A module that throws while evaluating: an ErrorEvent with a message, before ready. */
  throwOnLoad() {
    this.onerror?.({ message: 'SyntaxError' } as ErrorEvent);
  }
  /** An exception thrown by worker code that did run: the module loaded first. */
  crash() {
    this.ready();
    this.onerror?.({ message: 'boom' } as ErrorEvent);
  }
  /** Deliver a response as the real worker would. */
  respond(id: number, echo: string) {
    this.ready();
    this.onmessage?.({ data: { id, echo } } as MessageEvent<Res>);
  }
}

function setup() {
  return renderHook(() =>
    useWorkerRequest<Req, Res, string>({
      createWorker: () => new FakeWorker() as unknown as Worker,
      timeoutMs: 1000,
      empty: '',
      interpret: (response) =>
        response.echo === 'bad' ? { status: 'invalid', data: '' } : { status: 'ok', data: response.echo },
      runInline: (request) => ({ status: 'ok', data: `inline:${request.value}` }),
      isIdle: (request) => request.value === '',
    }),
  );
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

describe('useWorkerRequest', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('starts idle and posts nothing', () => {
    const { result } = setup();
    expect(result.current.status).toBe('idle');
    expect(latest().posted).toEqual([]);
  });

  it('reports pending, then the interpreted response', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    expect(result.current.status).toBe('pending');

    act(() => latest().respond(1, 'A'));
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('A');
  });

  it('assigns the request id itself, monotonically', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => result.current.run({ value: 'b' }));
    expect(latest().posted.map((p) => p.id)).toEqual([1, 2]);
  });

  it('discards a response to a superseded request', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'first' }));
    act(() => result.current.run({ value: 'second' }));

    // The first request answers late — it must not overwrite the second.
    act(() => latest().respond(1, 'STALE'));
    expect(result.current.status).toBe('pending');

    act(() => latest().respond(2, 'FRESH'));
    expect(result.current.data).toBe('FRESH');
  });

  it('goes idle without posting when there is nothing to do', () => {
    const { result } = setup();
    act(() => result.current.run({ value: '' }));
    expect(result.current.status).toBe('idle');
    expect(latest().posted).toEqual([]);
  });

  it('does not let a response to the request before an idle one overwrite idle', () => {
    // Going idle bumps the id, so request 1's late answer is stale and does not
    // replace idle.
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => result.current.run({ value: '' }));
    expect(result.current.status).toBe('idle');

    act(() => latest().respond(1, 'STALE'));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBe('');
  });

  it('reaps a request superseded by an idle one without reporting it', () => {
    // The worker is still busy with the superseded request, so a hang
    // must still free it for the next one, but nobody is waiting on it.
    const { result } = setup();
    const first = latest();
    act(() => result.current.run({ value: 'slow' }));
    act(() => first.ready());
    act(() => result.current.run({ value: '' }));

    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.status).toBe('idle');
    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('times a request from when the worker reaches it, not from its post (#364)', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => latest().ready());
    act(() => void vi.advanceTimersByTime(700));
    act(() => result.current.run({ value: 'b' }));
    // `a` finishes just inside its own budget; `b` then gets a full one.
    act(() => void vi.advanceTimersByTime(250));
    act(() => latest().respond(1, 'A'));
    act(() => void vi.advanceTimersByTime(900));
    expect(result.current.status).toBe('pending');
    act(() => latest().respond(2, 'B'));
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('B');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it('waits for a slow worker to load, through new requests, and times the run alone (#420)', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    const slow = latest();
    // Typing while the worker loads must neither time out nor restart it.
    act(() => void vi.advanceTimersByTime(1500));
    act(() => result.current.run({ value: 'ab' }));
    act(() => void vi.advanceTimersByTime(1500));
    act(() => result.current.run({ value: 'abc' }));
    act(() => void vi.advanceTimersByTime(2000));
    expect(slow.terminated).toBe(false);
    expect(FakeWorker.instances).toHaveLength(1);
    expect(result.current.status).toBe('pending');

    act(() => slow.ready());
    act(() => slow.respond(1, 'A'));
    act(() => slow.respond(2, 'AB'));
    act(() => void vi.advanceTimersByTime(999));
    act(() => slow.respond(3, 'ABC'));
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('ABC');
  });

  it('runs inline a request whose workers never load', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => void vi.advanceTimersByTime(1000));
    act(() => latest().failToLoad());
    act(() => latest().failToLoad());
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('inline:a');
  });

  it('returns the same run across renders', () => {
    // Callers list `run` as an effect dependency; a new identity per render
    // would re-post on every render of the caller.
    const { result, rerender } = setup();
    const first = result.current.run;
    rerender();
    act(() => result.current.run({ value: 'a' }));
    act(() => latest().respond(1, 'A'));
    expect(result.current.run).toBe(first);
  });

  it('clears data on an invalid response rather than keeping the last good one', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => latest().respond(1, 'A'));
    act(() => result.current.run({ value: 'b' }));
    act(() => latest().respond(2, 'bad'));

    expect(result.current.status).toBe('invalid');
    expect(result.current.data).toBe('');
  });

  it('terminates and replaces the worker when the watchdog fires', () => {
    const { result } = setup();
    const first = latest();
    act(() => result.current.run({ value: 'slow' }));
    act(() => first.ready());

    act(() => void vi.advanceTimersByTime(1000));

    expect(result.current.status).toBe('timeout');
    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('cancels the watchdog when a response arrives in time', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => latest().respond(1, 'A'));

    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.status).toBe('ok');
  });

  it('restarts and reports a crash the way it reports a timeout', () => {
    const { result } = setup();
    const first = latest();
    act(() => result.current.run({ value: 'a' }));

    act(() => first.crash());

    expect(result.current.status).toBe('timeout');
    expect(first.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('does not report a crash of a superseded request against the valid edit that replaced it (#491)', () => {
    const { result } = setup();
    const first = latest();
    act(() => result.current.run({ value: 'crashy' }));
    act(() => first.ready());
    act(() => result.current.run({ value: 'valid' }));

    act(() => first.crash());

    // Not "too slow": the valid pattern is re-run on the replacement.
    expect(result.current.status).toBe('pending');
    expect(FakeWorker.instances).toHaveLength(2);
    expect(latest().posted).toEqual([{ value: 'valid', id: 2 }]);
    act(() => latest().respond(2, 'V'));
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('V');
  });

  it('terminates the worker on unmount', () => {
    const { unmount } = setup();
    const worker = latest();
    unmount();
    expect(worker.terminated).toBe(true);
  });

  it('falls back to running inline where there is no Worker', () => {
    vi.stubGlobal('Worker', undefined);
    const { result } = setup();
    act(() => result.current.run({ value: 'x' }));
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('inline:x');
  });

  it('falls back to running inline when construction throws', () => {
    const { result } = renderHook(() =>
      useWorkerRequest<Req, Res, string>({
        createWorker: () => {
          throw new Error('blocked by CSP');
        },
        timeoutMs: 1000,
        empty: '',
        interpret: () => ({ status: 'ok', data: 'unused' }),
        runInline: (request) => ({ status: 'ok', data: `inline:${request.value}` }),
        isIdle: () => false,
      }),
    );

    act(() => result.current.run({ value: 'x' }));
    expect(result.current.data).toBe('inline:x');
  });
  it('stops recreating a worker whose script never loads, and runs inline (#309)', () => {
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));

    act(() => latest().failToLoad());
    // One replacement, with the in-flight request resent rather than reported.
    expect(FakeWorker.instances).toHaveLength(2);
    expect(latest().posted).toEqual([{ value: 'a', id: 1 }]);
    expect(result.current.status).toBe('pending');

    act(() => latest().failToLoad());
    expect(FakeWorker.instances).toHaveLength(2); // capped
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('inline:a');

    act(() => result.current.run({ value: 'b' }));
    expect(result.current.data).toBe('inline:b');
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('does not report a timeout for an error with no request in flight (#309)', () => {
    const { result } = setup();
    act(() => latest().failToLoad());
    expect(result.current.status).toBe('idle');
    expect(FakeWorker.instances).toHaveLength(2);

    act(() => result.current.run({ value: 'a' }));
    act(() => latest().respond(1, 'A'));
    act(() => latest().crash());
    expect(result.current.status).toBe('ok');
    expect(result.current.data).toBe('A');
  });

  it('keeps restarting a worker that has answered before, however often it crashes', () => {
    // The cap counts only workers that never loaded; one that loaded and later
    // crashes resets it, so a long session is never pushed inline. A worker
    // that dies with nothing in flight is replaced when next needed rather
    // than at once, so each crash costs one construction, not two.
    const { result } = setup();
    for (let i = 1; i <= 4; i++) {
      act(() => result.current.run({ value: 'a' }));
      expect(latest().posted.at(-1)).toEqual({ value: 'a', id: i });
      act(() => latest().respond(i, 'A'));
      expect(result.current.data).toBe('A');
      act(() => latest().crash());
    }
    expect(FakeWorker.instances).toHaveLength(4);
  });
  it('keeps using workers however many requests in a row crash them (#326)', () => {
    // A replacement's crash is not a start failure even though it had not
    // answered yet, so repeated crashes never hit the cap and send later
    // patterns inline on the tab's thread, with no watchdog.
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => latest().respond(1, 'A'));

    for (const value of ['boom1', 'boom2', 'boom3']) {
      act(() => result.current.run({ value }));
      act(() => latest().crash());
      expect(result.current.status).toBe('timeout');
    }
    expect(FakeWorker.instances).toHaveLength(4);

    // The crashing pattern again: posted to a worker, under the watchdog, not
    // run inline.
    act(() => result.current.run({ value: 'boom3' }));
    expect(result.current.status).toBe('pending');
    expect(latest().posted).toEqual([{ value: 'boom3', id: 5 }]);
    act(() => latest().ready());
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.status).toBe('timeout');
    expect(FakeWorker.instances).toHaveLength(5);
  });

  it('never runs a request inline after two workers in a row crashed on it (#326)', () => {
    // Two crashing requests from a fresh start are not enough on their own.
    const { result } = setup();
    for (let i = 1; i <= 3; i++) {
      act(() => result.current.run({ value: 'boom' }));
      act(() => latest().crash());
      expect(result.current.status).toBe('timeout');
      expect(result.current.data).toBe('');
    }
    expect(FakeWorker.instances).toHaveLength(4);
  });

  it('stops rebuilding a worker whose script throws before it is given anything (#326)', () => {
    // Crashes do not count toward the cap, but a worker that dies without ever
    // being handed a request died of its own script, and would otherwise be
    // rebuilt for as long as the tab is open.
    setup();
    act(() => latest().throwOnLoad());
    act(() => latest().throwOnLoad());
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });

  describe('a worker whose script throws at top level (#339)', () => {
    it('is a load failure for the first request: resent, then run inline at the cap', () => {
      // The request is posted before the script has run, so the top-level throw
      // is not charged to it as a timeout.
      const { result } = setup();
      act(() => result.current.run({ value: 'a' }));

      act(() => latest().throwOnLoad());
      expect(result.current.status).toBe('pending');
      expect(FakeWorker.instances).toHaveLength(2);
      expect(latest().posted).toEqual([{ value: 'a', id: 1 }]);

      act(() => latest().throwOnLoad());
      expect(FakeWorker.instances).toHaveLength(2); // capped
      expect(result.current.status).toBe('ok');
      expect(result.current.data).toBe('inline:a');

      act(() => result.current.run({ value: 'b' }));
      expect(result.current.data).toBe('inline:b');
      expect(FakeWorker.instances).toHaveLength(2);
    });

    it('is a crash once the worker has loaded, whatever the error carries', () => {
      const { result } = setup();
      act(() => result.current.run({ value: 'a' }));
      act(() => latest().ready());
      act(() => latest().failToLoad()); // a plain Event, but after ready
      expect(result.current.status).toBe('timeout');
      expect(FakeWorker.instances).toHaveLength(2);
      expect(latest().posted).toEqual([]);
    });

    it('resets the load-failure count when a worker loads', () => {
      // "In a row": a worker that loaded in between clears the count.
      const { result } = setup();
      act(() => latest().throwOnLoad());
      act(() => latest().ready());
      act(() => result.current.run({ value: 'a' }));
      act(() => latest().crash());
      act(() => latest().throwOnLoad());
      expect(FakeWorker.instances).toHaveLength(4);
      act(() => result.current.run({ value: 'b' }));
      expect(result.current.status).toBe('pending');
      expect(latest().posted).toEqual([{ value: 'b', id: 2 }]);
    });
  });

  describe('sendAhead and latestOnly (#496)', () => {
    interface Big {
      key: string;
      inputs: string[];
    }
    function setupBig() {
      const interpreted: Big[] = [];
      const hook = renderHook(() =>
        useWorkerRequest<Big, Res, string>({
          createWorker: () => new FakeWorker() as unknown as Worker,
          timeoutMs: 1000,
          empty: '',
          interpret: (response, request) => {
            interpreted.push(request);
            return { status: 'ok', data: `${response.echo}:${request.key}` };
          },
          runInline: (request) => ({ status: 'ok', data: `inline:${request.key}` }),
          isIdle: (request) => request.key === '',
          sendAhead: { inputs: (r) => r.inputs, rest: ({ key }) => ({ key }) },
          latestOnly: true,
        }),
      );
      return { ...hook, interpreted };
    }

    it('sends each set of inputs once, and requests that name them', () => {
      const { result } = setupBig();
      const one = ['a', 'b'];
      const two = ['c'];
      act(() => result.current.run({ key: 'k1', inputs: one }));
      act(() => result.current.run({ key: 'k2', inputs: one }));
      act(() => result.current.run({ key: 'k3', inputs: two }));
      expect(latest().posted as unknown[]).toEqual([
        { type: 'inputs', inputsId: 1, inputs: one },
        { key: 'k1', inputsId: 1, id: 1, latestOnly: true },
        { key: 'k2', inputsId: 1, id: 2, latestOnly: true },
        { type: 'inputs', inputsId: 2, inputs: two },
        { key: 'k3', inputsId: 2, id: 3, latestOnly: true },
      ]);
    });

    it('hands interpret the request the response answers, inputs and all', () => {
      const { result, interpreted } = setupBig();
      const inputs = ['a'];
      act(() => result.current.run({ key: 'k1', inputs }));
      act(() => latest().respond(1, 'A'));
      expect(result.current.data).toBe('A:k1');
      expect(interpreted[0]).toEqual({ key: 'k1', inputs });
      expect(interpreted[0]!.inputs).toBe(inputs);
    });

    it('ignores a skipped answer', () => {
      const { result } = setupBig();
      act(() => result.current.run({ key: 'k1', inputs: ['a'] }));
      act(() => {
        latest().ready();
        latest().onmessage?.({ data: { id: 1, skipped: true } } as unknown as MessageEvent<Res>);
      });
      expect(result.current.status).toBe('pending');
    });
  });
});
