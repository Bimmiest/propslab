/**
 * Web Worker entry point for the Regex-tab live tester.
 *
 * Runs user-supplied regex matching off the main thread: PCRE's limits bound
 * each match, and the caller's watchdog bounds the whole run, terminating THIS
 * worker rather than freezing the UI tab.
 *
 * Message protocol:
 *   in  → WorkerInputsMessage<string[]> (the events, once per set), RegexMatchRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine; then a
 *         RegexMatchResponse, or a WorkerSkippedResponse, per request
 */

import { matchInputs } from './regexMatch';
import type { RegexMatchInfo } from './regexMatch';
import { serveWithRegexEngine } from '../utils/regexEngineLoader';
import { createRequestQueue, type QueuedRequest, type WorkerInputsMessage, type WorkerSkippedResponse } from './workerProtocol';

export interface RegexMatchRequest extends QueuedRequest {
  pattern: string;
  /** The inputs, when not sent ahead in an inputs message named by `inputsId`. */
  inputs?: string[];
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

const serve = createRequestQueue<string[], RegexMatchRequest>({
  run: (request, sent) => {
    const { id, pattern } = request;
    let response: RegexMatchResponse;
    try {
      const inputs = request.inputs ?? sent;
      if (inputs === undefined) throw new Error('No inputs to match against');
      response = { id, results: matchInputs(pattern, inputs) };
    } catch (err) {
      response = { id, results: null, error: err instanceof Error ? err.message : String(err) };
    }
    self.postMessage(response);
  },
  skip: ({ id }) => self.postMessage({ id, skipped: true } satisfies WorkerSkippedResponse),
  defer: (drain) => setTimeout(drain),
  rethrow: (err) => setTimeout(() => { throw err; }),
});

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<RegexMatchRequest | WorkerInputsMessage<string[]>>(self, serve);
