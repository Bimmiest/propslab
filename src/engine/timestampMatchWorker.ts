/**
 * Web Worker entry point for the Timestamp tab's live prober.
 *
 * Runs the user's TIME_PREFIX off the main thread, under the caller's watchdog,
 * so a slow pattern stalls THIS worker rather than the tab while someone is
 * editing props.conf.
 *
 * Message protocol:
 *   in  → TimestampMatchRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine; then TimestampMatchResponse
 */

import { probeTimestamps } from './timestampMatch';
import type { TimeConfig, TimestampProbe } from './timestampMatch';
import { serveWithRegexEngine } from '../utils/regexEngineLoader';

export interface TimestampMatchRequest {
  id: number;
  raws: string[];
  config: TimeConfig;
}

export interface TimestampMatchResponse {
  id: number;
  /** Per-input probes, aligned to `raws`. Empty when `error` is set. */
  probes: TimestampProbe[];
  /**
   * Why probing threw, when it did. Caught here because an uncaught worker
   * error reads to the caller exactly like its watchdog firing, and the
   * message would be lost behind "timed out".
   */
  error?: string;
}

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<TimestampMatchRequest>(self, (request) => {
  const { id, raws, config } = request;
  let response: TimestampMatchResponse;
  try {
    response = { id, probes: probeTimestamps(raws, config) };
  } catch (err) {
    response = { id, probes: [], error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
});
