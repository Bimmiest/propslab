/**
 * Web Worker entry point for the Timestamp tab's live prober.
 *
 * Runs the user's TIME_PREFIX off the main thread so a catastrophic pattern that
 * slips the ReDoS heuristic hangs THIS worker — which the caller terminates via
 * a watchdog — instead of freezing the tab while someone is editing props.conf.
 *
 * Message protocol:
 *   in  → TimestampMatchRequest
 *   out → TimestampMatchResponse
 */

import { probeTimestamps } from './timestampMatch';
import type { TimeConfig, TimestampProbe } from './timestampMatch';

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

self.onmessage = (e: MessageEvent<TimestampMatchRequest>) => {
  const { id, raws, config } = e.data;
  let response: TimestampMatchResponse;
  try {
    response = { id, probes: probeTimestamps(raws, config) };
  } catch (err) {
    response = { id, probes: [], error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
