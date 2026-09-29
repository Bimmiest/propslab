import { useCallback, useEffect, useRef, useMemo, type RefObject } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useDebounce } from './useDebounce';
import { PIPELINE_DEBOUNCE_MS, createManagedWorker, type ManagedWorker } from './workerLifecycle';
import type { PipelineWorkerRequest, PipelineWorkerResponse } from '../engine/pipelineWorker';
import type { EventMetadata } from '../engine/types';
import { toViewResult } from '../utils/viewResult';

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
// `createManagedWorker`. This hook's policy on top of it:
//
// - Timeout: terminal error, and the input is not retried. The watchdog only
//   runs once the worker has loaded, so a slow load is a load failure, below.
// - Crash (the worker had loaded): replay once on the replacement, then a
//   terminal error. A crashed input is never run inline: on the tab's own
//   thread it would have no watchdog.
// - Load failure (it had not): resend, uncharged — no code saw the request.
//   Past MAX_WORKER_LOAD_FAILURES no worker is built and requests run inline,
//   which is what the inline fallback is for. `new Worker` does not throw when
//   its chunk cannot be fetched, so the cap is what stops such a worker being
//   rebuilt forever.

/** Where the latest request got to, for deciding what the load-failure cap may re-run. */
type LatestState =
  /** Posted and not settled. */
  | 'running'
  /** Answered, or run inline. */
  | 'done'
  /** Hung or crashed a worker that had loaded: never to be run inline. */
  | 'poisoned'
  /** Timed out before its worker had loaded, so no code ever ran it. */
  | 'unrun';

interface LatestRequest {
  request: PipelineWorkerRequest;
  state: LatestState;
  /**
   * It crashed a worker. Sticky, unlike `state` and the retry count, so no
   * later turn of its replay (a timeout, a load failure) can clear the way to
   * running it inline (#421).
   */
  crashed: boolean;
}

/** The inputs a run was made with, to tell whether the editors have moved on since. */
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

/** The hook's request bookkeeping, shared with the worker callbacks below. */
interface PipelineRefs {
  requestIdRef: RefObject<number>;
  requestStartRef: RefObject<number>;
  /** Not reset per request — see the note in sendRequest. */
  retryCountRef: RefObject<number>;
  latestRef: RefObject<LatestRequest | null>;
}

type AppState = ReturnType<typeof useAppStore.getState>;

/** Where the worker callbacks deliver results, and how they run a request inline. */
interface PipelineSinks extends Pick<
  AppState,
  'setIsProcessing' | 'setLastProcessingMs' | 'setProcessingResult' | 'setValidationDiagnostics'
> {
  runInline: (request: PipelineWorkerRequest) => void;
}

/** The worker callbacks' shared state: refs, sinks, and the worker they belong to. */
interface WorkerPolicy extends PipelineRefs, PipelineSinks {
  managed: ManagedWorker<PipelineWorkerRequest>;
}

function report(p: WorkerPolicy, message: string): void {
  p.setIsProcessing(false);
  p.setProcessingResult(null);
  p.setValidationDiagnostics([{ level: 'error', message, file: 'props.conf' }]);
}

/**
 * Stop on the latest request for good: it hung or crashed a worker, so it
 * is neither replayed again nor ever run inline.
 */
function giveUp(p: WorkerPolicy, message: string): void {
  p.retryCountRef.current = 0;
  if (p.latestRef.current) p.latestRef.current.state = 'poisoned';
  report(p, message);
}

const NO_REPLACEMENT_AFTER_CRASH = 'Worker crashed while processing this input, and no replacement worker could be started to retry it. Processing was stopped — try reducing the input size or simplifying your patterns.';

/**
 * Finish the latest request on the tab's own thread, where no worker can be
 * had — unless it crashed one: then it stops for good instead (#326, #421).
 */
function finishInline(p: WorkerPolicy, request: PipelineWorkerRequest): void {
  if (p.latestRef.current?.crashed) {
    giveUp(p, NO_REPLACEMENT_AFTER_CRASH);
    return;
  }
  p.runInline(request);
}

function onResponse(p: WorkerPolicy, { id, result, error }: PipelineWorkerResponse): void {
  if (id !== p.requestIdRef.current) return;
  p.setIsProcessing(false);
  useAppStore.getState().setPipelineOnMainThread(false);
  p.setLastProcessingMs(performance.now() - p.requestStartRef.current);
  // This request completed cleanly — it is not poison, so clear the retry
  // budget.
  p.retryCountRef.current = 0;
  if (p.latestRef.current) p.latestRef.current.state = 'done';

  if (error || !result) {
    p.setProcessingResult(null);
    p.setValidationDiagnostics([{
      level: 'error',
      message: `Pipeline error: ${error ?? 'Unknown error'}`,
      file: 'props.conf',
    }]);
    return;
  }

  p.setProcessingResult(result.result);
  p.setValidationDiagnostics(result.diagnostics);
}

function onTimeout(p: WorkerPolicy, request: PipelineWorkerRequest, loaded: boolean): void {
  if (request.id !== p.requestIdRef.current) return;
  if (!loaded) {
    // The worker never started, so this run says nothing about the input's
    // patterns: run it once the replacement has loaded. Nor does it undo an
    // earlier crash, so the retry count stands, and a replay is not 'unrun'.
    const latest = p.latestRef.current;
    if (latest && !latest.crashed) latest.state = 'unrun';
    if (!p.managed.postWhenReady(request)) finishInline(p, request);
    return;
  }
  giveUp(p, `Pipeline timed out after ${WORKER_TIMEOUT_MS / 1000} s — a regex may be backtracking heavily on every event. Try simplifying your EXTRACT or TRANSFORMS pattern, or lowering its MATCH_LIMIT.`);
}

function onCrash(p: WorkerPolicy, inFlight: PipelineWorkerRequest[], message: string): void {
  const pending = inFlight.find((r) => r.id === p.requestIdRef.current);
  if (!pending) {
    // Nothing of ours was running, so there is no input to blame — but
    // the preview's worker died, and saying nothing would leave a
    // result on screen that nothing can refresh until the next edit.
    report(p, `Worker error: ${message || 'unknown error'}`);
    return;
  }
  if (p.latestRef.current?.request.id === pending.id) p.latestRef.current.crashed = true;
  // Restart once and replay — covers a transient worker crash. The
  // lifecycle arms a fresh watchdog for the replay, so a retry that also
  // hangs cannot leave isProcessing stuck.
  if (p.retryCountRef.current < MAX_WORKER_RETRIES && p.managed.post(pending)) {
    p.retryCountRef.current += 1;
    p.setIsProcessing(true);
    return;
  }
  // Out of retries, or no replacement could be built: either way the
  // input crashed a worker, and it is never finished inline, where it could
  // take the tab's own thread down. Later requests still reach
  // `sendRequest`, which runs them inline if no worker can be had.
  giveUp(
    p,
    `Worker crashed ${p.retryCountRef.current > 0 ? 'repeatedly ' : ''}while processing this input: ${message || 'unknown error'}. Processing was stopped — try reducing the input size or simplifying your patterns.`,
  );
}

function onLoadFailure(p: WorkerPolicy, inFlight: PipelineWorkerRequest[], capped: boolean): void {
  const pending = inFlight.find((r) => r.id === p.requestIdRef.current);
  if (!pending) {
    // Nothing in flight, so nothing to report — a "Worker error" here would
    // repaint the diagnostics on every refetch. But once the cap is reached
    // no worker will come to run the latest input, so if no code has run it
    // yet, run it here rather than leave the preview on a timeout until the
    // next edit.
    const latest = p.latestRef.current;
    if (capped && latest?.state === 'unrun' && latest.request.id === p.requestIdRef.current) {
      finishInline(p, latest.request);
    }
    return;
  }
  // Resend without charging the retry budget: no code saw it.
  if (p.managed.post(pending)) {
    p.setIsProcessing(true);
    return;
  }
  // Out of workers. A request that has not crashed anything finishes
  // inline, but one on its replay already crashed a worker, and the
  // replacement merely failing to load does not make it safe to run on
  // the tab's own thread.
  if (p.retryCountRef.current > 0) {
    giveUp(p, NO_REPLACEMENT_AFTER_CRASH);
    return;
  }
  finishInline(p, pending);
}

/**
 * Build the pipeline's managed worker with this hook's policy. `sendRequest`
 * forgets every earlier request, so the one request these callbacks are handed
 * is always the latest.
 */
function createPipelineWorker(refs: PipelineRefs, sinks: PipelineSinks): ManagedWorker<PipelineWorkerRequest> {
  // The callbacks close over `policy`, which exists before any of them can fire.
  const managed = createManagedWorker<PipelineWorkerRequest, PipelineWorkerResponse>({
    create: createWorker,
    timeoutMs: WORKER_TIMEOUT_MS,
    onResponse: (response) => onResponse(policy, response),
    onTimeout: (request, _others, loaded) => onTimeout(policy, request, loaded),
    onCrash: (inFlight, message) => onCrash(policy, inFlight, message),
    onLoadFailure: (inFlight, capped) => onLoadFailure(policy, inFlight, capped),
  });
  const policy: WorkerPolicy = { ...refs, ...sinks, managed };
  return managed;
}

/**
 * Run a request on the calling thread. The fallback for when a worker cannot
 * be constructed at all — no `Worker` (tests, SSR), a CSP that forbids worker
 * scripts, a failed chunk fetch — so the preview still produces output there
 * rather than sitting on "No data yet" with nothing to say why.
 * `useWorkerRequest` makes the same trade for the live-matching hooks.
 * A failed chunk fetch does not actually throw from `new Worker`; it surfaces
 * later as an `error` event, and reaches this path through the load-failure
 * cap instead. A request whose worker crashed never does.
 *
 * What is given up is the watchdog: a runaway regex here blocks the tab rather
 * than a worker. That is the cost of producing output at all in an environment
 * that will not run a worker, and the browsers this ships to always can.
 *
 * The engine is imported dynamically so the main bundle does not carry a
 * second copy of it for a path the browser normally never takes; the worker
 * chunk already has one.
 */
function runPipelineInline(
  request: PipelineWorkerRequest,
  refs: PipelineRefs,
  sinks: Omit<PipelineSinks, 'runInline'>,
): void {
  sinks.setIsProcessing(true);
  // For the status bar: no watchdog covers this run (#403).
  useAppStore.getState().setPipelineOnMainThread(true);
  import('../engine/pipeline')
    .then(({ runPipeline }) => {
      if (request.id !== refs.requestIdRef.current) return; // superseded while loading
      if (refs.latestRef.current?.request === request) refs.latestRef.current.state = 'done';
      const output = runPipeline(
        request.rawData,
        request.metadata,
        request.propsConfText,
        request.transformsConfText,
        request.options,
      );
      sinks.setLastProcessingMs(performance.now() - refs.requestStartRef.current);
      sinks.setProcessingResult(toViewResult(output.result));
      sinks.setValidationDiagnostics(output.diagnostics);
    })
    .catch((err: unknown) => {
      if (request.id !== refs.requestIdRef.current) return;
      sinks.setProcessingResult(null);
      sinks.setValidationDiagnostics([{
        level: 'error',
        message: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
        file: 'props.conf',
      }]);
    })
    .finally(() => {
      if (request.id === refs.requestIdRef.current) sinks.setIsProcessing(false);
    });
}

/**
 * Ctrl/Cmd+Enter runs the pipeline in manual-apply mode, wherever focus is
 * (#492). Capture phase, and the event stops here, as for the command palette's
 * Ctrl+K: Monaco binds Ctrl+Enter ("insert line below") on its own element. In
 * auto mode there is nothing to run, so the key is left to the editor.
 */
function useRunShortcut(manualApply: boolean): void {
  useEffect(() => {
    if (!manualApply) return;
    function onKeyDown(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey) || e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      // The status bar's Run button is disabled mid-run; so is this.
      const state = useAppStore.getState();
      if (!e.repeat && !state.isProcessing) state.triggerManualRun();
    }
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [manualApply]);
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
  useRunShortcut(settings.manualApply);

  const workerRef = useRef<ManagedWorker<PipelineWorkerRequest> | null>(null);
  const requestIdRef = useRef(0);
  const latestRef = useRef<LatestRequest | null>(null);
  const requestStartRef = useRef<number>(0);
  // Not reset per request — see the note in sendRequest.
  const retryCountRef = useRef(0);
  // What the last request was made with. In manual-apply mode the pipeline is
  // dirty when the settled inputs differ from these, not merely because the
  // inputs changed.
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

  const runInline = useCallback((request: PipelineWorkerRequest) => {
    runPipelineInline(
      request,
      { requestIdRef, requestStartRef, retryCountRef, latestRef },
      { setIsProcessing, setLastProcessingMs, setProcessingResult, setValidationDiagnostics },
    );
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

    // Answers to earlier requests are stale now. The worker is still running
    // them, so they keep their watchdogs, and this request's starts when the
    // worker reaches it: an edit mid-run must not charge the new input
    // for the old one's run time.
    const managed = workerRef.current;
    managed?.forget();
    latestRef.current = { request, state: 'running', crashed: false };

    // The retry budget spans requests: it is cleared when a request completes
    // cleanly or the pipeline gives up on one, never by a new request. See
    // docs/adr/0014-pipeline-worker-failure-policy.md.
    if (managed?.post(request)) {
      setIsProcessing(true);
      return;
    }
    runInline(request);
  }, [runInline, setIsProcessing]);

  // Build the worker once; the lifecycle rebuilds it after a failure.
  useEffect(() => {
    const managed = createPipelineWorker(
      { requestIdRef, requestStartRef, retryCountRef, latestRef },
      { setIsProcessing, setLastProcessingMs, setProcessingResult, setValidationDiagnostics, runInline },
    );
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
  // comparing the settled inputs with the ones the last run used — not on
  // every debounced change, or typing and clicking "Run" within the debounce
  // window would re-raise the flag for inputs that run already used.
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
  // `settings` is read through a ref: the effect depends only on the tick, and
  // a manual run uses the settings current at the click.
  useEffect(() => {
    if (manualRunTick === 0) return; // skip the initial mount
    sendRequest(liveInputsRef.current, settingsRef.current);
    // `triggerManualRun` already cleared the flag, but when the debounce settles
    // in the same commit as the click the effect above ran first, against the
    // previous run's inputs. This run used the live inputs, so nothing is
    // pending.
    setPipelineDirty(false);
  }, [manualRunTick, sendRequest, setPipelineDirty]);
}
