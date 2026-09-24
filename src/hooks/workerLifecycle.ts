/**
 * The worker lifecycle every caller shares, and the timing and failure rules
 * the views that must agree with it read. One copy, so a view that waits "as
 * long as the pipeline does" cannot drift from the pipeline (#335), and so the
 * three callers stop disagreeing about what a dead worker means (#339).
 *
 * No React here: the TIME_FORMAT hover (`monaco/timePrefixMatcher.ts`) runs
 * outside any component and uses the same lifecycle as the hooks.
 */

import { isWorkerReadyMessage } from '../engine/workerProtocol';

/** How long input must be still before the pipeline re-runs in auto mode. */
export const PIPELINE_DEBOUNCE_MS = 300;

/**
 * How many workers may fail to *load* in a row before a caller stops building
 * them and falls back (#309). Two, not one: a single start-up death could be a
 * transient fetch, and costs only one spare construction to find out. Crashes
 * do not count: an input that crashes its worker must never be handed to the
 * tab's own thread (#326).
 */
export const MAX_WORKER_LOAD_FAILURES = 2;

// ---------------------------------------------------------------------------
// createManagedWorker (#339)
//
// Construction, the ready signal, the per-request watchdog, crash-vs-load
// classification, the load-failure cap, and terminate/rebuild. It was written
// out three times — useProcessingPipeline, useWorkerRequest and the hover's
// timePrefixMatcher — and the copies disagreed. What each caller does about a
// failure (resend, replay, run inline, report) is the caller's policy, and it
// arrives here as callbacks; the lifecycle only says what happened.
//
// Classification is by the worker's ready signal (`engine/workerProtocol.ts`),
// never by whether it had been given work. The earlier rule — "a worker that
// has not answered and was given nothing died of its own script" — could not
// cover the first worker: the first request is posted in the same commit the
// worker is built, before its script has even run, so a module that threw at
// top level was always charged to that request. The pipeline then reported
// the mount request as having "crashed repeatedly" and never rendered it; the
// Regex and Timestamp tabs reported a timeout; and the hover, which had no
// cap for crashes at all, built a new worker on every hover and blamed the
// prefix each time. Requests posted before ready are fine: postMessage
// buffers them until the module has evaluated.
//
// `new Worker` does not throw when its chunk cannot be fetched (a 404 after a
// redeploy, a CSP block); that failure arrives later as an `error` event. It
// is before ready, so it counts, and past MAX_WORKER_LOAD_FAILURES no further
// worker is built (#309). A constructor that does throw counts the same way.
//
// The watchdog starts when a request is posted, ready or not, so the budget
// covers the module's load as well as the work — what every caller has always
// measured. A caller that needs to know whether its timed-out request could
// have run at all is told whether the worker had loaded.
// ---------------------------------------------------------------------------

export interface ManagedWorkerConfig<TReq extends { id: number }, TRes extends { id: number }> {
  /** Builds a worker. A throw counts as a load failure. */
  create: () => Worker;
  /** Watchdog budget per request, read at each post. */
  readonly timeoutMs: number;
  /** A response to a request still being tracked; untracked ids are dropped. */
  onResponse: (response: TRes, request: TReq) => void;
  /**
   * `request`'s watchdog fired. The worker has been terminated and replaced;
   * `others` were in flight behind it, never answered, and are no longer
   * tracked — post them again or settle them. `loaded` says whether the worker
   * had sent ready, i.e. whether `request` can have started at all.
   */
  onTimeout: (request: TReq, others: TReq[], loaded: boolean) => void;
  /**
   * A worker that had loaded died. `inFlight` (oldest first) is untracked; the
   * oldest is the one it was running. A replacement is built only when
   * something was in flight: one that dies with nothing to do is replaced on
   * the next post, so a script that dies idle cannot rebuild itself in a loop.
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
   * Post a request under a fresh watchdog, building a worker first if needed.
   * False when no worker can be had — no `Worker` global, or the cap is spent —
   * and the caller falls back.
   */
  post: (request: TReq) => boolean;
  /**
   * Stop tracking everything in flight: no watchdog, and a late answer is
   * dropped. For a caller whose newer request supersedes the older ones.
   */
  forget: () => void;
  /** Terminate the worker, forget everything and reset the cap. */
  dispose: () => void;
}

interface Tracked<TReq> {
  request: TReq;
  timer: ReturnType<typeof setTimeout>;
}

export function createManagedWorker<TReq extends { id: number }, TRes extends { id: number }>(
  config: ManagedWorkerConfig<TReq, TRes>,
): ManagedWorker<TReq> {
  let worker: Worker | null = null;
  // Whether the current worker has loaded: sent ready, or anything at all.
  let ready = false;
  // Consecutive load failures. Reset when a worker loads, so the cap means
  // "in a row" (#309); crashes never touch it (#326).
  let loadFailures = 0;
  // In posting order (Map keeps insertion order), which is the order a worker
  // runs them in: the oldest is the one it is busy with.
  const inFlight = new Map<number, Tracked<TReq>>();

  const capped = () => loadFailures >= MAX_WORKER_LOAD_FAILURES;

  /** Untrack everything in flight and hand it back, oldest first. */
  function takeAll(): TReq[] {
    const requests = [...inFlight.values()].map((t) => {
      clearTimeout(t.timer);
      return t.request;
    });
    inFlight.clear();
    return requests;
  }

  function discard() {
    worker?.terminate();
    worker = null;
    ready = false;
  }

  function build(): Worker | null {
    if (worker) return worker;
    if (typeof Worker === 'undefined' || capped()) return null;
    let w: Worker;
    try {
      w = config.create();
    } catch {
      loadFailures += 1;
      return null;
    }
    worker = w;
    ready = false;

    w.onmessage = (e: MessageEvent<unknown>) => {
      if (w !== worker) return;
      // Any message proves the module evaluated, the ready signal first among
      // them; a response without one would be a worker entry that forgot it.
      if (!ready) {
        ready = true;
        loadFailures = 0;
      }
      if (isWorkerReadyMessage(e.data)) return;
      const response = e.data as TRes;
      const tracked = inFlight.get(response.id);
      if (!tracked) return; // superseded, or given up on
      clearTimeout(tracked.timer);
      inFlight.delete(response.id);
      config.onResponse(response, tracked.request);
    };

    w.onerror = (e: Event) => {
      if (w !== worker) return;
      const loaded = ready;
      const requests = takeAll();
      discard();
      if (!loaded) {
        loadFailures += 1;
        build();
        config.onLoadFailure(requests, capped());
        return;
      }
      if (requests.length > 0) build();
      config.onCrash(requests, (e as Partial<ErrorEvent>).message ?? '');
    };

    return w;
  }

  function expire(id: number) {
    const tracked = inFlight.get(id);
    if (!tracked) return;
    inFlight.delete(id);
    const loaded = ready;
    const others = takeAll();
    discard();
    build();
    config.onTimeout(tracked.request, others, loaded);
  }

  return {
    ensure: () => build() !== null,
    post(request) {
      const w = build();
      if (!w) return false;
      const previous = inFlight.get(request.id);
      if (previous) clearTimeout(previous.timer);
      inFlight.set(request.id, {
        request,
        timer: setTimeout(() => expire(request.id), config.timeoutMs),
      });
      w.postMessage(request);
      return true;
    },
    forget() {
      takeAll();
    },
    dispose() {
      takeAll();
      discard();
      loadFailures = 0;
    },
  };
}
