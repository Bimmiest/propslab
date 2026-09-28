/**
 * Web Worker entry point for the Regex-tab live tester.
 *
 * Runs user-supplied regex matching off the main thread: PCRE's limits bound
 * each match, and the caller's watchdog bounds the whole run, terminating THIS
 * worker rather than freezing the UI tab.
 *
 * Message protocol:
 *   in  → RegexMatchRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine (#339); then RegexMatchResponse
 */

import { matchInputs } from './regexMatch';
import type { RegexMatchInfo } from './regexMatch';
import { serveWithRegexEngine } from '../utils/regexEngineLoader';

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

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<RegexMatchRequest>(self, (request) => {
  const { id, pattern, inputs } = request;
  const results = matchInputs(pattern, inputs);
  const response: RegexMatchResponse = { id, results };
  self.postMessage(response);
});
