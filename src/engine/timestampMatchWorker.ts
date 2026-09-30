/**
 * Web Worker entry point for the Timestamp tab's live prober.
 *
 * Runs the user's TIME_PREFIX off the main thread, under the caller's watchdog,
 * so a slow pattern stalls THIS worker rather than the tab while someone is
 * editing props.conf.
 *
 * Message protocol:
 *   in  → WorkerInputsMessage<string[]> (the raws, once per set), TimestampMatchRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine; then a
 *         TimestampMatchResponse, or a WorkerSkippedResponse, per request
 */

import { probeTimestamps } from './timestampMatch';
import type { TimeConfig, TimestampProbe } from './timestampMatch';
import { serveWithRegexEngine } from '../utils/regexEngineLoader';
import { createRequestQueue, type QueuedRequest, type WorkerInputsMessage, type WorkerSkippedResponse } from './workerProtocol';

export interface TimestampMatchRequest extends QueuedRequest {
  /**
   * The texts to probe, when not sent ahead in an inputs message named by
   * `inputsId`. The TIME_FORMAT hover sends its one sample here.
   */
  raws?: string[];
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

const serve = createRequestQueue<string[], TimestampMatchRequest>({
  run: (request, sent) => {
    const { id, config } = request;
    let response: TimestampMatchResponse;
    try {
      const raws = request.raws ?? sent;
      if (raws === undefined) throw new Error('No events to probe');
      response = { id, probes: probeTimestamps(raws, config) };
    } catch (err) {
      response = { id, probes: [], error: err instanceof Error ? err.message : String(err) };
    }
    self.postMessage(response);
  },
  skip: ({ id }) => self.postMessage({ id, skipped: true } satisfies WorkerSkippedResponse),
  defer: (drain) => setTimeout(drain),
  rethrow: (err) => setTimeout(() => { throw err; }),
});

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<TimestampMatchRequest | WorkerInputsMessage<string[]>>(self, serve);
