import { useCallback, useEffect, useRef, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDebounce } from './useDebounce';
import { PIPELINE_DEBOUNCE_MS, createManagedWorker, type ManagedWorker } from './workerLifecycle';
import type { PipelineWorkerRequest, PipelineWorkerResponse } from '../engine/pipelineWorker';
import type { EventMetadata } from '../engine/types';

// Vite worker import — bundled as a separate chunk
const createWorker = () =>
  new Worker(new URL('../engine/pipelineWorker.ts', import.meta.url), { type: 'module' });

const WORKER_TIMEOUT_MS = 5_000;
// How many times a single request may restart the worker after a crash before we
// give up. A request that itself crashes the worker (e.g. OOM-sized input) would
// otherwise restart-and-replay forever; cap it so the loop terminates.
const MAX_WORKER_RETRIES = 1;

// The worker's own lifecycle — construction, the ready signal, the watchdog,
// crash-vs-load classification and the load-failure cap — is
// `createManagedWorker` (#339). This hook's policy on top of it:
//
// - Timeout: terminal error, and the input is not retried.
// - Crash (the worker had loaded): replay once on the replacement, then a
//   terminal error. A crashed input is never run inline (#326): #309 counted
//   crashes toward the load cap, so an input that crashed a few workers was
//   eventually run on the tab's own thread, with no watchdog.
// - Load failure (it had not): resend, uncharged — no code saw the request.
//   Past MAX_WORKER_LOAD_FAILURES no worker is built and requests run inline,
//   which is what the inline fallback is for (#309). `new Worker` does not
//   throw when its chunk cannot be fetched, and onerror used to rebuild such a
//   worker forever.
//
// Until #339 a load failure was guessed from whether the worker had answered,
// and the first worker never had: its request is posted in the same commit it
// is built. A script that threw at top level had the mount request reported
// as having "crashed repeatedly", the preview stayed empty until an edit, and
// the current input was never re-run inline once the cap was reached.

/** Where the latest request got to, for deciding what the load-failure cap may re-run. */
type LatestState =
  /** Posted and not settled. */
  | 'running'
  /** Answered, or run inline. */
  | 'done'
  /** Hung or crashed a worker that had loaded: never to be run inline (#326). */
  | 'poisoned'
  /** Timed out before its worker had loaded, so no code ever ran it. */
  | 'unrun';

/** The inputs a run was made with, to tell whether the editors have moved on since (#335). */
interface RunInputs {
  rawData: string;
  metadata: EventMetadata;
  propsConf: string;
  transformsConf: string;
  perEventPipeline: boolean;
}

function sameRunInputs(a: RunInputs, b: RunInputs): boolean {
  return (
    a.rawData === b.rawData &&
    a.propsConf === b.propsConf &&
    a.transformsConf === b.transformsConf &&
    a.perEventPipeline === b.perEventPipeline &&
    // Field by field: editing one metadata field replaces the whole object.
    a.metadata.index === b.metadata.index &&
    a.metadata.host === b.metadata.host &&
    a.metadata.source === b.metadata.source &&
    a.metadata.sourcetype === b.metadata.sourcetype
  );
}

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

  const workerRef = useRef<ManagedWorker<PipelineWorkerRequest> | null>(null);
  const requestIdRef = useRef(0);
  const latestRef = useRef<{ request: PipelineWorkerRequest; state: LatestState } | null>(null);
  const requestStartRef = useRef<number>(0);
  // Not reset per request — see the note in sendRequest.
  const retryCountRef = useRef(0);
  // What the last request was made with. In manual-apply mode the pipeline is
  // dirty when the settled inputs differ from these, not merely because the
  // inputs changed (#335).
  const lastRunRef = useRef<RunInputs | null>(null);
  // Latest settings, for the manual-run effect (which depends only on the tick).
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

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
  // later as an `error` event, and reaches this path through the load-failure
  // cap instead (#309). A request whose worker crashed never does (#326).
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
        if (latestRef.current?.request === request) latestRef.current.state = 'done';
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
    lastRunRef.current = { ...inputs, perEventPipeline: opts.perEventPipeline };

    const request: PipelineWorkerRequest = {
      id,
      rawData: inputs.rawData,
      metadata: inputs.metadata,
      propsConfText: inputs.propsConf,
      transformsConfText: inputs.transformsConf,
      options: { perEventPipeline: opts.perEventPipeline },
    };

    // Answers to earlier requests are stale now; their watchdogs go with them.
    // If one of them hangs, this request's watchdog is what reaps it.
    const managed = workerRef.current;
    managed?.forget();
    latestRef.current = { request, state: 'running' };

    // The retry budget is NOT reset here. Resetting per request meant a worker
    // that had just crashed got a fresh budget from the next keystroke, so the
    // "cap the restart loop" invariant this file documents was never actually
    // bounded across requests — interleaved auto-run and manual traffic could
    // restart the worker indefinitely. It is cleared where it should be: when a
    // request completes cleanly, or when the pipeline gives up on one.
    if (managed?.post(request)) {
      setIsProcessing(true);
      return;
    }
    runInline(request);
  }, [runInline, setIsProcessing]);

  // Build the worker once; the lifecycle rebuilds it after a failure.
  useEffect(() => {
    const report = (message: string) => {
      setIsProcessing(false);
      setProcessingResult(null);
      setValidationDiagnostics([{ level: 'error', message, file: 'props.conf' }]);
    };
    // Stop on the latest request for good: it hung or crashed a worker, so it
    // is neither replayed again nor ever run inline (#326).
    const giveUp = (message: string) => {
      retryCountRef.current = 0;
      if (latestRef.current) latestRef.current.state = 'poisoned';
      report(message);
    };
    const crashedMessage = (detail: string) =>
      `Worker crashed ${retryCountRef.current > 0 ? 'repeatedly ' : ''}while processing this input: ${detail || 'unknown error'}. Processing was stopped — try reducing the input size or simplifying your patterns.`;

    // `sendRequest` forgets every earlier request, so the one request these
    // callbacks are handed is always the latest.
    const managed = createManagedWorker<PipelineWorkerRequest, PipelineWorkerResponse>({
      create: createWorker,
      timeoutMs: WORKER_TIMEOUT_MS,

      onResponse({ id, result, error }) {
        if (id !== requestIdRef.current) return;
        setIsProcessing(false);
        setLastProcessingMs(performance.now() - requestStartRef.current);
        // This request completed cleanly — it is not poison, so clear the retry
        // budget.
        retryCountRef.current = 0;
        if (latestRef.current) latestRef.current.state = 'done';

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
      },

      onTimeout(request, _others, loaded) {
        if (request.id !== requestIdRef.current) return;
        retryCountRef.current = 0;
        if (!loaded) {
          // The worker never started, so the input never ran and says nothing
          // about ReDoS. It is left runnable: if the workers that follow fail
          // to load as well, the cap re-runs it inline (see onLoadFailure).
          if (latestRef.current) latestRef.current.state = 'unrun';
          report(`Pipeline timed out after ${WORKER_TIMEOUT_MS / 1000} s waiting for its worker to start, so the input never ran.`);
          return;
        }
        giveUp(`Pipeline timed out after ${WORKER_TIMEOUT_MS / 1000} s — the input may contain a regex prone to catastrophic backtracking (ReDoS). Try simplifying your EXTRACT or TRANSFORMS pattern.`);
      },

      onCrash(inFlight, message) {
        const pending = inFlight.find((r) => r.id === requestIdRef.current);
        if (!pending) {
          // Nothing of ours was running, so there is no input to blame — but
          // the preview's worker died, and saying nothing would leave a
          // result on screen that nothing can refresh until the next edit.
          report(`Worker error: ${message || 'unknown error'}`);
          return;
        }
        // Restart once and replay — covers a transient worker crash. The
        // lifecycle arms a fresh watchdog for the replay, so a retry that also
        // hangs cannot leave isProcessing stuck.
        if (retryCountRef.current < MAX_WORKER_RETRIES && managed.post(pending)) {
          retryCountRef.current += 1;
          setIsProcessing(true);
          return;
        }
        // Out of retries, or no replacement could be built: either way the
        // input crashed a worker, and it is never finished inline — it once
        // was when the constructor threw here, which put the one input known
        // to take a thread down onto the tab's own (#326). Later requests
        // still reach `sendRequest`, which runs them inline if no worker can
        // be had.
        giveUp(crashedMessage(message));
      },

      onLoadFailure(inFlight, capped) {
        const pending = inFlight.find((r) => r.id === requestIdRef.current);
        if (!pending) {
          // Nothing in flight, so nothing to report — writing "Worker error"
          // here is what repainted the diagnostics on every refetch (#309).
          // But once the cap is reached no worker will come to run the latest
          // input, so if no code has run it yet, run it here rather than leave
          // the preview on a timeout until the next edit (#339).
          const latest = latestRef.current;
          if (capped && latest?.state === 'unrun' && latest.request.id === requestIdRef.current) {
            runInline(latest.request);
          }
          return;
        }
        // Resend without charging the retry budget: no code saw it.
        if (managed.post(pending)) {
          setIsProcessing(true);
          return;
        }
        // Out of workers. A request that has not crashed anything finishes
        // inline, but one on its replay already crashed a worker, and the
        // replacement merely failing to load does not make it safe to run on
        // the tab's own thread (#326).
        if (retryCountRef.current > 0) {
          giveUp('Worker crashed while processing this input, and no replacement worker could be started to retry it. Processing was stopped — try reducing the input size or simplifying your patterns.');
          return;
        }
        runInline(pending);
      },
    });

    workerRef.current = managed;
    managed.ensure();

    return () => {
      managed.dispose();
      workerRef.current = null;
    };
  }, [runInline, setIsProcessing, setProcessingResult, setValidationDiagnostics, setLastProcessingMs]);

  const inputs = useMemo(
    () => ({ rawData, metadata, propsConf, transformsConf }),
    [rawData, metadata, propsConf, transformsConf],
  );

  const debouncedInputs = useDebounce(inputs, PIPELINE_DEBOUNCE_MS);

  // Auto-run effect: fires on debounced input changes when manual apply is OFF.
  //
  // In manual-apply mode it only decides whether there is anything to apply, by
  // comparing the settled inputs with the ones the last run used. It used to
  // set the flag on every debounced change, so typing and clicking "Run"
  // within the debounce window went: the run clears the flag, the debounce
  // settles on the very inputs that run used, the flag comes back — and the
  // status bar offered to apply changes that had already been applied (#335).
  useEffect(() => {
    if (settings.manualApply) {
      const last = lastRunRef.current;
      setPipelineDirty(
        last === null ||
          !sameRunInputs(last, { ...debouncedInputs, perEventPipeline: settings.perEventPipeline }),
      );
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
    // `triggerManualRun` already cleared the flag, but when the debounce settles
    // in the same commit as the click the effect above ran first, against the
    // previous run's inputs. This run used the live inputs, so nothing is
    // pending (#335).
    setPipelineDirty(false);
  }, [manualRunTick, sendRequest, setPipelineDirty]);
}
