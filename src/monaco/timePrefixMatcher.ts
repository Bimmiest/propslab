// ---------------------------------------------------------------------------
// timePrefixMatcher.ts
// Runs the TIME_FORMAT hover's TIME_PREFIX match off the main thread (#334).
//
// The hover used to exec the user's TIME_PREFIX against the sample line on the
// main thread, bounded only by a 4 KB input cap. `safeRegex` is a structural
// heuristic that misses alternation-overlap shapes such as `(a|aa)+b`, and
// those blow up exponentially: 4 KB bounds nothing, and hovering froze the tab.
//
// This reuses the Timestamp tab's worker (`timestampMatchWorker.ts`) rather
// than adding one: a request with `timeFormat: null` asks it for the prefix
// span alone, compiled by the same `safeRegex` the engine uses. One worker is
// kept alive and shared by every hover; a watchdog terminates it when a match
// overruns, and the next request gets a fresh one. It is a plain module rather
// than `useWorkerRequest` because hover providers live outside React.
//
// There is deliberately no inline fallback. A worker that cannot load (a CSP
// block, a chunk gone after a redeploy, no `Worker` at all) makes the preview
// omit its sample line — running the prefix here instead is the bug.
// ---------------------------------------------------------------------------

import { isWorkerLoadFailure, MAX_WORKER_LOAD_FAILURES } from '../hooks/workerLifecycle';
import type { TimestampMatchRequest, TimestampMatchResponse } from '../engine/timestampMatchWorker';

/**
 * Watchdog budget for one hover's prefix match. Shorter than the Regex and
 * Timestamp tabs' 2 s: a hover is waited on with the mouse still, and a
 * prefix that needs more than this against at most 4 KB is pathological.
 */
export const TIME_PREFIX_TIMEOUT_MS = 1_000;

/** The subset of Monaco's `CancellationToken` this module needs. */
export interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested?: (listener: () => void) => { dispose(): void };
}

export type PrefixMatchOutcome =
  /** The prefix matched; the format is searched from `end`. */
  | { status: 'matched'; end: number }
  | { status: 'no-match' }
  /** The watchdog fired; the worker was terminated. */
  | { status: 'timed-out' }
  /** The worker ran the prefix and reported an error. */
  | { status: 'error'; message: string }
  /** No worker could be had. The caller omits the sample rather than run it here. */
  | { status: 'unavailable' }
  /** The caller's token was cancelled first. */
  | { status: 'cancelled' };

export type PrefixMatcher = (
  pattern: string,
  sample: string,
  token?: CancellationLike,
) => Promise<PrefixMatchOutcome>;

interface Pending {
  request: TimestampMatchRequest;
  /** Null once the caller cancelled: the entry stays so a hang is still reaped. */
  settle: ((outcome: PrefixMatchOutcome) => void) | null;
  timer: ReturnType<typeof setTimeout>;
  cancelSub: { dispose(): void } | undefined;
}

const createWorker = () =>
  new Worker(new URL('../engine/timestampMatchWorker.ts', import.meta.url), { type: 'module' });

let worker: Worker | null = null;
/** Whether the current worker has answered anything, i.e. is known to have loaded. */
let answered = false;
let loadFailures = 0;
let nextId = 1;
const pending = new Map<number, Pending>();

function finish(entry: Pending, outcome: PrefixMatchOutcome): void {
  clearTimeout(entry.timer);
  entry.cancelSub?.dispose();
  pending.delete(entry.request.id);
  entry.settle?.(outcome);
  entry.settle = null;
}

function discardWorker(): void {
  worker?.terminate();
  worker = null;
  answered = false;
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (typeof Worker === 'undefined' || loadFailures >= MAX_WORKER_LOAD_FAILURES) return null;
  let w: Worker;
  try {
    w = createWorker();
  } catch {
    loadFailures++;
    return null;
  }
  w.onmessage = (e: MessageEvent<TimestampMatchResponse>) => {
    if (w !== worker) return;
    answered = true;
    loadFailures = 0;
    const entry = pending.get(e.data.id);
    if (!entry) return;
    if (e.data.error !== undefined) {
      finish(entry, { status: 'error', message: e.data.error });
      return;
    }
    const prefix = e.data.probes[0]?.prefix ?? null;
    finish(entry, prefix ? { status: 'matched', end: prefix.end } : { status: 'no-match' });
  };
  w.onerror = (e: Event) => {
    if (w !== worker) return;
    const loadFailure = isWorkerLoadFailure(e, answered);
    if (loadFailure) loadFailures++;
    const message = (e as Partial<ErrorEvent>).message || 'the preview worker failed';
    discardWorker();
    // Nothing in flight is answered by a dead worker. A load failure is not
    // the pattern's fault, so the preview just goes quiet; a crash is reported.
    for (const entry of [...pending.values()]) {
      finish(entry, loadFailure ? { status: 'unavailable' } : { status: 'error', message });
    }
  };
  worker = w;
  return w;
}

function startWatchdog(id: number): ReturnType<typeof setTimeout> {
  return setTimeout(() => onTimeout(id), TIME_PREFIX_TIMEOUT_MS);
}

/**
 * The request `id` overran. Kill the worker, report the timeout, and replay
 * anything that was queued behind it on a fresh worker with a fresh budget —
 * those requests never ran, so they must not inherit the blame.
 */
function onTimeout(id: number): void {
  const entry = pending.get(id);
  if (!entry) return;
  discardWorker();
  finish(entry, { status: 'timed-out' });

  const queued = [...pending.values()];
  if (queued.length === 0) return;
  const fresh = ensureWorker();
  for (const q of queued) {
    clearTimeout(q.timer);
    if (!fresh || q.settle === null) {
      // Nothing to replay onto, or nobody is waiting for the answer.
      finish(q, { status: 'unavailable' });
      continue;
    }
    q.timer = startWatchdog(q.request.id);
    fresh.postMessage(q.request);
  }
}

/**
 * Where `pattern` (a TIME_PREFIX, PCRE as written) first matches in `sample`,
 * computed in the shared worker under a watchdog. Never runs the pattern on
 * the calling thread.
 */
export const matchTimePrefix: PrefixMatcher = (pattern, sample, token) => {
  if (token?.isCancellationRequested) return Promise.resolve({ status: 'cancelled' });
  const w = ensureWorker();
  if (!w) return Promise.resolve({ status: 'unavailable' });

  return new Promise<PrefixMatchOutcome>((resolve) => {
    const request: TimestampMatchRequest = {
      id: nextId++,
      raws: [sample],
      // `timeFormat: null` makes the prober stop after the prefix, which is all
      // the hover needs from it: the format side is a regex this app generates.
      config: { timePrefix: pattern, timeFormat: null, maxLookahead: 0, tz: null },
    };
    const entry: Pending = {
      request,
      settle: resolve,
      timer: startWatchdog(request.id),
      cancelSub: undefined,
    };
    // Cancelling answers the caller at once, but the entry keeps its watchdog:
    // if the abandoned match is the one that hangs, it is still reaped rather
    // than left blocking every later hover.
    entry.cancelSub = token?.onCancellationRequested?.(() => {
      entry.settle?.({ status: 'cancelled' });
      entry.settle = null;
    });
    pending.set(request.id, entry);
    w.postMessage(request);
  });
};

/** Test hook: drop the worker and all state, as on a fresh page load. */
export function resetTimePrefixMatcherForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer);
  pending.clear();
  discardWorker();
  loadFailures = 0;
  nextId = 1;
}
