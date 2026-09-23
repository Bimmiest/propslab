import { useEffect } from 'react';
import { useWorkerRequest } from './useWorkerRequest';
import { probeTimestamps } from '../engine/timestampMatch';
import type { TimeConfig, TimestampProbe } from '../engine/timestampMatch';
import type { TimestampMatchResponse } from '../engine/timestampMatchWorker';

const createWorker = () =>
  new Worker(new URL('../engine/timestampMatchWorker.ts', import.meta.url), { type: 'module' });

// Matches the Regex tab's tester: this re-runs whenever props.conf changes, so a
// runaway TIME_PREFIX should be cut quickly rather than held for the pipeline's 5 s.
const TIMESTAMP_TIMEOUT_MS = 2_000;

export type TimestampMatchStatus = 'idle' | 'pending' | 'ok' | 'timeout';

export interface TimestampMatchState {
  status: TimestampMatchStatus;
  /** Per-event probes aligned to `raws`; empty unless status is 'ok'. */
  probes: TimestampProbe[];
}

/**
 * Probe events for their timestamp in a terminatable Web Worker.
 *
 * TIME_PREFIX is a user-supplied regex, and `safeRegex`'s heuristic is explicit
 * that it does not catch alternation-overlap forms. Executed synchronously in a
 * `useMemo` on the render path there was nothing to terminate — a permitted but
 * ambiguous pattern froze the tab for tens of seconds with no diagnostic. Here it
 * only hangs the worker, which the watchdog kills and restarts.
 *
 * The lifecycle around that — construction, staleness, watchdog, teardown —
 * lives in `useWorkerRequest` (#151).
 *
 * Where `Worker` is unavailable (tests / SSR) it falls back to probing on the
 * calling thread; the browser always has a worker and uses the safe path.
 *
 * `raws` must be referentially stable (memoise it in the caller) so a probe only
 * re-runs when the events or the config actually change.
 */

interface Request {
  raws: string[];
  config: TimeConfig;
}

const EMPTY: TimestampProbe[] = [];

export function useTimestampMatch(raws: string[], config: TimeConfig): TimestampMatchState {
  const { status, data, run } = useWorkerRequest<Request, TimestampMatchResponse, TimestampProbe[]>({
    createWorker,
    timeoutMs: TIMESTAMP_TIMEOUT_MS,
    empty: EMPTY,
    interpret: (response) => ({ status: 'ok', data: response.probes }),
    runInline: ({ raws: r, config: c }) => ({ status: 'ok', data: probeTimestamps(r, c) }),
    isIdle: ({ raws: r }) => r.length === 0,
  });

  useEffect(() => {
    run({ raws, config });
  }, [raws, config, run]);

  // Probing has no "the input was rejected" outcome — `interpret` and
  // `runInline` above both return `ok` — so `invalid` is unreachable here. Mapped
  // rather than cast, so the narrower public status stays a fact about this hook
  // instead of an assertion about the shared one.
  return { status: status === 'invalid' ? 'timeout' : status, probes: data };
}
