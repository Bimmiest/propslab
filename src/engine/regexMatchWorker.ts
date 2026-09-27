/**
 * Web Worker entry point for the Regex-tab live tester.
 *
 * Runs user-supplied regex matching off the main thread: PCRE's limits bound
 * each match, and the caller's watchdog bounds the whole run, terminating THIS
 * worker rather than freezing the UI tab.
 *
 * Message protocol:
 *   in  → WorkerInitMessage first, with the compiled regex engine; then RegexMatchRequest
 *   out → WORKER_READY once, when the engine is instantiated (#339); then RegexMatchResponse
 */

import { matchInputs } from './regexMatch';
import type { RegexMatchInfo } from './regexMatch';
import { initRegexEngineSync } from '../utils/splunkRegex';
import { isWorkerInitMessage, WORKER_READY, type WorkerInitMessage } from './workerProtocol';

export interface RegexMatchRequest {
  id: number;
  pattern: string;
  inputs: string[];
}

export interface RegexMatchResponse {
  id: number;
  /** Per-input results, or null when the pattern does not compile. */
  results: (RegexMatchInfo | null)[] | null;
}

self.onmessage = (e: MessageEvent<RegexMatchRequest | WorkerInitMessage>) => {
  if (isWorkerInitMessage(e.data)) {
    // The page's first message: the engine it compiled once. Ready follows
    // only once it is instantiated; a throw here is a failure to load (#339).
    initRegexEngineSync(e.data.regexEngine);
    self.postMessage(WORKER_READY);
    return;
  }
  const { id, pattern, inputs } = e.data;
  const results = matchInputs(pattern, inputs);
  const response: RegexMatchResponse = { id, results };
  self.postMessage(response);
};
