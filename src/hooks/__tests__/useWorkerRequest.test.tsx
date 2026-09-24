// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useWorkerRequest.test.tsx
// The lifecycle both live-matching hooks now share (#151).
//
// Staleness and teardown are the parts worth pinning: both were reimplemented
// per hook, and both fail silently — a stale response renders results for a
// pattern the user has already changed, and a leaked worker only shows up as
// drift under a profiler.
//
// Restart bounds too (#309): a worker whose script never loads fails through
// an `error` event rather than a throw, and used to be recreated forever.
// Only load failures count toward that bound (#326): counting crashes too sent
// the hook inline for good after two crashing patterns, losing the watchdog.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useWorkerRequest } from '../useWorkerRequest';

interface Req { value: string }
interface Res { id: number; echo: string }

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<Res>) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: (Req & { id: number })[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: Req & { id: number }) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** What the browser fires when the script cannot be fetched: a plain Event, no message. */
  failToLoad() {
    this.onerror?.(new Event('error') as ErrorEvent);
  }
  /** An exception thrown by worker code that did run. */
  crash() {
    this.onerror?.({ message: 'boom' } as ErrorEvent);
  }
  /** Deliver a response as the real worker would. */
  respond(id: number, echo: string) {
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
    // #294: the idle branch returned before bumping the id, so request 1 was
    // still "current" and its late answer replaced idle with stale data.
    const { result } = setup();
    act(() => result.current.run({ value: 'a' }));
    act(() => result.current.run({ value: '' }));
    expect(result.current.status).toBe('idle');

    act(() => latest().respond(1, 'STALE'));
    expect(result.current.status).toBe('idle');
    expect(result.current.data).toBe('');
  });

  it('cancels the watchdog of a request superseded by an idle one', () => {
    const { result } = setup();
    const first = latest();
    act(() => result.current.run({ value: 'slow' }));
    act(() => result.current.run({ value: '' }));

    act(() => void vi.advanceTimersByTime(5000));
    expect(result.current.status).toBe('idle');
    expect(first.terminated).toBe(false);
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
    // The cap counts only workers that never answered; one that loaded and
    // later crashes resets it, so a long session is never pushed inline.
    const { result } = setup();
    for (let i = 1; i <= 4; i++) {
      act(() => result.current.run({ value: 'a' }));
      act(() => latest().respond(i, 'A'));
      act(() => latest().crash());
    }
    expect(FakeWorker.instances).toHaveLength(5);
  });
  it('keeps using workers however many requests in a row crash them (#326)', () => {
    // #309 counted each replacement's crash as a start failure — it had not
    // answered yet — so the second crash of a replacement hit the cap, no
    // worker was built, and every later pattern ran inline on the tab's thread
    // with no watchdog.
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
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current.status).toBe('timeout');
    expect(FakeWorker.instances).toHaveLength(5);
  });

  it('never runs a request inline after two workers in a row crashed on it (#326)', () => {
    // Two crashing requests from a fresh start used to be enough on their own.
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
    act(() => latest().crash());
    act(() => latest().crash());
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances.every((w) => w.terminated)).toBe(true);
  });
});
