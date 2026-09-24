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
// than `useWorkerRequest` because hover providers live outside React; the
// worker's lifecycle is the same `createManagedWorker` the hooks use (#339).
//
// There is deliberately no inline fallback. A worker that cannot load (a CSP
// block, a chunk gone after a redeploy, no `Worker` at all) makes the preview
// omit its sample line — running the prefix here instead is the bug.
//
// Several hovers can be in flight at once, and the worker runs them in order,
// so only the oldest was running when a worker hung or crashed. That one is
// reported; the rest never ran and are replayed on the fresh worker rather
// than blamed. Before #339 a crash reported every queued entry as an error
// while a hang replayed them, and a worker whose script threw at top level
// counted as a crash — uncapped — so every hover built a new worker and
// blamed its prefix.
// ---------------------------------------------------------------------------

import { createManagedWorker } from '../hooks/workerLifecycle';
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
  /** Null once the caller cancelled: the request stays in flight so a hang is still reaped. */
  settle: ((outcome: PrefixMatchOutcome) => void) | null;
  cancelSub: { dispose(): void } | undefined;
}

const createWorker = () =>
  new Worker(new URL('../engine/timestampMatchWorker.ts', import.meta.url), { type: 'module' });

let nextId = 1;
const pending = new Map<number, Pending>();

function finish(id: number, outcome: PrefixMatchOutcome): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  entry.cancelSub?.dispose();
  entry.settle?.(outcome);
  entry.settle = null;
}

/**
 * Post entries that were in flight behind a hang or a crash to the fresh
 * worker, with a fresh budget — they never ran, so they must not inherit the
 * blame. An entry nobody is waiting for any more is dropped instead.
 */
function replay(requests: TimestampMatchRequest[]): void {
  for (const request of requests) {
    if (!pending.get(request.id)?.settle) finish(request.id, { status: 'cancelled' });
    else if (!managed.post(request)) finish(request.id, { status: 'unavailable' });
  }
}

const managed = createManagedWorker<TimestampMatchRequest, TimestampMatchResponse>({
  create: createWorker,
  timeoutMs: TIME_PREFIX_TIMEOUT_MS,
  onResponse(response) {
    if (response.error !== undefined) {
      finish(response.id, { status: 'error', message: response.error });
      return;
    }
    const prefix = response.probes[0]?.prefix ?? null;
    finish(response.id, prefix ? { status: 'matched', end: prefix.end } : { status: 'no-match' });
  },
  onTimeout(request, others) {
    finish(request.id, { status: 'timed-out' });
    replay(others);
  },
  onCrash([running, ...queued], message) {
    if (running) finish(running.id, { status: 'error', message: message || 'the preview worker failed' });
    replay(queued);
  },
  // No code saw any of these, so none is the pattern's fault: the preview just
  // goes quiet, and past the cap no worker is built again this session (#309).
  onLoadFailure(inFlight) {
    for (const request of inFlight) finish(request.id, { status: 'unavailable' });
  },
});

/**
 * Where `pattern` (a TIME_PREFIX, PCRE as written) first matches in `sample`,
 * computed in the shared worker under a watchdog. Never runs the pattern on
 * the calling thread.
 */
export const matchTimePrefix: PrefixMatcher = (pattern, sample, token) => {
  if (token?.isCancellationRequested) return Promise.resolve({ status: 'cancelled' });

  const request: TimestampMatchRequest = {
    id: nextId++,
    raws: [sample],
    // `timeFormat: null` makes the prober stop after the prefix, which is all
    // the hover needs from it: the format side is a regex this app generates.
    config: { timePrefix: pattern, timeFormat: null, maxLookahead: 0, tz: null },
  };
  return new Promise<PrefixMatchOutcome>((resolve) => {
    const entry: Pending = { settle: resolve, cancelSub: undefined };
    pending.set(request.id, entry);
    if (!managed.post(request)) {
      finish(request.id, { status: 'unavailable' });
      return;
    }
    // Cancelling answers the caller at once, but the request stays in flight
    // under its watchdog: if the abandoned match is the one that hangs, it is
    // still reaped rather than left blocking every later hover.
    entry.cancelSub = token?.onCancellationRequested?.(() => {
      entry.settle?.({ status: 'cancelled' });
      entry.settle = null;
    });
  });
};

/** Test hook: drop the worker and all state, as on a fresh page load. */
export function resetTimePrefixMatcherForTests(): void {
  managed.dispose();
  for (const entry of pending.values()) entry.cancelSub?.dispose();
  pending.clear();
  nextId = 1;
}
