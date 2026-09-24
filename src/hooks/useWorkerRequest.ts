// ---------------------------------------------------------------------------
// useWorkerRequest.ts
// The request lifecycle shared by the live-matching hooks (#151).
//
// Post a request, match the response by monotonic id, discard stale ones, and
// tear down on unmount. `useRegexMatch` and `useTimestampMatch` implemented all
// of that independently and identically.
//
// NOT an RPC proxy. `useProcessingPipeline` replays a crashed request once and
// re-runs its input inline in cases this hook never does; a uniform
// request/response surface would fight those rather than serve them. What the
// two do share, the worker's own lifecycle, is `createManagedWorker` (#339).
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { createManagedWorker } from './workerLifecycle';

// The worker itself — construction, ready tracking, the watchdog, telling a
// crash from a load failure, and the load-failure cap — is `createManagedWorker`
// (#339). What is left here is this hook's policy for each failure:
//
// - A load failure says nothing about the request, which no code saw. It is
//   resent to the replacement, and past MAX_WORKER_LOAD_FAILURES it runs
//   inline (#309): `new Worker` does not throw when its script cannot be
//   fetched, and the hook used to rebuild such a worker forever.
// - A crash is the request's doing. It is reported as `timeout` and never run
//   inline (#326) — counting crashes toward the cap once sent the hook inline
//   for good after two crashing patterns, and every later pattern ran on the
//   tab's own thread, which is exactly the ReDoS exposure the worker prevents.
//
// Until #339 a script that threw at top level on the first worker counted as
// a crash — the first request is posted before the script has run — so the
// first pattern the user typed was reported as a timeout.

export type WorkerRequestStatus = 'idle' | 'pending' | 'ok' | 'timeout' | 'invalid';

/**
 * What a response (or an inline run) turned into. `invalid` is for input the
 * worker rejected on its merits — a regex that does not compile — as opposed to
 * `timeout`, which is the watchdog firing.
 */
export interface WorkerOutcome<TData> {
  status: 'ok' | 'invalid';
  data: TData;
}

export interface WorkerRequestConfig<TReq, TRes, TData> {
  /** Constructs the worker. Called again after a crash or a timeout. */
  createWorker: () => Worker;
  /** Watchdog budget. On expiry the worker is terminated and restarted. */
  timeoutMs: number;
  /** Returned for `idle`, `timeout` and `invalid`. */
  empty: TData;
  /** Turn a worker response into state. */
  interpret: (response: TRes) => WorkerOutcome<TData>;
  /**
   * Run the same work on the calling thread, for environments with no `Worker`
   * (tests, SSR), or once MAX_WORKER_LOAD_FAILURES workers in a row failed to
   * construct or load (#309). Never for a request that crashed a worker (#326).
   * Only inputs that already passed the caller's own guards reach here in
   * practice.
   */
  runInline: (request: TReq) => WorkerOutcome<TData>;
  /** True when there is nothing to do, e.g. an empty pattern. Reports `idle`. */
  isIdle: (request: TReq) => boolean;
}

export interface WorkerRequestHandle<TReq, TData> {
  status: WorkerRequestStatus;
  data: TData;
  /** Post a request. Any response to an earlier one is discarded as stale. */
  run: (request: TReq) => void;
}

/**
 * `TReq` is the message posted to the worker minus its `id`, which this hook
 * assigns — a caller that set its own would be racing the staleness check that
 * id exists for.
 */
export function useWorkerRequest<TReq extends object, TRes, TData>(
  config: WorkerRequestConfig<TReq, TRes, TData>,
): WorkerRequestHandle<TReq, TData> {
  const [status, setStatus] = useState<WorkerRequestStatus>('idle');
  const [data, setData] = useState<TData>(config.empty);

  // Config is read through a ref so a caller need not memoise the object it
  // passes; the setup effect below must run exactly once per mount. Seeded from
  // the first render and refreshed in an effect rather than during render —
  // updating a ref on the render path is what react-hooks/refs forbids, and the
  // first value is already correct because useRef takes it as its initialiser.
  const configRef = useRef(config);

  const idRef = useRef(0);
  // Assigned inside the setup effect, never during render, so calling it from a
  // caller's effect keeps setState off the render path.
  const runRef = useRef<(request: TReq) => void>(() => {});

  // Declared before the setup effect so it lands before the caller's own effect
  // fires `run`, which is what makes a mid-life config change take effect.
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    // The latest request, kept so a load failure — which no code saw — can run
    // it inline past the cap rather than drop it (#309). The worker is posted
    // the same request with its id attached.
    let latest: { request: TReq; id: number } | null = null;

    function reportTimeout() {
      setStatus('timeout');
      setData(configRef.current.empty);
    }

    function applyInline(request: TReq) {
      const current = configRef.current;
      const outcome = current.runInline(request);
      setStatus(outcome.status);
      setData(outcome.status === 'ok' ? outcome.data : current.empty);
    }

    // Earlier requests are forgotten whenever a new one is made, so whatever
    // these callbacks are handed is the latest request; the id checks are the
    // staleness rule stated where it matters, not a case expected to occur.
    const managed = createManagedWorker<TReq & { id: number }, TRes & { id: number }>({
      create: () => configRef.current.createWorker(),
      get timeoutMs() {
        return configRef.current.timeoutMs;
      },
      onResponse(response) {
        if (response.id !== idRef.current) return;
        const outcome = configRef.current.interpret(response);
        setStatus(outcome.status);
        setData(outcome.status === 'ok' ? outcome.data : configRef.current.empty);
      },
      onTimeout(request) {
        if (request.id === idRef.current) reportTimeout();
      },
      onCrash(inFlight) {
        // Nothing was requested, so there is nothing to report. A crash with
        // nothing in flight used to flip status to `timeout` for a request
        // that never existed (#309). With something in flight, the worker
        // died mid-run: report it the way a timeout is reported, so the caller
        // recovers identically, and never inline — this request is known to
        // take a thread down (#326).
        if (inFlight.some((r) => r.id === idRef.current)) reportTimeout();
      },
      onLoadFailure(inFlight) {
        const pending = inFlight.find((r) => r.id === idRef.current);
        if (!pending || latest?.id !== pending.id) return;
        if (!managed.post(pending)) applyInline(latest.request);
      },
    });

    runRef.current = (request: TReq) => {
      managed.forget();
      const current = configRef.current;

      // Bumped before the idle check, not after it. Returning first left the id
      // of the request still in flight current, so its late response passed the
      // staleness check and overwrote `idle` with results for input the caller
      // had already cleared (#294). Going idle is a new request too — one whose
      // answer is known without asking the worker.
      const id = ++idRef.current;
      latest = null;

      if (current.isIdle(request)) {
        setStatus('idle');
        setData(current.empty);
        return;
      }

      latest = { request, id };
      if (managed.post({ ...request, id })) {
        setStatus('pending');
        return;
      }
      applyInline(request);
    };

    managed.ensure();
    return () => managed.dispose();
  }, []);

  // Stable for the life of the hook, which the callers' effects rely on: they
  // list `run` as a dependency, and a fresh arrow per render (as this used to
  // return) would re-post on every render of the caller — the reason those
  // effects had suppressed exhaustive-deps instead (#294). Delegating through
  // the ref keeps the identity fixed while the implementation stays the one the
  // setup effect installed.
  const run = useCallback((request: TReq) => runRef.current(request), []);

  return { status, data, run };
}
