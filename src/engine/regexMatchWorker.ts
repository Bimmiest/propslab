/**
 * Web Worker entry point for the Regex-tab live tester.
 *
 * Runs user-supplied regex matching off the main thread so a catastrophic
 * pattern that slips the ReDoS heuristic hangs THIS worker (which the caller
 * terminates via a watchdog) instead of freezing the UI tab.
 *
 * Message protocol:
 *   in  → RegexMatchRequest
 *   out → WORKER_READY once, when the module has loaded (#339); then RegexMatchResponse
 */

import { matchInputs } from './regexMatch';
import type { RegexMatchInfo } from './regexMatch';
import { WORKER_READY } from './workerProtocol';

export interface RegexMatchRequest {
  id: number;
  pattern: string;
  inputs: string[];
}

export interface RegexMatchResponse {
  id: number;
  /** Per-input results, or null when the pattern is invalid / ReDoS-refused. */
  results: (RegexMatchInfo | null)[] | null;
}

self.onmessage = (e: MessageEvent<RegexMatchRequest>) => {
  const { id, pattern, inputs } = e.data;
  const results = matchInputs(pattern, inputs);
  const response: RegexMatchResponse = { id, results };
  self.postMessage(response);
};

// Last, so it is only sent once every import above has evaluated and the
// handler is installed. Anything the worker throws before this point is a
// failure to load, not something a request did to it (#339).
self.postMessage(WORKER_READY);
