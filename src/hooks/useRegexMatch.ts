import { useEffect, useRef } from 'react';
import { useDebounce } from './useDebounce';
import { useWorkerRequest } from './useWorkerRequest';
import { matchInputs } from '../engine/regexMatch';
import type { RegexMatchInfo } from '../engine/regexMatch';
import type { RegexMatchResponse } from '../engine/regexMatchWorker';

const createWorker = () =>
  new Worker(new URL('../engine/regexMatchWorker.ts', import.meta.url), { type: 'module' });

// Shorter than the main pipeline's 5 s: the live tester runs on every keystroke,
// so a runaway pattern should be cut quickly. A catastrophic regex hangs the
// worker (not the UI), and the watchdog terminates and restarts it.
const REGEX_TIMEOUT_MS = 2_000;

export type RegexMatchStatus = 'idle' | 'pending' | 'ok' | 'timeout' | 'invalid';

export interface RegexMatchState {
  status: RegexMatchStatus;
  /** Per-input match info aligned to `inputs`; empty unless status is 'ok'. */
  results: (RegexMatchInfo | null)[];
  /**
   * The pattern `status` and `results` describe. Matching runs on a debounced
   * copy of the pattern, so for a moment after each keystroke this trails the
   * pattern the caller passed; a caller that shows results beside the live
   * pattern compares the two and treats a mismatch as pending (#315).
   */
  pattern: string;
  /**
   * The inputs array `results` are aligned to — by identity, the very array a
   * caller passed. The request for new inputs is posted from an effect, so for
   * the commit in which the caller's inputs change (a pipeline re-run, a search
   * keystroke) `results` still index the previous array; a caller that indexes
   * them against its own data compares the two first (#329).
   */
  inputs: string[];
  /**
   * The most recent 'ok' outcome, kept while a newer request is pending, with
   * the pattern and inputs that produced it; null once a request went idle,
   * timed out or was invalid. Lets a caller keep showing settled results against
   * their own inputs while a re-run is in flight instead of flashing to pending
   * — provided it checks `settled.pattern` is still the one it wants (#329).
   */
  settled: Matched | null;
}

interface Request {
  pattern: string;
  inputs: string[];
}

/** Results tagged with the pattern and inputs that produced them (#315, #329). */
export interface Matched {
  pattern: string;
  inputs: string[];
  results: (RegexMatchInfo | null)[];
}

const EMPTY: (RegexMatchInfo | null)[] = [];
const EMPTY_INPUTS: string[] = [];
const EMPTY_MATCHED: Matched = { pattern: '', inputs: EMPTY_INPUTS, results: EMPTY };

/**
 * Match a Splunk regex against many inputs in a terminatable Web Worker.
 *
 * Unlike a synchronous `regex.exec` on the main thread, a catastrophic pattern
 * that slips the ReDoS heuristic only hangs the worker — the watchdog kills it,
 * restarts it, and reports `timeout`, so the Regex tab stays responsive. The
 * lifecycle around that lives in `useWorkerRequest` (#151).
 *
 * Where `Worker` is unavailable (tests / SSR) it falls back to matching on the
 * calling thread; the browser always has a worker and uses the safe path.
 *
 * `inputs` must be referentially stable (memoise it in the caller) so a match is
 * only re-run when the pattern or the events actually change.
 */
export function useRegexMatch(pattern: string, inputs: string[]): RegexMatchState {
  // The request in flight. The worker's response carries only the request id,
  // and `useWorkerRequest` drops every response but the latest request's, so
  // whatever `interpret` sees answers the request posted last. Read in the
  // worker's message handler, never during render.
  const postedRef = useRef<Request>({ pattern: '', inputs: EMPTY_INPUTS });

  const { status, data, run } = useWorkerRequest<Request, RegexMatchResponse, Matched>({
    createWorker,
    timeoutMs: REGEX_TIMEOUT_MS,
    empty: EMPTY_MATCHED,
    interpret: (response) =>
      response.results === null
        ? { status: 'invalid', data: EMPTY_MATCHED }
        : { status: 'ok', data: { ...postedRef.current, results: response.results } },
    runInline: ({ pattern: pat, inputs: inp }) => {
      const out = matchInputs(pat, inp);
      return out === null
        ? { status: 'invalid', data: EMPTY_MATCHED }
        : { status: 'ok', data: { pattern: pat, inputs: inp, results: out } };
    },
    isIdle: ({ pattern: pat }) => !pat,
  });

  const debouncedPattern = useDebounce(pattern, 250);

  useEffect(() => {
    const request = { pattern: debouncedPattern, inputs };
    postedRef.current = request;
    run(request);
  }, [debouncedPattern, inputs, run]);

  // Only an 'ok' outcome carries data to tag; the others (idle, pending,
  // timeout, invalid) all answer the most recent request, which is the
  // debounced pattern and the caller's inputs — at worst for the one commit
  // between those changing and the effect above posting them. While a request
  // is pending, `data` is still the previous 'ok' outcome (`useWorkerRequest`
  // only replaces it on an answer), which is what `settled` exposes.
  const ok = status === 'ok';
  return {
    status,
    results: ok ? data.results : EMPTY,
    pattern: ok ? data.pattern : debouncedPattern,
    inputs: ok ? data.inputs : inputs,
    settled: (ok || status === 'pending') && data !== EMPTY_MATCHED ? data : null,
  };
}
