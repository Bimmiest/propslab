// ---------------------------------------------------------------------------
// useWorkerRequest.ts
// The request lifecycle shared by the live-matching hooks (#151).
//
// Construct a worker from a factory, post a request, match the response by
// monotonic id, discard stale ones, watchdog the slow ones, restart on crash,
// and tear down on unmount. `useRegexMatch` and `useTimestampMatch` implemented
// all of that independently and identically.
//
// NOT an RPC proxy. `useProcessingPipeline` has requirements a uniform
// request/response surface would fight rather than serve — crash-retry that
// replays the last request under a cap, and deliberate clearing of a poisoned
// request so a later `onerror` cannot replay something that already timed out.
// This hook carries the generic parts and leaves that hook alone, which is what
// #151 scoped it to.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_WORKER_LOAD_FAILURES, isWorkerLoadFailure } from './workerLifecycle';

// After MAX_WORKER_LOAD_FAILURES workers in a row fail to load, the hook stops
// constructing them and runs everything inline (#309). `new Worker` does not
// throw when its script cannot be fetched (a 404 after a redeploy, a CSP
// block); that failure arrives as an `error` event, which used to restart the
// worker unconditionally — forever, for a chunk that is gone. The cap is shared
// with `useProcessingPipeline`.
//
// Crashes do not count toward it (#326). #309 counted every death of a worker
// that had not yet answered, and a replacement has not answered by definition,
// so two crashing requests in a row — a pattern that blows the stack, say —
// switched the hook to inline for good: every later pattern ran on the tab's
// own thread, which is exactly the ReDoS exposure the worker exists to prevent.

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
   * (tests, SSR) or where construction failed. Only inputs that already passed
   * the caller's own guards reach here in practice.
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

  const workerRef = useRef<Worker | null>(null);
  const idRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Assigned inside the setup effect, never during render, so calling it from a
  // caller's effect keeps setState off the render path.
  const runRef = useRef<(request: TReq) => void>(() => {});

  // Declared before the setup effect so it lands before the caller's own effect
  // fires `run`, which is what makes a mid-life config change take effect.
  useEffect(() => {
    configRef.current = config;
  });

  useEffect(() => {
    function clearTimer() {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    // Consecutive workers that failed to start; reset by any message. Crashes
    // while running a request do not count (#326) — see onerror.
    let loadFailures = 0;
    // Workers that have been handed a request. One that throws before answering
    // without ever having been given one died of its own script.
    const givenWork = new WeakSet<Worker>();
    // The request in flight, kept so a worker that failed to load can have it
    // resent or run inline rather than dropped (#309). Null when nothing is in
    // flight, which is also how onerror knows there is nothing to report.
    let inFlight: { request: TReq; id: number } | null = null;

    // Tear down the current worker and, unless the start-failure cap has been
    // reached, build a replacement. Past the cap `workerRef` stays null, which
    // routes every later `run` through `runInline` (#309).
    function restart() {
      clearTimer();
      workerRef.current?.terminate();
      workerRef.current = null;
      if (loadFailures < MAX_WORKER_LOAD_FAILURES) init();
    }

    function fail() {
      restart();
      inFlight = null;
      setStatus('timeout');
      setData(configRef.current.empty);
    }

    function applyInline(request: TReq) {
      const current = configRef.current;
      const outcome = current.runInline(request);
      setStatus(outcome.status);
      setData(outcome.status === 'ok' ? outcome.data : current.empty);
    }

    function post(worker: Worker, request: TReq, id: number) {
      inFlight = { request, id };
      givenWork.add(worker);
      setStatus('pending');
      timeoutRef.current = setTimeout(() => {
        timeoutRef.current = null;
        fail();
      }, configRef.current.timeoutMs);
      worker.postMessage({ ...request, id });
    }

    function init() {
      if (typeof Worker === 'undefined') {
        workerRef.current = null;
        return;
      }
      let worker: Worker;
      try {
        worker = configRef.current.createWorker();
      } catch {
        workerRef.current = null; // fall back to inline
        return;
      }
      workerRef.current = worker;
      // Whether this worker has ever answered, i.e. its script demonstrably
      // loaded. Errors from one that has not are what the cap counts (#309).
      let answered = false;

      worker.onmessage = (e: MessageEvent<TRes & { id: number }>) => {
        // Any message, stale or not, proves the script loaded and ran.
        answered = true;
        loadFailures = 0;
        if (e.data.id !== idRef.current) return; // stale response
        clearTimer();
        inFlight = null;
        const outcome = configRef.current.interpret(e.data);
        setStatus(outcome.status);
        setData(outcome.status === 'ok' ? outcome.data : configRef.current.empty);
      };

      worker.onerror = (e) => {
        // A load failure — a worker that never answered, with an event that
        // carries no message — is the plain `Event` the HTML spec fires when the
        // script cannot be fetched or parsed; an exception from code that ran is
        // an `ErrorEvent` with one. No code saw the request in a load failure, so
        // it is resent (or run inline past the cap) rather than reported (#309).
        const loadFailure = isWorkerLoadFailure(e, answered);
        // Only failures to start count toward the cap (#309, #326): a load
        // failure, or a worker that threw before answering without ever having
        // been handed a request — a script that throws while evaluating, which
        // would otherwise be rebuilt in a loop. A crash while running a request
        // is the request's doing; the script evidently loaded, and a fresh
        // worker is still where the next request belongs.
        if (loadFailure || (!answered && !givenWork.has(worker))) loadFailures += 1;
        const pending = inFlight;
        restart();

        // Nothing was requested, so there is nothing to report. This used to go
        // through `fail`, flipping status to `timeout` for a request that never
        // existed (#309).
        if (!pending) return;

        if (!loadFailure) {
          // The worker died mid-run (e.g. a runaway pattern). Report it the way
          // a timeout is reported, so the caller recovers identically. Never
          // inline: this request is known to take a thread down (#326).
          inFlight = null;
          setStatus('timeout');
          setData(configRef.current.empty);
          return;
        }
        if (workerRef.current) post(workerRef.current, pending.request, pending.id);
        else {
          inFlight = null;
          applyInline(pending.request);
        }
      };
    }

    runRef.current = (request: TReq) => {
      clearTimer();
      inFlight = null;
      const current = configRef.current;

      // Bumped before the idle check, not after it. Returning first left the id
      // of the request still in flight current, so its late response passed the
      // staleness check in onmessage and overwrote `idle` with results for input
      // the caller had already cleared (#294). Going idle is a new request too —
      // one whose answer is known without asking the worker.
      const id = ++idRef.current;

      if (current.isIdle(request)) {
        setStatus('idle');
        setData(current.empty);
        return;
      }

      if (workerRef.current === null) {
        applyInline(request);
        return;
      }

      post(workerRef.current, request, id);
    };

    init();

    return () => {
      clearTimer();
      workerRef.current?.terminate();
      workerRef.current = null;
    };
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
