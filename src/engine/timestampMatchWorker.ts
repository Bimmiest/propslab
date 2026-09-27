/**
 * Web Worker entry point for the Timestamp tab's live prober.
 *
 * Runs the user's TIME_PREFIX off the main thread, under the caller's watchdog,
 * so a slow pattern stalls THIS worker rather than the tab while someone is
 * editing props.conf.
 *
 * Message protocol:
 *   in  → WorkerInitMessage first, with the compiled regex engine; then TimestampMatchRequest
 *   out → WORKER_READY once, when the engine is instantiated (#339); then TimestampMatchResponse
 */

import { probeTimestamps } from './timestampMatch';
import type { TimeConfig, TimestampProbe } from './timestampMatch';
import { initRegexEngineSync } from '../utils/splunkRegex';
import { isWorkerInitMessage, WORKER_READY, type WorkerInitMessage } from './workerProtocol';

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
   * Why probing threw, when it did. Without a catch here the throw became an
   * uncaught worker error, which the caller reports exactly as it reports its
   * watchdog firing: the tab said "timed out" and the message was lost (#322).
   */
  error?: string;
}

self.onmessage = (e: MessageEvent<TimestampMatchRequest | WorkerInitMessage>) => {
  if (isWorkerInitMessage(e.data)) {
    // The page's first message: the engine it compiled once. Ready follows
    // only once it is instantiated; a throw here is a failure to load (#339).
    initRegexEngineSync(e.data.regexEngine);
    self.postMessage(WORKER_READY);
    return;
  }
  const { id, raws, config } = e.data;
  let response: TimestampMatchResponse;
  try {
    response = { id, probes: probeTimestamps(raws, config) };
  } catch (err) {
    response = { id, probes: [], error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
