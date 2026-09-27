// ---------------------------------------------------------------------------
// workerReady.test.ts
// Every worker entry announces that it is up (#339): its module has evaluated
// and it has instantiated the regex engine the page sent it (#368).
//
// The page tells a worker that never started from one that started and then
// died by whether it has sent WORKER_READY: an error before it is a load
// failure and is not charged to the request in flight. So the signal must come
// once, after the handler is installed and the engine is up, and before any
// response.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { WORKER_READY, type WorkerInitMessage } from '../workerProtocol';
import { regexEngineModule } from '../../utils/splunkRegex';

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

  // The compiled module from this file's own (initialised) engine: the entry
  // is loaded after resetModules, so it has a fresh, empty one, as a real
  // worker does.
  const init = (): WorkerInitMessage => ({ type: 'init', regexEngine: regexEngineModule() });

  it.each(entries)('%s posts it once, after the engine it is sent is up, before any response', async (_name, entry, request) => {
    const { posted, send } = await load(entry);
    expect(posted).toEqual([]);

    send(init());
    expect(posted).toEqual([{ message: WORKER_READY, handlerInstalled: true }]);

    send(request);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.message).toMatchObject({ id: 4 });
    expect(posted.filter((p) => (p.message as { type?: string }).type === 'ready')).toHaveLength(1);
  });

  it.each(entries)('%s throws before ready when the engine will not instantiate', async (_name, entry) => {
    const { posted, send } = await load(entry);
    expect(() => send({ type: 'init', regexEngine: {} })).toThrow();
    expect(posted).toEqual([]);
  });
});
