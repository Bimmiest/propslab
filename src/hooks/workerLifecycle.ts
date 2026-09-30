/**
 * The worker lifecycle every caller shares, and the timing and failure rules
 * the views that must agree with it read. One copy, so a view that waits "as
 * long as the pipeline does" cannot drift from the pipeline, and so the three
 * callers agree about what a dead worker means.
 *
 * No React here: the TIME_FORMAT hover (`monaco/timePrefixMatcher.ts`) runs
 * outside any component and uses the same lifecycle as the hooks.
 */

import { isWorkerReadyMessage } from '../engine/workerProtocol';

/** How long input must be still before the pipeline re-runs in auto mode. */
export const PIPELINE_DEBOUNCE_MS = 300;

/**
 * How many workers may fail to *load* in a row before a caller stops building
 * them and falls back. Two, not one: a single start-up death could be a
 * transient fetch, and costs only one spare construction to find out. Crashes
 * do not count: an input that crashes its worker must never be handed to the
 * tab's own thread.
 */
export const MAX_WORKER_LOAD_FAILURES = 2;

/** How many run budgets a request waits for its worker to load. */
export const LOAD_WAIT_FACTOR = 6;

// ---------------------------------------------------------------------------
// createManagedWorker
//
// Construction, the ready signal, the per-request watchdog, crash-vs-load
// classification, the load-failure cap, and terminate/rebuild, shared by
// useProcessingPipeline, useWorkerRequest and the hover's timePrefixMatcher.
// What each caller does about a failure (resend, replay, run inline, report)
// is the caller's policy, and it arrives here as callbacks; the lifecycle only
// says what happened.
//
// Classification is by the worker's ready signal (`engine/workerProtocol.ts`),
// never by whether it had been given work: the first request is posted in the
// same commit the worker is built, before its script has even run, so a
// module that throws at top level must not be charged to that request.
// Requests posted before ready are fine: postMessage buffers them until the
// module has evaluated.
//
// `new Worker` does not throw when its chunk cannot be fetched (a 404 after a
// redeploy, a CSP block); that failure arrives later as an `error` event. It
// is before ready, so it counts, and past MAX_WORKER_LOAD_FAILURES no further
// worker is built. A constructor that does throw counts the same way.
//
// A worker runs its requests one at a time, in posting order, so a request's
// watchdog starts when the worker gets to it: at post when nothing is ahead of
// it, otherwise when the request ahead is answered, so no request is charged
// for its predecessors' run time. Nor for the module's load: until ready, a
// posted request has no watchdog, and the load timer (LOAD_WAIT_FACTOR run
// budgets, counted as a load failure) bounds the wait instead. A run budget
// against a worker still downloading would terminate it, and every new
// request would restart the download (#420). The load timer bounds a wait, so
// when it fires with every waiting request forgotten, nobody is waiting: the
// worker may only be slow, and it is left to load, uncounted (#523).
// ---------------------------------------------------------------------------

export interface ManagedWorkerConfig<TReq extends { id: number }, TRes extends { id: number }> {
  /** Builds a worker. A throw counts as a load failure. */
  create: () => Worker;
  /** Watchdog budget per request, read when its watchdog starts. */
  readonly timeoutMs: number;
  /** A response to a request still being tracked; untracked ids are dropped. */
  onResponse: (response: TRes, request: TReq) => void;
  /**
   * `request`'s watchdog fired. The worker has been terminated and replaced;
   * `others` were in flight behind it, never answered, and are no longer
   * tracked — post them again or settle them. `loaded` says whether the worker
   * had sent ready, i.e. whether `request` can have started at all; since a
   * watchdog only starts once it has (#420), this lifecycle always passes
   * true, and a caller's handling of false is a guard, not a path.
   */
  onTimeout: (request: TReq, others: TReq[], loaded: boolean) => void;
  /**
   * A worker that had loaded died while running `inFlight[0]`, and `inFlight`
   * (oldest first) is untracked. Only called when the request it was running is
   * one the caller still wants, or when nothing is left to run (`inFlight` is
   * empty): when the worker died on a request the caller had forgotten, the
   * lifecycle re-posts the newer ones on the replacement, unblamed, exactly as
   * for a timeout, since none of them had started (#491). A replacement is
   * built only when something was in flight: one that dies with nothing to do
   * is replaced on the next post, so a script that dies idle cannot rebuild
   * itself in a loop.
   */
  onCrash: (inFlight: TReq[], message: string) => void;
  /**
   * A worker died before it loaded. No code saw `inFlight`, which is untracked.
   * A replacement has been built unless `capped`, in which case `post` returns
   * false from now on.
   */
  onLoadFailure: (inFlight: TReq[], capped: boolean) => void;
}

export interface ManagedWorker<TReq> {
  /** Build a worker now if there is none. False when none can be had. */
  ensure: () => boolean;
  /**
   * Post a request under a fresh watchdog, building a worker first if needed;
   * before the worker has loaded, under the load timer until it does.
   * False when no worker can be had — no `Worker` global, or the cap is spent —
   * and the caller falls back.
   */
  post: (request: TReq) => boolean;
  /**
   * `post`, but not handed to the worker until it has loaded. If it fails to
   * load, the request is handed to `onLoadFailure` like anything else in
   * flight, and dropped by `forget`.
   */
  postWhenReady: (request: TReq) => boolean;
  /**
   * Supersede everything in flight: no callback will be made for it, and a late
   * answer is dropped. The worker is still busy with it, so it stays under its
   * watchdog; if it hangs, the lifecycle replaces the worker and posts the
   * newer requests again, which are not blamed. For a caller whose newer
   * request supersedes the older ones.
   */
  forget: () => void;
  /** Terminate the worker, forget everything and reset the cap. */
  dispose: () => void;
}

interface Tracked<TReq> {
  request: TReq;
  /** Null until the worker gets to this request. */
  timer: ReturnType<typeof setTimeout> | null;
  /** Forgotten by the caller: tracked only because the worker is still busy with it. */
  superseded: boolean;
}

class ManagedWorkerImpl<TReq extends { id: number }, TRes extends { id: number }> implements ManagedWorker<TReq> {
  private readonly config: ManagedWorkerConfig<TReq, TRes>;
  private worker: Worker | null = null;
  /** Whether the current worker has loaded: sent ready, or anything at all. */
  private ready = false;
  /**
   * Consecutive load failures. Reset when a worker loads, so the cap means
   * "in a row"; crashes never touch it.
   */
  private loadFailures = 0;
  /**
   * In posting order (Map keeps insertion order), which is the order a worker
   * runs them in: the oldest is the one it is busy with.
   */
  private readonly inFlight = new Map<number, Tracked<TReq>>();
  /** Waiting for the current worker's ready signal before they are posted. */
  private deferred: TReq[] = [];
  /**
   * Bounds the wait for that signal, for everything posted or deferred: a
   * worker whose fetch hangs neither loads nor errors, and nothing else would
   * ever settle what waits on it. Generous next to the run budget, since a
   * slow load is not the request's fault. Armed by the first request to wait
   * and not restarted by later ones; if everything waiting has been forgotten
   * when it fires, it does nothing, and the next request arms it again.
   */
  private loadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: ManagedWorkerConfig<TReq, TRes>) {
    this.config = config;
  }

  private capped(): boolean {
    return this.loadFailures >= MAX_WORKER_LOAD_FAILURES;
  }

  /**
   * Untrack everything in flight and hand back what the caller still wants,
   * oldest first; superseded requests are dropped.
   */
  private takeAll(): TReq[] {
    const requests: TReq[] = [];
    for (const t of this.inFlight.values()) {
      if (t.timer !== null) clearTimeout(t.timer);
      if (!t.superseded) requests.push(t.request);
    }
    this.inFlight.clear();
    requests.push(...this.deferred);
    this.deferred = [];
    return requests;
  }

  /** Start the watchdog of the request the worker is running now. */
  private armHead(): void {
    const head = this.inFlight.values().next().value;
    if (!head || head.timer !== null) return;
    head.timer = setTimeout(() => this.expire(head), this.config.timeoutMs);
  }

  /** Whether any request the caller still wants is waiting on the worker. */
  private anyWaiting(): boolean {
    if (this.deferred.length > 0) return true;
    for (const t of this.inFlight.values()) if (!t.superseded) return true;
    return false;
  }

  private armLoadTimer(): void {
    this.loadTimer ??= setTimeout(() => {
      this.loadTimer = null;
      if (this.ready || !this.anyWaiting()) return;
      const requests = this.takeAll();
      this.discard();
      this.loadFailures += 1;
      this.build();
      this.config.onLoadFailure(requests, this.capped());
    }, this.config.timeoutMs * LOAD_WAIT_FACTOR);
  }

  private clearLoadTimer(): void {
    if (this.loadTimer !== null) clearTimeout(this.loadTimer);
    this.loadTimer = null;
  }

  private discard(): void {
    this.clearLoadTimer();
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }

  private build(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined' || this.capped()) return null;
    let w: Worker;
    try {
      w = this.config.create();
    } catch {
      this.loadFailures += 1;
      return null;
    }
    this.worker = w;
    this.ready = false;
    w.onmessage = (e: MessageEvent<unknown>) => {
      if (w === this.worker) this.receive(e.data);
    };
    w.onerror = (e: Event) => {
      if (w === this.worker) this.fail((e as Partial<ErrorEvent>).message ?? '');
    };
    return w;
  }

  /** A message from the current worker. */
  private receive(data: unknown): void {
    // Any message proves the module evaluated, the ready signal first among
    // them; a response without one would be a worker entry that forgot it.
    if (!this.ready) {
      this.ready = true;
      this.loadFailures = 0;
      this.clearLoadTimer();
      // What was posted while it loaded has had no watchdog; it starts now.
      this.armHead();
      const waiting = this.deferred;
      this.deferred = [];
      for (const request of waiting) this.post(request);
    }
    if (isWorkerReadyMessage(data)) return;
    const response = data as TRes;
    const tracked = this.inFlight.get(response.id);
    if (!tracked) return; // given up on
    if (tracked.timer !== null) clearTimeout(tracked.timer);
    this.inFlight.delete(response.id);
    // The worker moves on to the next request now, so its budget starts now.
    this.armHead();
    if (!tracked.superseded) this.config.onResponse(response, tracked.request);
  }

  /** The current worker raised an error: a load failure or a crash. */
  private fail(message: string): void {
    const loaded = this.ready;
    // The head is the request the worker was running. If it was forgotten, the
    // crash is not the fault of anything still wanted, so takeAll dropping it
    // must not leave a newer, unstarted request looking like the one that died.
    const headSuperseded = this.inFlight.values().next().value?.superseded ?? false;
    const requests = this.takeAll();
    this.discard();
    if (!loaded) {
      this.loadFailures += 1;
      this.build();
      this.config.onLoadFailure(requests, this.capped());
      return;
    }
    if (requests.length > 0) this.build();
    if (headSuperseded && requests.length > 0) {
      this.repostUnblamed(requests);
      return;
    }
    this.config.onCrash(requests, message);
  }

  /**
   * Run requests that never started on the replacement worker. Whatever cannot
   * be posted is handed to `onLoadFailure`: no code saw it.
   */
  private repostUnblamed(requests: TReq[]): void {
    const unposted: TReq[] = [];
    for (const request of requests) if (!this.post(request)) unposted.push(request);
    if (unposted.length > 0) this.config.onLoadFailure(unposted, this.capped());
  }

  private expire(tracked: Tracked<TReq>): void {
    if (this.inFlight.get(tracked.request.id) !== tracked) return;
    this.inFlight.delete(tracked.request.id);
    const loaded = this.ready;
    const others = this.takeAll();
    this.discard();
    this.build();
    if (!tracked.superseded) {
      this.config.onTimeout(tracked.request, others, loaded);
      return;
    }
    // Nobody is waiting for the request that hung, and the ones behind it
    // never started: run them on the replacement, unblamed.
    this.repostUnblamed(others);
  }

  // The public members are arrow properties so they stay bound when a caller
  // passes one on by itself.

  ensure = (): boolean => this.build() !== null;

  post = (request: TReq): boolean => {
    const w = this.build();
    if (!w) return false;
    const previous = this.inFlight.get(request.id);
    if (previous) {
      if (previous.timer !== null) clearTimeout(previous.timer);
      this.inFlight.delete(request.id);
    }
    this.inFlight.set(request.id, { request, timer: null, superseded: false });
    if (this.ready) this.armHead();
    else this.armLoadTimer();
    w.postMessage(request);
    return true;
  };

  postWhenReady = (request: TReq): boolean => {
    if (!this.build()) return false;
    if (this.ready) return this.post(request);
    this.deferred.push(request);
    this.armLoadTimer();
    return true;
  };

  forget = (): void => {
    for (const t of this.inFlight.values()) t.superseded = true;
    this.deferred = [];
  };

  dispose = (): void => {
    this.takeAll();
    this.discard();
    this.loadFailures = 0;
  };
}

export function createManagedWorker<TReq extends { id: number }, TRes extends { id: number }>(
  config: ManagedWorkerConfig<TReq, TRes>,
): ManagedWorker<TReq> {
  return new ManagedWorkerImpl(config);
}
