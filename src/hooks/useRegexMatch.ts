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
}

interface Request {
  pattern: string;
  inputs: string[];
}

/** Results tagged with the pattern that produced them (#315). */
interface Matched {
  pattern: string;
  results: (RegexMatchInfo | null)[];
}

const EMPTY: (RegexMatchInfo | null)[] = [];
const EMPTY_MATCHED: Matched = { pattern: '', results: EMPTY };

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
  // The pattern of the request in flight. The worker's response carries only
  // the request id, and `useWorkerRequest` drops every response but the latest
  // request's, so whatever `interpret` sees answers the pattern posted last.
  // Read in the worker's message handler, never during render.
  const postedPatternRef = useRef('');

  const { status, data, run } = useWorkerRequest<Request, RegexMatchResponse, Matched>({
    createWorker,
    timeoutMs: REGEX_TIMEOUT_MS,
    empty: EMPTY_MATCHED,
    interpret: (response) =>
      response.results === null
        ? { status: 'invalid', data: EMPTY_MATCHED }
        : { status: 'ok', data: { pattern: postedPatternRef.current, results: response.results } },
    runInline: ({ pattern: pat, inputs: inp }) => {
      const out = matchInputs(pat, inp);
      return out === null
        ? { status: 'invalid', data: EMPTY_MATCHED }
        : { status: 'ok', data: { pattern: pat, results: out } };
    },
    isIdle: ({ pattern: pat }) => !pat,
  });

  const debouncedPattern = useDebounce(pattern, 250);

  useEffect(() => {
    postedPatternRef.current = debouncedPattern;
    run({ pattern: debouncedPattern, inputs });
  }, [debouncedPattern, inputs, run]);

  // Only an 'ok' outcome carries data to tag; the others (idle, pending,
  // timeout, invalid) all answer the most recent request, which is the
  // debounced pattern — at worst for the one commit between the debounce
  // settling and the effect above posting it.
  return {
    status,
    results: data.results,
    pattern: status === 'ok' ? data.pattern : debouncedPattern,
  };
}
