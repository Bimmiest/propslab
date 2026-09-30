// ---------------------------------------------------------------------------
// useWorkerRequest.ts
// The request lifecycle shared by the live-matching hooks, `useRegexMatch` and
// `useTimestampMatch`.
//
// Post a request, match the response by monotonic id, discard stale ones, hand
// the answer back with the request it answers, and tear down on unmount.
// Optionally, send the request's large inputs ahead once per identity and mark
// each request as superseding the last (`sendAhead`, `latestOnly`).
//
// NOT an RPC proxy. `useProcessingPipeline` replays a crashed request once and
// re-runs its input inline in cases this hook never does; a uniform
// request/response surface would fight those rather than serve them. What the
// two do share, the worker's own lifecycle, is `createManagedWorker`.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef, useState } from 'react';
import { createManagedWorker } from './workerLifecycle';
import { isWorkerSkippedResponse, type WorkerInputsMessage } from '../engine/workerProtocol';

/** What is posted: the request, or what `sendAhead` leaves of it, with the id this hook assigns. */
type Posted = object & { id: number };

// The worker itself — construction, ready tracking, the watchdog, telling a
// crash from a load failure, and the load-failure cap — is
// `createManagedWorker`. What is left here is this hook's policy for each failure:
//
// - A load failure says nothing about the request, which no code saw. It is
//   resent to the replacement, and past MAX_WORKER_LOAD_FAILURES it runs
//   inline: `new Worker` does not throw when its script cannot be fetched, so
//   the cap is what stops such a worker being rebuilt forever.
// - A slow load is not the request's doing either: no watchdog runs until the
//   worker has loaded, and a load that outlasts the load timer is a load
//   failure.
// - A crash is the request's doing. It is reported as `timeout` and never run
//   inline, and crashes do not count toward the cap: running a crashing
//   pattern on the tab's own thread, with no watchdog, is exactly what the
//   worker prevents.

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
  /**
   * Turn a worker response into state. `request` is the request it answers,
   * as the caller made it: a response carries only its id, and only the
   * latest request's response reaches here.
   */
  interpret: (response: TRes, request: TReq) => WorkerOutcome<TData>;
  /**
   * Run the same work on the calling thread, for environments with no `Worker`
   * (tests, SSR), or once MAX_WORKER_LOAD_FAILURES workers in a row failed to
   * construct or load. Never for a request that crashed a worker.
   * Only inputs that already passed the caller's own guards reach here in
   * practice.
   */
  runInline: (request: TReq) => WorkerOutcome<TData>;
  /** True when there is nothing to do, e.g. an empty pattern. Reports `idle`. */
  isIdle: (request: TReq) => boolean;
  /**
   * Send the large part of a request ahead, once per identity, instead of in
   * every request (`WorkerInputsMessage`): `inputs` picks it out, compared by
   * identity, and `rest` is what each request then carries. The worker must
   * serve with `createRequestQueue`.
   */
  sendAhead?: {
    inputs: (request: TReq) => unknown;
    rest: (request: TReq) => object;
  };
  /**
   * Mark each request `latestOnly`, so a worker serving with
   * `createRequestQueue` skips one a newer request has superseded rather than
   * run it. Right for a caller whose every request replaces the last.
   */
  latestOnly?: boolean;
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
 * id exists for — or, with `sendAhead`, the request before it is split.
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
    // it inline past the cap rather than drop it. The worker is posted
    // the same request with its id attached.
    let latest: { request: TReq; id: number } | null = null;
    // The inputs last sent ahead (see `sendAhead`), and the id they went under.
    let sentInputs: { inputs: unknown; inputsId: number } | null = null;

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
    const managed = createManagedWorker<Posted, TRes & { id: number }>({
      create: () => configRef.current.createWorker(),
      get timeoutMs() {
        return configRef.current.timeoutMs;
      },
      onResponse(response) {
        if (response.id !== idRef.current || latest?.id !== response.id) return;
        // Only a request something newer superseded is skipped, and that one
        // failed the id check above; this is the rule, not an expected case.
        if (isWorkerSkippedResponse(response)) return;
        const outcome = configRef.current.interpret(response, latest.request);
        setStatus(outcome.status);
        setData(outcome.status === 'ok' ? outcome.data : configRef.current.empty);
      },
      onTimeout(request, _others, loaded) {
        if (request.id !== idRef.current) return;
        // The worker never loaded, so the request never ran and says nothing
        // about the pattern: run it once the replacement has loaded.
        if (!loaded && latest?.id === request.id) {
          if (!managed.postWhenReady(request)) applyInline(latest.request);
          return;
        }
        reportTimeout();
      },
      onCrash(inFlight) {
        // Nothing was requested, so there is nothing to report: a crash with
        // nothing in flight must not flip status to `timeout` for a request
        // that never existed. With something in flight, the worker died
        // mid-run: report it the way a timeout is reported, so the caller
        // recovers identically, and never inline — this request is known to
        // take a thread down.
        if (inFlight.some((r) => r.id === idRef.current)) reportTimeout();
      },
      onLoadFailure(inFlight) {
        const pending = inFlight.find((r) => r.id === idRef.current);
        if (!pending || latest?.id !== pending.id) return;
        if (!managed.post(pending)) applyInline(latest.request);
      },
    });

    // The request as posted: whole, or with its inputs sent ahead when they
    // are not the ones the worker already has.
    function toMessage(request: TReq): object {
      const split = configRef.current.sendAhead;
      if (!split) return request;
      const inputs = split.inputs(request);
      let sent = sentInputs;
      if (sent === null || sent.inputs !== inputs) {
        sent = { inputs, inputsId: (sent?.inputsId ?? 0) + 1 };
        sentInputs = sent;
        const message: WorkerInputsMessage<unknown> = { type: 'inputs', inputsId: sent.inputsId, inputs };
        managed.setInputs(message);
      }
      return { ...split.rest(request), inputsId: sent.inputsId };
    }

    runRef.current = (request: TReq) => {
      managed.forget();
      const current = configRef.current;

      // Bumped before the idle check, not after it, so a late response to the
      // request still in flight fails the staleness check rather than
      // overwriting `idle` with results for input the caller has cleared.
      // Going idle is a new request too — one whose answer is known without
      // asking the worker.
      const id = ++idRef.current;
      latest = null;

      if (current.isIdle(request)) {
        setStatus('idle');
        setData(current.empty);
        return;
      }

      latest = { request, id };
      if (managed.post({ ...toMessage(request), id, ...(current.latestOnly ? { latestOnly: true } : {}) })) {
        setStatus('pending');
        return;
      }
      applyInline(request);
    };

    managed.ensure();
    return () => managed.dispose();
  }, []);

  // Stable for the life of the hook, which the callers' effects rely on: they
  // list `run` as a dependency, and a fresh arrow per render would re-post on
  // every render of the caller. Delegating through
  // the ref keeps the identity fixed while the implementation stays the one the
  // setup effect installed.
  const run = useCallback((request: TReq) => runRef.current(request), []);

  return { status, data, run };
}
