// ---------------------------------------------------------------------------
// workerReady.test.ts
// Every worker entry announces that its module has evaluated (#339).
//
// The page tells a worker that never started from one that started and then
// died by whether it has sent WORKER_READY: an error before it is a load
// failure and is not charged to the request in flight. So the signal must come
// once, after the handler is installed, and before any response.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WORKER_READY } from '../workerProtocol';

type Handler = ((e: MessageEvent) => void) | null;

/** Load an entry against a fake `self`, recording what it posts and whether its handler was set by then. */
async function load(entry: () => Promise<unknown>) {
  const posted: { message: unknown; handlerInstalled: boolean }[] = [];
  const fakeSelf: { onmessage: Handler; postMessage: (m: unknown) => void } = {
    onmessage: null,
    postMessage: (message) => posted.push({ message, handlerInstalled: fakeSelf.onmessage !== null }),
  };
  vi.stubGlobal('self', fakeSelf);
  vi.resetModules();
  await entry();
  return { posted, send: (data: unknown) => fakeSelf.onmessage!({ data } as MessageEvent) };
}

const entries: [string, () => Promise<unknown>, unknown][] = [
  [
    'pipelineWorker',
    () => import('../pipelineWorker'),
    { id: 4, rawData: 'x', metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' }, propsConfText: '', transformsConfText: '' },
  ],
  ['regexMatchWorker', () => import('../regexMatchWorker'), { id: 4, pattern: 'x', inputs: ['x'] }],
  [
    'timestampMatchWorker',
    () => import('../timestampMatchWorker'),
    { id: 4, raws: ['x'], config: { timePrefix: null, timeFormat: '%Y', maxLookahead: 128, tz: null } },
  ],
];

describe('worker entries post WORKER_READY (#339)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(entries)('%s posts it once, after installing its handler, before any response', async (_name, entry, request) => {
    const { posted, send } = await load(entry);
    expect(posted).toEqual([{ message: WORKER_READY, handlerInstalled: true }]);

    send(request);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.message).toMatchObject({ id: 4 });
    expect(posted.filter((p) => (p.message as { type?: string }).type === 'ready')).toHaveLength(1);
  });
});
