// ---------------------------------------------------------------------------
// workerLifecycle.test.ts
// The lifecycle the pipeline, the live-matching hooks and the TIME_FORMAT
// hover share. Each caller's policy is tested with the caller; these pin what
// the lifecycle itself reports, so the three cannot drift apart.
//
// The rule at the centre: an error before the worker's ready signal is a load
// failure, after it a crash — by ready, not by whether work had been posted,
// because the first request is posted before the script has even run.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createManagedWorker, LOAD_WAIT_FACTOR, MAX_WORKER_LOAD_FAILURES, type ManagedWorkerConfig } from '../workerLifecycle';
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

    it('drops answers to forgotten requests', () => {
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
    it('terminates and replaces a worker that overruns', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const hung = latest();
      hung.ready();
      vi.advanceTimersByTime(1000);
      expect(hung.terminated).toBe(true);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], true);
      expect(FakeWorker.instances).toHaveLength(2);

      managed.post(req(2));
      latest().ready();
      vi.advanceTimersByTime(1000);
      expect(calls.timeout).toHaveBeenLastCalledWith(req(2), [], true);
    });

    it('does not start a request\'s budget until its worker has loaded (#420)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const slow = latest();
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR - 1);
      expect(slow.terminated).toBe(false);
      slow.ready();
      vi.advanceTimersByTime(999);
      expect(calls.timeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], true);
      expect(calls.load).not.toHaveBeenCalled();
    });

    it('does not restart a loading worker however many requests it is posted (#420)', () => {
      const { managed, calls } = setup({
        onLoadFailure: (inFlight, capped) => {
          calls.load(inFlight, capped);
          for (const r of inFlight) managed.post(r);
        },
      });
      // Typing on a slow link: each request supersedes the last, and none may
      // put a run budget on the download.
      managed.post(req(1));
      const loading = latest();
      for (let id = 2; id < LOAD_WAIT_FACTOR * 2; id++) {
        vi.advanceTimersByTime(450);
        managed.forget();
        managed.post(req(id));
      }
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR - 450 * (LOAD_WAIT_FACTOR * 2 - 2) - 1);
      expect(loading.terminated).toBe(false);
      expect(FakeWorker.instances).toHaveLength(1);
      expect(calls.timeout).not.toHaveBeenCalled();

      // The load timer bounds the wait, as a load failure, with the latest request.
      vi.advanceTimersByTime(1);
      expect(loading.terminated).toBe(true);
      expect(calls.load).toHaveBeenCalledWith([req(LOAD_WAIT_FACTOR * 2 - 1)], false);
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR);
      expect(calls.load).toHaveBeenLastCalledWith([req(LOAD_WAIT_FACTOR * 2 - 1)], true);
      expect(calls.timeout).not.toHaveBeenCalled();
    });

    it('hands back the requests queued behind the one that hung, untracked', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      vi.advanceTimersByTime(500);
      managed.post(req(2));
      vi.advanceTimersByTime(500);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [req(2)], true);
      vi.advanceTimersByTime(1000);
      expect(calls.timeout).toHaveBeenCalledTimes(1);
    });

    it('does not count a timeout toward the cap', () => {
      const { managed } = setup();
      for (let i = 1; i <= 4; i++) {
        managed.post(req(i));
        latest().ready();
        vi.advanceTimersByTime(1000);
      }
      expect(managed.post(req(5))).toBe(true);
    });

    it('gives a request posted again a fresh budget', () => {
      const { managed, calls } = setup({
        onCrash: (inFlight) => {
          for (const r of inFlight) managed.post(r);
        },
      });
      managed.post(req(1));
      latest().ready();
      vi.advanceTimersByTime(900);
      latest().throw();
      latest().ready();
      vi.advanceTimersByTime(900);
      expect(calls.timeout).not.toHaveBeenCalled();
      expect(latest().posted).toEqual([req(1)]);
      vi.advanceTimersByTime(100);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], true);
    });

    it('starts a queued request\'s budget when the one ahead is answered (#364)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      vi.advanceTimersByTime(600);
      managed.post(req(2));
      vi.advanceTimersByTime(300);
      latest().respond(1);
      vi.advanceTimersByTime(999);
      expect(calls.timeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(calls.timeout).toHaveBeenCalledWith(req(2), [], true);
    });

    it('keeps a forgotten request under its watchdog, and re-posts the newer ones unblamed when it hangs (#364)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const hung = latest();
      hung.ready();
      managed.forget();
      managed.post(req(2));
      vi.advanceTimersByTime(1000);
      expect(hung.terminated).toBe(true);
      expect(calls.timeout).not.toHaveBeenCalled();
      expect(latest().posted).toEqual([req(2)]);
      latest().respond(2);
      expect(calls.response).toHaveBeenCalledWith({ id: 2, echo: 'ok' }, req(2));
    });

    it('does not blame a newer request for a crash of the forgotten one it queued behind (#491)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const crashing = latest();
      crashing.ready();
      managed.forget();
      managed.post(req(2));
      crashing.throw('boom');
      expect(calls.crash).not.toHaveBeenCalled();
      expect(calls.load).not.toHaveBeenCalled();
      expect(crashing.terminated).toBe(true);
      expect(latest()).not.toBe(crashing);
      expect(latest().posted).toEqual([req(2)]);
      latest().ready();
      latest().respond(2);
      expect(calls.response).toHaveBeenCalledWith({ id: 2, echo: 'ok' }, req(2));
    });

    it('still blames the newer request when it is the one that crashes the replacement (#491)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      managed.forget();
      managed.post(req(2));
      latest().throw('first');
      latest().ready();
      latest().throw('second');
      expect(calls.crash).toHaveBeenCalledTimes(1);
      expect(calls.crash).toHaveBeenCalledWith([req(2)], 'second');
    });

    it('reports a crash with only forgotten requests in flight as nothing in flight (#491)', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      latest().ready();
      managed.forget();
      latest().throw('boom');
      expect(calls.crash).toHaveBeenCalledWith([], 'boom');
      expect(FakeWorker.instances).toHaveLength(1);
    });

    it('hands unposted newer requests to onLoadFailure when a crash of the forgotten one leaves no replacement (#491)', () => {
      let built = 0;
      const { managed, calls } = setup({
        create: () => {
          if (built++ > 0) throw new Error('blocked');
          return new FakeWorker() as unknown as Worker;
        },
      });
      managed.post(req(1));
      latest().ready();
      managed.forget();
      managed.post(req(2));
      latest().throw('boom');
      expect(calls.crash).not.toHaveBeenCalled();
      expect(calls.load).toHaveBeenCalledTimes(1);
      expect(calls.load.mock.calls[0]![0]).toEqual([req(2)]);
    });

    it('hands newer requests to onLoadFailure when no replacement can be built after a superseded hang', () => {
      let built = 0;
      const { managed, calls } = setup({
        create: () => {
          if (built++ > 0) throw new Error('blocked');
          return new FakeWorker() as unknown as Worker;
        },
      });
      managed.post(req(1));
      latest().ready();
      managed.forget();
      managed.post(req(2));
      vi.advanceTimersByTime(1000);
      expect(calls.load).toHaveBeenCalledTimes(1);
      expect(calls.load.mock.calls[0]![0]).toEqual([req(2)]);
    });

    it('reads the budget when a watchdog starts', () => {
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
      latest().ready();
      vi.advanceTimersByTime(2999);
      expect(onTimeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onTimeout).toHaveBeenCalled();
    });
  });

  describe('postWhenReady (#364)', () => {
    it('posts at once to a worker that has loaded', () => {
      const { managed } = setup();
      managed.ensure();
      latest().ready();
      expect(managed.postWhenReady(req(1))).toBe(true);
      expect(latest().posted).toEqual([req(1)]);
    });

    it('holds a request until the worker loads, then times its run alone', () => {
      const { managed, calls } = setup();
      managed.ensure();
      expect(managed.postWhenReady(req(1))).toBe(true);
      const replacement = latest();
      vi.advanceTimersByTime(5000);
      expect(replacement.posted).toEqual([]);
      replacement.ready();
      expect(replacement.posted).toEqual([req(1)]);
      vi.advanceTimersByTime(999);
      expect(calls.timeout).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(calls.timeout).toHaveBeenCalledWith(req(1), [], true);
    });

    it('hands a held request to onLoadFailure if the worker fails to load', () => {
      const { managed, calls } = setup();
      managed.ensure();
      managed.postWhenReady(req(1));
      latest().failFetch();
      expect(calls.load).toHaveBeenCalledWith([req(1)], false);
    });

    it('gives up on a worker that neither loads nor errors', () => {
      const { managed, calls } = setup();
      managed.ensure();
      const hung = latest();
      managed.postWhenReady(req(1));
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR - 1);
      expect(calls.load).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(hung.terminated).toBe(true);
      expect(calls.load).toHaveBeenCalledWith([req(1)], false);
    });

    it('does not count or act on a load timer whose held request was forgotten (#523)', () => {
      const { managed, calls } = setup();
      managed.ensure();
      const slow = latest();
      managed.postWhenReady(req(1));
      managed.forget();
      // The worker is only slow: nobody waits on it, so the timer changes nothing.
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR);
      expect(slow.terminated).toBe(false);
      expect(FakeWorker.instances).toHaveLength(1);
      expect(calls.load).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      // It loads, and the next request is served normally.
      slow.ready();
      expect(managed.post(req(2))).toBe(true);
      expect(slow.posted).toEqual([req(2)]);
      slow.respond(2);
      expect(calls.response).toHaveBeenCalledWith({ id: 2, echo: 'ok' }, req(2));
      expect(calls.timeout).not.toHaveBeenCalled();
    });

    it('spends no load failure on requests nobody waits for, so the cap is kept for real ones (#523)', () => {
      const { managed, calls } = setup();
      for (let round = 0; round < MAX_WORKER_LOAD_FAILURES + 1; round++) {
        managed.postWhenReady(req(round));
        managed.forget();
        vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR);
      }
      expect(calls.load).not.toHaveBeenCalled();
      expect(FakeWorker.instances).toHaveLength(1);
      // A request that is waiting still has the full bound, from its own post.
      managed.postWhenReady(req(9));
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR - 1);
      expect(calls.load).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(calls.load).toHaveBeenCalledWith([req(9)], false);
    });

    it('still fails the load for a request posted after the forget, on the original timer', () => {
      const { managed, calls } = setup();
      managed.postWhenReady(req(1));
      vi.advanceTimersByTime(1000);
      managed.forget();
      managed.postWhenReady(req(2));
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR - 1000);
      expect(calls.load).toHaveBeenCalledWith([req(2)], false);
    });

    it('does not count a load timer whose posted requests were all forgotten', () => {
      const { managed, calls } = setup();
      managed.post(req(1));
      const slow = latest();
      managed.forget();
      vi.advanceTimersByTime(1000 * LOAD_WAIT_FACTOR);
      expect(slow.terminated).toBe(false);
      expect(calls.load).not.toHaveBeenCalled();
    });

    it('drops a held request on forget', () => {
      const { managed } = setup();
      managed.ensure();
      managed.postWhenReady(req(1));
      managed.forget();
      latest().ready();
      expect(latest().posted).toEqual([]);
    });

    it('is false when no worker can be had', () => {
      vi.stubGlobal('Worker', undefined);
      const { managed } = setup();
      expect(managed.postWhenReady(req(1))).toBe(false);
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
