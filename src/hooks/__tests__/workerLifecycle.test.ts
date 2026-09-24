// ---------------------------------------------------------------------------
// workerLifecycle.test.ts
// The lifecycle the pipeline, the live-matching hooks and the TIME_FORMAT
// hover share (#339). Each caller's policy is tested with the caller; these
// pin what the lifecycle itself reports, so the three cannot drift apart again.
//
// The rule at the centre: an error before the worker's ready signal is a load
// failure, after it a crash — by ready, not by whether work had been posted,
// because the first request is posted before the script has even run.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManagedWorker, MAX_WORKER_LOAD_FAILURES, type ManagedWorkerConfig } from '../workerLifecycle';
import { WORKER_READY, isWorkerReadyMessage } from '../../engine/workerProtocol';

interface Req { id: number; value: string }
interface Res { id: number; echo: string }

class FakeWorker {
  static instances: FakeWorker[] = [];
  static throwOnConstruct = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  posted: Req[] = [];
  terminated = false;

  constructor() {
    if (FakeWorker.throwOnConstruct) throw new Error('blocked by CSP');
    FakeWorker.instances.push(this);
  }
  postMessage(message: Req) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  ready() {
    this.onmessage?.({ data: WORKER_READY } as MessageEvent);
  }
  respond(id: number, echo = 'ok') {
    this.onmessage?.({ data: { id, echo } } as MessageEvent);
  }
  /** An ErrorEvent-shaped error, as an uncaught throw produces. */
  throw(message = 'boom') {
    this.onerror?.({ message } as ErrorEvent);
  }
  /** A plain Event, as a failed fetch produces. */
  failFetch() {
    this.onerror?.(new Event('error'));
  }
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

function setup(overrides: Partial<ManagedWorkerConfig<Req, Res>> = {}) {
  const calls = {
    response: vi.fn<(res: Res, req: Req) => void>(),
    timeout: vi.fn<(req: Req, others: Req[], loaded: boolean) => void>(),
    crash: vi.fn<(inFlight: Req[], message: string) => void>(),
    load: vi.fn<(inFlight: Req[], capped: boolean) => void>(),
  };
  const managed = createManagedWorker<Req, Res>({
    create: () => new FakeWorker() as unknown as Worker,
    timeoutMs: 1000,
    onResponse: calls.response,
    onTimeout: calls.timeout,
    onCrash: calls.crash,
    onLoadFailure: calls.load,
    ...overrides,
  });
  return { managed, calls };
}

const req = (id: number, value = `r${id}`): Req => ({ id, value });

describe('createManagedWorker (#339)', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.throwOnConstruct = false;
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('construction', () => {
    it('builds lazily, once', () => {
      const { managed } = setup();
      expect(FakeWorker.instances).toHaveLength(0);
      expect(managed.ensure()).toBe(true);
      expect(managed.ensure()).toBe(true);
      expect(FakeWorker.instances).toHaveLength(1);
    });

    it('has no worker where there is no Worker global, and counts nothing', () => {
      vi.stubGlobal('Worker', undefined);
      const { managed } = setup();
      expect(managed.post(req(1))).toBe(false);
      vi.stubGlobal('Worker', FakeWorker);
      expect(managed.post(req(2))).toBe(true);
    });

    it('counts a constructor that throws as a load failure, up to the cap', () => {
      let attempts = 0;
      const { managed } = setup({
        create: () => {
          attempts++;
          throw new Error('blocked by CSP');
        },
      });
      for (let i = 0; i < 5; i++) expect(managed.post(req(i))).toBe(false);
      expect(attempts).toBe(MAX_WORKER_LOAD_FAILURES);
    });
  });

  describe('responses', () => {
    it('delivers a response with the request it answers, once', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      latest().respond(1, 'A');
      latest().respond(1, 'again');
      expect(calls.response).toHaveBeenCalledTimes(1);
      expect(calls.response).toHaveBeenCalledWith({ id: 1, echo: 'A' }, req(1));
    });

    it('never mistakes the ready signal for a response', () => {
      expect(isWorkerReadyMessage(WORKER_READY)).toBe(true);
      expect(isWorkerReadyMessage({ id: 1 })).toBe(false);
      expect(isWorkerReadyMessage(null)).toBe(false);
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      expect(calls.response).not.toHaveBeenCalled();
    });

    it('drops answers to forgotten requests, and their watchdogs with them', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      managed.forget();
      managed.post(req(2));
      latest().respond(1);
      expect(calls.response).not.toHaveBeenCalled();
      vi.advanceTimersByTime(999);
      latest().respond(2);
      vi.advanceTimersByTime(5000);
      expect(calls.timeout).not.toHaveBeenCalled();
      expect(calls.response).toHaveBeenCalledTimes(1);
    });
  });

  describe('classification', () => {
    it('calls a throw before ready a load failure, although work had been posted', () => {
      // The case every caller got wrong: the request is posted before the
      // script has run, and the script throws at top level.
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().throw('SyntaxError');
      expect(calls.crash).not.toHaveBeenCalled();
      expect(calls.load).toHaveBeenCalledWith([req(1)], false);
    });

    it('calls a plain-Event error before ready a load failure', () => {
      const { managed, calls } = setup();
      managed.ensure();
      latest().failFetch();
      expect(calls.load).toHaveBeenCalledWith([], false);
    });

    it('calls any error after ready a crash, and passes its message', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      latest().failFetch();
      expect(calls.crash).toHaveBeenCalledWith([req(1)], '');
      managed.post(req(2));
      latest().ready();
      latest().throw('out of memory');
      expect(calls.crash).toHaveBeenLastCalledWith([req(2)], 'out of memory');
      expect(calls.load).not.toHaveBeenCalled();
    });

    it('takes a response as proof of loading even without the ready signal', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().respond(1);
      managed.post(req(2));
      latest().throw();
      expect(calls.crash).toHaveBeenCalledWith([req(2)], 'boom');
    });

    it('ignores events from a worker it has already replaced', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const first = latest();
      first.ready();
      first.throw();
      first.throw();
      first.respond(1);
      expect(calls.crash).toHaveBeenCalledTimes(1);
      expect(calls.response).not.toHaveBeenCalled();
    });
  });

  describe('load-failure cap', () => {
    it('rebuilds after a load failure until the cap, then builds nothing', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().throw();
      expect(FakeWorker.instances).toHaveLength(2);
      expect(managed.post(req(1))).toBe(true);
      latest().failFetch();
      expect(calls.load).toHaveBeenLastCalledWith([req(1)], true);
      expect(FakeWorker.instances).toHaveLength(2);
      expect(managed.post(req(2))).toBe(false);
      expect(managed.ensure()).toBe(false);
    });

    it('never counts crashes', () => {
      const { managed, calls } = setup();
      for (let i = 1; i <= 5; i++) {
        managed.post(req(i));
        latest().ready();
        latest().throw();
      }
      expect(calls.crash).toHaveBeenCalledTimes(5);
      expect(managed.post(req(6))).toBe(true);
    });

    it('counts failures in a row: a worker that loads resets the count', () => {
      const { managed } = setup();
      managed.ensure();
      latest().failFetch();
      latest().ready();
      managed.post(req(1));
      latest().throw(); // a crash: replaced, not counted
      latest().failFetch();
      expect(managed.post(req(2))).toBe(true);
    });

    it('is reset by dispose', () => {
      const { managed } = setup();
      managed.ensure();
      latest().failFetch();
      latest().failFetch();
      expect(managed.ensure()).toBe(false);
      managed.dispose();
      expect(managed.ensure()).toBe(true);
    });
  });

  describe('crashes', () => {
    it('hands back everything in flight, oldest first, on a fresh worker', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      managed.post(req(2));
      const crashed = latest();
      crashed.ready();
      crashed.throw();
      expect(crashed.terminated).toBe(true);
      expect(calls.crash).toHaveBeenCalledWith([req(1), req(2)], 'boom');
      expect(FakeWorker.instances).toHaveLength(2);
      // Handed back means untracked: no watchdog is left for them.
      vi.advanceTimersByTime(5000);
      expect(calls.timeout).not.toHaveBeenCalled();
    });

    it('replaces a worker that died with nothing in flight only when next needed', () => {
      // An entry that posts ready and then dies on its own would otherwise be
      // rebuilt in a loop for as long as the tab is open.
      const { managed, calls } = setup();
      managed.ensure();
      latest().ready();
      latest().throw();
      expect(calls.crash).toHaveBeenCalledWith([], 'boom');
      expect(FakeWorker.instances).toHaveLength(1);
      expect(managed.post(req(1))).toBe(true);
      expect(FakeWorker.instances).toHaveLength(2);
    });
  });

  describe('watchdog', () => {
    it('terminates and replaces a worker that overruns, and says whether it had loaded', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const hung = latest();
      vi.advanceTimersByTime(1000);
      expect(hung.terminated).toBe(true);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], false);
      expect(FakeWorker.instances).toHaveLength(2);

      managed.post(req(2));
      latest().ready();
      vi.advanceTimersByTime(1000);
      expect(calls.timeout).toHaveBeenLastCalledWith(req(2), [], true);
    });

    it('hands back the requests queued behind the one that hung, untracked', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      vi.advanceTimersByTime(500);
      managed.post(req(2));
      vi.advanceTimersByTime(500);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [req(2)], false);
      vi.advanceTimersByTime(1000);
      expect(calls.timeout).toHaveBeenCalledTimes(1);
    });

    it('does not count a timeout toward the cap', () => {
      const { managed } = setup();
      for (let i = 1; i <= 4; i++) {
        managed.post(req(i));
        vi.advanceTimersByTime(1000);
      }
      expect(managed.post(req(5))).toBe(true);
    });

    it('gives a request posted again a fresh budget', () => {
      const { managed, calls } = setup({
        onLoadFailure: (inFlight) => {
          for (const r of inFlight) managed.post(r);
        },
      });
      managed.post(req(1));
      vi.advanceTimersByTime(900);
      latest().failFetch();
      vi.advanceTimersByTime(900);
      expect(calls.timeout).not.toHaveBeenCalled();
      expect(latest().posted).toEqual([req(1)]);
      vi.advanceTimersByTime(100);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], false);
    });

    it('reads the budget at each post', () => {
      // useWorkerRequest passes a getter over its latest config.
      let budget = 1000;
      const onTimeout = vi.fn();
      const managed = createManagedWorker<Req, Res>({
        create: () => new FakeWorker() as unknown as Worker,
        get timeoutMs() {
          return budget;
        },
        onResponse: () => {},
        onTimeout,
        onCrash: () => {},
        onLoadFailure: () => {},
      });
      budget = 3000;
      managed.post(req(1));
      vi.advanceTimersByTime(2999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalled();
    });
  });

  it('dispose terminates the worker and forgets everything', () => {
    const { managed, calls } = setup();
    managed.post(req(1));
    const w = latest();
    managed.dispose();
    expect(w.terminated).toBe(true);
    vi.advanceTimersByTime(5000);
    w.respond(1);
    expect(calls.timeout).not.toHaveBeenCalled();
    expect(calls.response).not.toHaveBeenCalled();
  });
});
