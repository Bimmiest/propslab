// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// useProcessingPipeline.test.tsx
// Worker construction and failure handling for the main pipeline (#294).
//
// Construction used to be unguarded: a `new Worker` that threw (no Worker
// global, a CSP forbidding worker scripts) escaped the mount effect, and had it
// been caught `sendRequest` bailed on the null worker forever. These pin the
// inline fallback that replaced both, and the watchdog path that clears the
// result so the preview can say the run failed.
//
// #309 added the case construction does not catch: `new Worker` succeeds, the
// chunk then fails to load, and the failure arrives as an `error` event. Those
// pin the start-failure cap, and that the crash-replay path it sits beside
// still restarts once and then gives up.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useProcessingPipeline } from '../useProcessingPipeline';
import { useAppStore } from '../../store/useAppStore';
import type { PipelineWorkerRequest } from '../../engine/pipelineWorker';

const initial = useAppStore.getState();

const PROPS = '[test]\nSHOULD_LINEMERGE = false\n';
const META = { index: 'main', host: 'h', source: 's', sourcetype: 'test' };

function seed() {
  useAppStore.setState({
    rawData: 'one\ntwo',
    propsConf: PROPS,
    metadata: META,
    settings: { perEventPipeline: false, manualApply: false },
  });
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  static failAfter = Infinity;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  posted: PipelineWorkerRequest[] = [];
  terminated = false;

  constructor() {
    if (FakeWorker.instances.length >= FakeWorker.failAfter) throw new Error('blocked by CSP');
    FakeWorker.instances.push(this);
  }
  postMessage(message: PipelineWorkerRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** What the browser fires when the script chunk cannot be fetched: a plain Event, no message. */
  failToLoad() {
    this.onerror?.(new Event('error') as ErrorEvent);
  }
  /** An exception thrown by worker code that did run. */
  crash(message = 'boom') {
    this.onerror?.({ message } as ErrorEvent);
  }
  /** Answer a request with an empty, successful result. */
  answer(id: number) {
    this.onmessage?.({
      data: { id, result: { result: { events: [] }, diagnostics: [] } },
    } as unknown as MessageEvent);
  }
}

const latest = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

describe('useProcessingPipeline', () => {
  // The inline fallback loads the engine with a dynamic import(). The first
  // load transforms the whole engine, which under a loaded test run can take
  // longer than waitFor's one-second default on top of the 300 ms debounce, so
  // the inline tests failed intermittently while measuring module load time
  // rather than the hook. Loading it once up front keeps that cost out of
  // every assertion window.
  beforeAll(async () => {
    await import('../../engine/pipeline');
  });

  beforeEach(() => {
    useAppStore.setState(initial, true);
    FakeWorker.instances = [];
    FakeWorker.failAfter = Infinity;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('runs inline when there is no Worker', async () => {
    vi.stubGlobal('Worker', undefined);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(2));
    expect(useAppStore.getState().isProcessing).toBe(false);
  });

  it('runs inline, rather than throwing from the effect, when construction fails', async () => {
    FakeWorker.failAfter = 0;
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(2));
  });

  it('finishes a crashed request inline when the replacement cannot be constructed', async () => {
    FakeWorker.failAfter = 1;
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.onerror?.({ message: 'boom' } as ErrorEvent));

    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(2));
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
  });

  it('clears the result and reports an error when the watchdog fires', () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    act(() => void vi.advanceTimersByTime(300)); // debounce
    expect(FakeWorker.instances[0]!.posted).toHaveLength(1);
    expect(useAppStore.getState().isProcessing).toBe(true);

    act(() => void vi.advanceTimersByTime(5_000));
    const state = useAppStore.getState();
    expect(state.isProcessing).toBe(false);
    expect(state.processingResult).toBeNull();
    expect(state.validationDiagnostics[0]?.message).toMatch(/timed out/);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(FakeWorker.instances).toHaveLength(2);
  });
  it('stops recreating a worker whose script never loads, and finishes inline (#309)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.failToLoad());
    // One replacement, with the pending request resent to it.
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[1]!.posted.map((r) => r.id)).toEqual([FakeWorker.instances[0]!.posted[0]!.id]);

    act(() => FakeWorker.instances[1]!.failToLoad());
    expect(FakeWorker.instances).toHaveLength(2); // capped: no third construction
    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(2));
    expect(useAppStore.getState().validationDiagnostics.some((d) => /Worker/.test(d.message))).toBe(false);

    // Later requests run inline too, without touching a worker.
    act(() => useAppStore.setState({ rawData: 'one\ntwo\nthree' }));
    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(3));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('reports nothing for a load failure with no request in flight (#309)', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    renderHook(() => useProcessingPipeline());

    act(() => FakeWorker.instances[0]!.failToLoad());
    act(() => FakeWorker.instances[1]!.failToLoad());
    expect(FakeWorker.instances).toHaveLength(2);
    const state = useAppStore.getState();
    expect(state.validationDiagnostics).toEqual([]);
    expect(state.isProcessing).toBe(false);

    act(() => useAppStore.getState().triggerManualRun());
    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(2));
  });

  it('restarts once and replays a request that crashed a worker mid-run', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.answer(FakeWorker.instances[0]!.posted[0]!.id));

    act(() => useAppStore.setState({ rawData: 'crashy' }));
    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(2));
    const request = FakeWorker.instances[0]!.posted[1]!;

    act(() => FakeWorker.instances[0]!.crash());
    expect(FakeWorker.instances).toHaveLength(2);
    expect(latest().posted).toEqual([request]);
    expect(useAppStore.getState().isProcessing).toBe(true);

    act(() => latest().answer(request.id));
    expect(useAppStore.getState().isProcessing).toBe(false);
    expect(useAppStore.getState().processingResult).toEqual({ events: [] });
  });

  it('gives up with a terminal error when the replay crashes too', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.answer(FakeWorker.instances[0]!.posted[0]!.id));
    act(() => useAppStore.setState({ rawData: 'crashy' }));
    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(2));

    act(() => FakeWorker.instances[0]!.crash());
    act(() => FakeWorker.instances[1]!.crash());

    const state = useAppStore.getState();
    expect(state.isProcessing).toBe(false);
    expect(state.processingResult).toBeNull();
    expect(state.validationDiagnostics[0]?.message).toMatch(/crashed repeatedly/);
    // The poisoned input is not replayed again, but a worker is left for the next one.
    expect(FakeWorker.instances).toHaveLength(3);
    expect(FakeWorker.instances[2]!.posted).toEqual([]);
  });
});
