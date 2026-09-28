// ---------------------------------------------------------------------------
// workerReady.test.ts
// Every worker entry announces that it is up: its module has evaluated
// and it has loaded its regex engine from the built asset.
//
// The page tells a worker that never started from one that started and then
// died by whether it has sent WORKER_READY: an error before it is a load
// failure and is not charged to the request in flight. So the signal must come
// once, after the handler is installed and the engine is up, and before any
// response.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { WORKER_READY } from '../workerProtocol';
import { stubFailingWasmFetch, stubWasmFetch } from '../../test/wasmFetch';
import { serveWithRegexEngine } from '../../utils/regexEngineLoader';

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
  // Only setTimeout: the engine loads through real promises, and the entry
  // acts on the outcome in a task of its own.
  beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * Until the engine's load has settled and scheduled its task. Polled by
   * hand: vi.waitFor advances fake timers itself, which would run that task.
   */
  const loaded = async () => {
    const { setImmediate } = (globalThis as unknown as { process: { getBuiltinModule(id: 'node:timers'): { setImmediate(cb: () => void): void } } }).process.getBuiltinModule('node:timers');
    for (let i = 0; i < 1000 && vi.getTimerCount() === 0; i++) await new Promise<void>((r) => setImmediate(r));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
  };
  /** Let the engine load, then run the task that acts on the outcome. */
  const settle = async () => {
    await loaded();
    vi.runOnlyPendingTimers();
  };

  it.each(entries)('%s posts it once, after loading its engine, before any response', async (_name, entry, request) => {
    stubWasmFetch();
    const { posted, send } = await load(entry);
    // A request that arrives while the engine loads waits for it.
    send(request);
    expect(posted).toEqual([]);

    await settle();
    expect(posted[0]).toEqual({ message: WORKER_READY, handlerInstalled: true });
    expect(posted).toHaveLength(2);
    expect(posted[1]!.message).toMatchObject({ id: 4 });

    // Once up, requests are answered as they arrive.
    send(request);
    expect(posted).toHaveLength(3);
    expect(posted.filter((p) => (p.message as { type?: string }).type === 'ready')).toHaveLength(1);
  });

  it.each(entries)('%s fails to load, before ready, when its engine cannot be fetched', async (_name, entry, request) => {
    stubFailingWasmFetch();
    const { posted, send } = await load(entry);
    send(request);
    await loaded();
    // Thrown in a task, so it is an uncaught worker error, which the page
    // counts as a failure to load because no ready came first.
    expect(() => vi.runOnlyPendingTimers()).toThrow(/asset unavailable/);
    expect(posted).toEqual([]);
  });

  it('takes nothing from a message but requests: a message shaped like an engine is just a request', async () => {
    stubWasmFetch();
    const { posted, send } = await load(entries[1]![1]);
    await settle();
    // Matching it fails, and is answered as a failed request.
    send({ type: 'init', regexEngine: {} });
    expect(posted).toHaveLength(2);
    const answer = posted[1]!.message as { results: unknown; error?: unknown };
    expect(answer.results).toBeNull();
    expect(typeof answer.error).toBe('string');
  });

  it('handles every queued request when one handler throws, and still surfaces the throw (#436)', async () => {
    stubWasmFetch();
    const fakeSelf: { onmessage: Handler; postMessage: (m: unknown) => void } = { onmessage: null, postMessage: () => {} };
    const handled: number[] = [];
    serveWithRegexEngine<number>(fakeSelf, (n) => {
      if (n === 2) throw new Error('handler exploded');
      handled.push(n);
    });
    for (const n of [1, 2, 3]) fakeSelf.onmessage!({ data: n } as MessageEvent<number>);
    await settle();
    expect(handled).toEqual([1, 3]);
    // Rethrown in a task of its own, so the page still sees it as a crash.
    expect(() => vi.runOnlyPendingTimers()).toThrow(/handler exploded/);
  });
});
