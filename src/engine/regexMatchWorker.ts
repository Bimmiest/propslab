/**
 * Web Worker entry point for the Regex-tab live tester.
 *
 * Runs user-supplied regex matching off the main thread: PCRE's limits bound
 * each match, and the caller's watchdog bounds the whole run, terminating THIS
 * worker rather than freezing the UI tab.
 *
 * Message protocol:
 *   in  → RegexMatchRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine; then RegexMatchResponse
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
  /** Per-input results, or null when the pattern does not compile or matching threw. */
  results: (RegexMatchInfo | null)[] | null;
  /**
   * Why matching threw, when it did. Caught here so the request is answered
   * rather than read as a timeout, and useRegexMatch treats it as it does a
   * pattern that will not compile: nothing to show, nothing to add.
   */
  error?: string;
}

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<RegexMatchRequest>(self, (request) => {
  const { id, pattern, inputs } = request;
  let response: RegexMatchResponse;
  try {
    response = { id, results: matchInputs(pattern, inputs) };
  } catch (err) {
    response = { id, results: null, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
});
