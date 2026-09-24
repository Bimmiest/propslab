// ---------------------------------------------------------------------------
// timestampMatchWorker.test.ts
// A throw inside the prober must come back as a response, not kill the worker
// (#322). Uncaught, it surfaced as a worker `error` event, which the caller
// cannot tell from its watchdog firing: the tab said "timed out" and the
// message was lost.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TimestampMatchRequest, TimestampMatchResponse } from '../timestampMatchWorker';

// A plain variable rather than a `vi.fn`: vitest fails a test whose mock
// throws, even when the code under test catches it, and throwing is the point.
let probeImpl: () => unknown[] = () => [];
vi.mock('../timestampMatch', () => ({ probeTimestamps: (): unknown[] => probeImpl() }));

const CONFIG = { timePrefix: null, timeFormat: '%Y', maxLookahead: 128, tz: null };

/** Load the worker against a fake `self`, returning what it posts back. */
async function loadWorker() {
  const posted: TimestampMatchResponse[] = [];
  const fakeSelf: { onmessage: ((e: MessageEvent<TimestampMatchRequest>) => void) | null; postMessage: (m: TimestampMatchResponse) => void } = {
    onmessage: null,
    postMessage: (m) => posted.push(m),
  };
  vi.stubGlobal('self', fakeSelf);
  vi.resetModules();
  await import('../timestampMatchWorker');
  const send = (request: TimestampMatchRequest) =>
    fakeSelf.onmessage!({ data: request } as MessageEvent<TimestampMatchRequest>);
  return { posted, send };
}

describe('timestampMatchWorker', () => {
  beforeEach(() => {
    probeImpl = () => [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts the probes, tagged with the request id', async () => {
    probeImpl = () => [{ match: null, prefix: null }];
    const { posted, send } = await loadWorker();
    send({ id: 7, raws: ['x'], config: CONFIG });
    expect(posted).toEqual([{ id: 7, probes: [{ match: null, prefix: null }] }]);
  });

  it('answers a throw with its message instead of dying', async () => {
    probeImpl = () => {
      throw new Error('prober exploded');
    };
    const { posted, send } = await loadWorker();
    expect(() => send({ id: 3, raws: ['x'], config: CONFIG })).not.toThrow();
    expect(posted).toEqual([{ id: 3, probes: [], error: 'prober exploded' }]);
  });
});
