import { useEffect, useMemo, useRef, useState } from 'react';
import { useWorkerRequest } from './useWorkerRequest';
import { probeTimestamps } from '../engine/timestampMatch';
import type { TimeConfig, TimestampProbe } from '../engine/timestampMatch';
import type { TimestampMatchResponse } from '../engine/timestampMatchWorker';

const createWorker = () =>
  new Worker(new URL('../engine/timestampMatchWorker.ts', import.meta.url), { type: 'module' });

// Matches the Regex tab's tester: this re-runs whenever props.conf changes, so a
// runaway TIME_PREFIX should be cut quickly rather than held for the pipeline's 5 s.
const TIMESTAMP_TIMEOUT_MS = 2_000;

export type TimestampMatchStatus = 'idle' | 'pending' | 'ok' | 'timeout' | 'error';

export interface TimestampMatchState {
  status: TimestampMatchStatus;
  /**
   * Per-event probes aligned to `raws`. While `pending` these may be the
   * previous config's probes for the same events, never another page's (#316).
   */
  probes: TimestampProbe[];
  /** Why probing threw, when status is 'error' (#322). */
  error: string | null;
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

/**
 * Probes tagged with the request that produced them, so a result is never
 * drawn against events it was not computed for (#316). `error` travels in the
 * data of an 'ok' outcome rather than as 'invalid', because `useWorkerRequest`
 * swaps an 'invalid' outcome's data for `empty` and the message would go too.
 */
interface Probed {
  request: Request | null;
  probes: TimestampProbe[];
  error: string | null;
}

const EMPTY: TimestampProbe[] = [];
const EMPTY_PROBED: Probed = { request: null, probes: EMPTY, error: null };

function sameTimeConfig(a: TimeConfig, b: TimeConfig): boolean {
  return (
    a.timePrefix === b.timePrefix &&
    a.timeFormat === b.timeFormat &&
    a.maxLookahead === b.maxLookahead &&
    a.tz === b.tz &&
    (a.tzAlias ?? null) === (b.tzAlias ?? null) &&
    a.now === b.now
  );
}

export function useTimestampMatch(raws: string[], config: TimeConfig): TimestampMatchState {
  // Compared by value, not identity. The tab rebuilds its config whenever
  // props.conf changes at all, and keyed on identity every keystroke — even in
  // a stanza that has nothing to do with time — re-posted the whole page to
  // the worker (#316). Adjusted during render, as React recommends for state
  // derived from props, so the request below sees it in the same pass.
  const [stableConfig, setStableConfig] = useState(config);
  if (!sameTimeConfig(stableConfig, config)) setStableConfig(config);

  const request = useMemo<Request>(() => ({ raws, config: stableConfig }), [raws, stableConfig]);

  // The request in flight. The worker's response carries only its id, and
  // `useWorkerRequest` drops every response but the latest request's, so what
  // `interpret` sees answers the request posted last. Read in the worker's
  // message handler, never during render.
  const postedRef = useRef<Request | null>(null);

  const { status, data, run } = useWorkerRequest<Request, TimestampMatchResponse, Probed>({
    createWorker,
    timeoutMs: TIMESTAMP_TIMEOUT_MS,
    empty: EMPTY_PROBED,
    interpret: (response) => ({
      status: 'ok',
      data:
        response.error !== undefined
          ? { request: postedRef.current, probes: EMPTY, error: response.error }
          : { request: postedRef.current, probes: response.probes, error: null },
    }),
    runInline: (req) => {
      try {
        return { status: 'ok', data: { request: req, probes: probeTimestamps(req.raws, req.config), error: null } };
      } catch (err) {
        return {
          status: 'ok',
          data: { request: req, probes: EMPTY, error: err instanceof Error ? err.message : String(err) },
        };
      }
    },
    isIdle: ({ raws: r }) => r.length === 0,
  });

  useEffect(() => {
    postedRef.current = request;
    run(request);
  }, [request, run]);

  // Probing has no "the input was rejected" outcome — `interpret` and
  // `runInline` above both return `ok` — so `invalid` is unreachable here. Mapped
  // rather than cast, so the narrower public status stays a fact about this hook
  // instead of an assertion about the shared one.
  if (status === 'invalid' || status === 'timeout') return { status: 'timeout', probes: EMPTY, error: null };
  if (status === 'idle') return { status, probes: EMPTY, error: null };

  // Probes are only ever returned for the events they were computed from. While
  // a new page is pending, `data` still holds the previous page's probes, and
  // drawing those offsets over different text highlighted arbitrary spans (#316).
  // For the same events under a changed config they are kept, marked pending,
  // so the highlights do not flicker off on every edit.
  const samePage = data.request?.raws === raws;
  const current = data.request === request;
  if (status === 'ok' && current && data.error !== null) {
    return { status: 'error', probes: EMPTY, error: data.error };
  }
  return {
    status: status === 'ok' && current ? 'ok' : 'pending',
    probes: samePage && data.error === null ? data.probes : EMPTY,
    error: null,
  };
}
