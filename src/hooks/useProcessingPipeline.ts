import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDebounce } from './useDebounce';
import type { PipelineWorkerRequest, PipelineWorkerResponse } from '../engine/pipelineWorker';

// Vite worker import — bundled as a separate chunk
const createWorker = () =>
  new Worker(new URL('../engine/pipelineWorker.ts', import.meta.url), { type: 'module' });

const WORKER_TIMEOUT_MS = 5_000;
// How many times a single request may restart the worker after a crash before we
// give up. A request that itself crashes the worker (e.g. OOM-sized input) would
// otherwise restart-and-replay forever; cap it so the loop terminates.
const MAX_WORKER_RETRIES = 1;
// How many workers in a row may die without ever answering before we stop
// constructing them and run on the calling thread instead (#309). `new Worker`
// does not throw when its module chunk cannot be fetched — a 404 after a
// redeploy, a CSP that blocks the script — the failure arrives later as an
// `error` event, so the constructor-failure fallback below never saw it and
// onerror recreated the worker forever. Two, not one: a single start-up death
// could be a transient fetch, and costs only one spare construction to find out.
const MAX_WORKER_START_FAILURES = 2;

export function useProcessingPipeline() {
  const rawData = useAppStore((s) => s.rawData);
  const metadata = useAppStore((s) => s.metadata);
  const propsConf = useAppStore((s) => s.propsConf);
  const transformsConf = useAppStore((s) => s.transformsConf);
  const settings = useAppStore((s) => s.settings);
  const manualRunTick = useAppStore((s) => s.manualRunTick);
  const setProcessingResult = useAppStore((s) => s.setProcessingResult);
  const setValidationDiagnostics = useAppStore((s) => s.setValidationDiagnostics);
  const setIsProcessing = useAppStore((s) => s.setIsProcessing);
  const setLastProcessingMs = useAppStore((s) => s.setLastProcessingMs);
  const setPipelineDirty = useAppStore((s) => s.setPipelineDirty);

  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRequestRef = useRef<PipelineWorkerRequest | null>(null);
  const requestStartRef = useRef<number>(0);
  const retryCountRef = useRef(0);
  // Consecutive errors from workers that never produced a message; reset only
  // by a message, not per request, or the cap would never be reached (#309).
  const startFailuresRef = useRef(0);
  const initWorkerRef = useRef<() => void>(() => {});
  // Latest settings, for the manual-run effect (which depends only on the tick).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Arm the 5 s watchdog for a given request id. Pulled out of sendRequest so the
  // crash-retry path can re-arm it too — without this, a hung retry would leave
  // isProcessing stuck true forever. Clears any poisoned request so a later
  // onerror cannot replay something that already timed out.
  const armWatchdog = useCallback((id: number) => {
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      if (id !== requestIdRef.current) return;
      timeoutRef.current = null;
      lastRequestRef.current = null; // do not let onerror replay a request that hung
      retryCountRef.current = 0;
      setIsProcessing(false);
      setProcessingResult(null);
      setValidationDiagnostics([{
        level: 'error',
        message: `Pipeline timed out after ${WORKER_TIMEOUT_MS / 1000} s — the input may contain a regex prone to catastrophic backtracking (ReDoS). Try simplifying your EXTRACT or TRANSFORMS pattern.`,
        file: 'props.conf',
      }]);
      workerRef.current?.terminate();
      workerRef.current = null;
      initWorkerRef.current();
    }, WORKER_TIMEOUT_MS);
  }, [setIsProcessing, setProcessingResult, setValidationDiagnostics]);

  // Capture live inputs in a ref so the manual-run effect can read them without being a dependency.
  // Written in an effect (not during render) so the ref only ever reflects committed values.
  const liveInputsRef = useRef({ rawData, metadata, propsConf, transformsConf });
  useEffect(() => {
    liveInputsRef.current = { rawData, metadata, propsConf, transformsConf };
  }, [rawData, metadata, propsConf, transformsConf]);

  // Run a request on the calling thread. The fallback for when a worker cannot
  // be constructed at all — no `Worker` (tests, SSR), a CSP that forbids worker
  // scripts, a failed chunk fetch. Before this, construction was unguarded, so
  // the throw escaped the mount effect and took the panel down; and had it been
  // caught, `sendRequest` would have returned early on every keystroke and the
  // preview would have sat on "No data yet" with nothing to say why (#294).
  // `useWorkerRequest` makes the same trade for the live-matching hooks.
  // A failed chunk fetch does not actually throw from `new Worker`; it surfaces
  // later as an `error` event, and reaches this path through onerror's
  // start-failure cap instead (#309).
  //
  // What is given up is the watchdog: a runaway regex here blocks the tab rather
  // than a worker. That is the cost of producing output at all in an environment
  // that will not run a worker, and the browsers this ships to always can.
  //
  // The engine is imported dynamically so the main bundle does not carry a
  // second copy of it for a path the browser normally never takes; the worker
  // chunk already has one.
  const runInline = useCallback((request: PipelineWorkerRequest) => {
    setIsProcessing(true);
    import('../engine/pipeline')
      .then(({ runPipeline }) => {
        if (request.id !== requestIdRef.current) return; // superseded while loading
        const output = runPipeline(
          request.rawData,
          request.metadata,
          request.propsConfText,
          request.transformsConfText,
          request.options,
        );
        setLastProcessingMs(performance.now() - requestStartRef.current);
        setProcessingResult(output.result);
        setValidationDiagnostics(output.diagnostics);
      })
      .catch((err: unknown) => {
        if (request.id !== requestIdRef.current) return;
        setProcessingResult(null);
        setValidationDiagnostics([{
          level: 'error',
          message: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
          file: 'props.conf',
        }]);
      })
      .finally(() => {
        if (request.id === requestIdRef.current) setIsProcessing(false);
      });
  }, [setIsProcessing, setLastProcessingMs, setProcessingResult, setValidationDiagnostics]);

  const sendRequest = useCallback((
    inputs: { rawData: string; metadata: typeof metadata; propsConf: string; transformsConf: string },
    opts: typeof settings,
  ) => {
    const id = ++requestIdRef.current;
    requestStartRef.current = performance.now();

    const request: PipelineWorkerRequest = {
      id,
      rawData: inputs.rawData,
      metadata: inputs.metadata,
      propsConfText: inputs.propsConf,
      transformsConfText: inputs.transformsConf,
      options: { perEventPipeline: opts.perEventPipeline },
    };

    if (!workerRef.current) {
      runInline(request);
      return;
    }

    // The retry budget is NOT reset here. Resetting per request meant a worker
    // that had just crashed got a fresh budget from the next keystroke, so the
    // "cap the restart loop" invariant this file documents was never actually
    // bounded across requests — interleaved auto-run and manual traffic could
    // restart the worker indefinitely. It is cleared where it should be: when a
    // request completes cleanly (onmessage), or when the watchdog gives up.
    setIsProcessing(true);

    armWatchdog(id);

    lastRequestRef.current = request;
    workerRef.current.postMessage(request);
  }, [armWatchdog, runInline, setIsProcessing]);

  // Initialise the worker once, with auto-restart on crash
  useEffect(() => {
    function clearWatchdog() {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
    }

    // Returns null when no worker can be had; `sendRequest` then runs inline.
    function initWorker(): Worker | null {
      if (typeof Worker === 'undefined') {
        workerRef.current = null;
        return null;
      }
      let worker: Worker;
      try {
        worker = createWorker();
      } catch {
        workerRef.current = null;
        return null;
      }
      workerRef.current = worker;
      // Whether this worker has ever answered, i.e. its script demonstrably
      // loaded. An error from one that has not is a start-up failure, which is
      // what bounds the restart loop below (#309).
      let answered = false;

      worker.onmessage = (e: MessageEvent<PipelineWorkerResponse>) => {
        // Any message — stale or not — proves the chunk loaded and ran.
        answered = true;
        startFailuresRef.current = 0;
        const { id, result, error } = e.data;
        if (id !== requestIdRef.current) return;

        clearWatchdog();
        setIsProcessing(false);
        setLastProcessingMs(performance.now() - requestStartRef.current);
        // This request completed cleanly — it is not poison, so clear the retry
        // budget and drop it so a later crash cannot replay an already-done request.
        retryCountRef.current = 0;
        lastRequestRef.current = null;

        if (error || !result) {
          setProcessingResult(null);
          setValidationDiagnostics([{
            level: 'error',
            message: `Pipeline error: ${error ?? 'Unknown error'}`,
            file: 'props.conf',
          }]);
          return;
        }

        setProcessingResult(result.result);
        setValidationDiagnostics(result.diagnostics);
      };

      worker.onerror = (e) => {
        clearWatchdog();
        workerRef.current?.terminate();
        workerRef.current = null;

        // A load failure is an error from a worker that never answered and whose
        // event carries no message: per the HTML spec a failed fetch or parse of
        // the worker script fires a plain `Event`, while an exception thrown by
        // code that did run arrives as an `ErrorEvent` with one. The distinction
        // matters because a load failure says nothing about the pending request —
        // no code ever saw it — so it must not spend that request's crash budget,
        // nor be reported as the input crashing the worker (#309).
        const loadFailure = !answered && !(e as Partial<ErrorEvent>).message;

        // Every worker that dies before answering counts, crash or load failure
        // alike (a script that throws at top level never answers either). Past
        // the cap no replacement is built, and `sendRequest` runs everything
        // inline from here on — the same place the constructor-failure path
        // lands (#309). Before this, `initWorker()` ran unconditionally, and a
        // chunk that 404s was refetched, and diagnostics rewritten, forever.
        if (!answered) startFailuresRef.current += 1;
        const restartedWorker =
          startFailuresRef.current < MAX_WORKER_START_FAILURES ? initWorker() : null;

        const pending = lastRequestRef.current;

        if (loadFailure) {
          // Nothing to report: the next request (or the one below) either
          // reaches the replacement or runs inline. Writing "Worker error"
          // here is what repainted the diagnostics on every refetch.
          if (!pending) return;
          if (restartedWorker) {
            // Resend without charging the retry budget; the watchdog is
            // re-armed for the same reason as on the crash-replay path.
            setIsProcessing(true);
            armWatchdog(pending.id);
            restartedWorker.postMessage(pending);
            return;
          }
          lastRequestRef.current = null;
          retryCountRef.current = 0;
          runInline(pending);
          return;
        }
        if (pending && restartedWorker === null && retryCountRef.current < MAX_WORKER_RETRIES) {
          // The replacement could not be constructed. Finish this request on
          // the calling thread, which is where every later one will run too —
          // but only under the retry cap: an input that crashed its replay as
          // well is not one to hand to the tab's own thread.
          lastRequestRef.current = null;
          retryCountRef.current = 0;
          runInline(pending);
          return;
        }
        if (pending && restartedWorker && retryCountRef.current < MAX_WORKER_RETRIES) {
          // Restart once and replay — covers a transient worker crash. The watchdog
          // is re-armed so a retry that also hangs cannot leave isProcessing stuck.
          retryCountRef.current += 1;
          setIsProcessing(true);
          armWatchdog(pending.id);
          restartedWorker.postMessage(pending);
          return;
        }

        // Out of retries (or no pending request): the input itself is crashing the
        // worker. Drop it so we don't loop, and surface a terminal error.
        lastRequestRef.current = null;
        retryCountRef.current = 0;
        setIsProcessing(false);
        setProcessingResult(null);
        setValidationDiagnostics([{
          level: 'error',
          message: pending
            ? `Worker crashed repeatedly while processing this input: ${e.message}. Processing was stopped — try reducing the input size or simplifying your patterns.`
            : `Worker error: ${e.message}`,
          file: 'props.conf',
        }]);
      };

      return worker;
    }

    initWorkerRef.current = initWorker;
    initWorker();

    return () => {
      if (timeoutRef.current !== null) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [armWatchdog, runInline, setIsProcessing, setProcessingResult, setValidationDiagnostics, setLastProcessingMs]);

  const inputs = useMemo(
    () => ({ rawData, metadata, propsConf, transformsConf }),
    [rawData, metadata, propsConf, transformsConf],
  );

  const debouncedInputs = useDebounce(inputs, 300);

  // Auto-run effect: fires on debounced input changes when manual apply is OFF.
  useEffect(() => {
    if (settings.manualApply) {
      setPipelineDirty(true);
      return;
    }
    sendRequest(debouncedInputs, settings);
  }, [debouncedInputs, settings, sendRequest, setPipelineDirty]);

  // Manual-run effect: fires when the user clicks "Run pipeline".
  // manualRunTick is only incremented by triggerManualRun() in the store.
  //
  // `settings` is read through a ref rather than closed over. The effect depends
  // only on the tick, so relying on the closure made "which settings does a
  // manual run use?" depend on which render last re-created this effect — and
  // required suppressing the exhaustive-deps lint to say so.
  useEffect(() => {
    if (manualRunTick === 0) return; // skip the initial mount
    sendRequest(liveInputsRef.current, settingsRef.current);
  }, [manualRunTick, sendRequest]);
}
