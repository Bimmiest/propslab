import { useEffect } from 'react';
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
}

interface Request {
  pattern: string;
  inputs: string[];
}

const EMPTY: (RegexMatchInfo | null)[] = [];

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
  const { status, data, run } = useWorkerRequest<Request, RegexMatchResponse, (RegexMatchInfo | null)[]>({
    createWorker,
    timeoutMs: REGEX_TIMEOUT_MS,
    empty: EMPTY,
    interpret: (response) =>
      response.results === null
        ? { status: 'invalid', data: EMPTY }
        : { status: 'ok', data: response.results },
    runInline: ({ pattern: pat, inputs: inp }) => {
      const out = matchInputs(pat, inp);
      return out === null ? { status: 'invalid', data: EMPTY } : { status: 'ok', data: out };
    },
    isIdle: ({ pattern: pat }) => !pat,
  });

  const debouncedPattern = useDebounce(pattern, 250);

  useEffect(() => {
    run({ pattern: debouncedPattern, inputs });
  }, [debouncedPattern, inputs, run]);

  return { status, results: data };
}
