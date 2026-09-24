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
//
// #326: #309 counted crashes toward that cap too, so an input that crashed a
// few workers ended up run inline, with no watchdog. Those pin that only load
// failures count, and that a crashed request is never finished inline.
//
// #335: in manual-apply mode, a run made inside the debounce window left the
// status bar reporting unapplied changes once the debounce settled.
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

/**
 * Long enough for an inline run, had one been started, to have written its
 * result: the engine is preloaded in beforeAll, so the dynamic import resolves
 * in a microtask or two. Used where the assertion is that nothing ran inline.
 */
const settleInline = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

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

  it('does not finish a crashed request inline when the replacement cannot be constructed (#326)', async () => {
    // This used to run the crashed request inline. It is the one input known to
    // take a thread down, so it is reported instead; the next request, which
    // has not crashed anything, runs inline because no worker can be built.
    FakeWorker.failAfter = 1;
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.crash());

    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    await settleInline();
    let state = useAppStore.getState();
    expect(state.processingResult).toBeNull();
    expect(state.isProcessing).toBe(false);
    expect(state.validationDiagnostics[0]?.message).toMatch(/crashed while processing/);

    act(() => useAppStore.setState({ rawData: 'one\ntwo\nthree' }));
    await waitFor(() => expect(useAppStore.getState().processingResult?.events).toHaveLength(3));
    state = useAppStore.getState();
    expect(state.validationDiagnostics.some((d) => /crashed/.test(d.message))).toBe(false);
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
  it('never runs inline an input that keeps crashing workers, however many it takes (#326)', async () => {
    // The exact sequence from #326: worker 1 answers; an input crashes it and
    // its replay on worker 2 (terminal error, worker 3 built); the user edits
    // props.conf, raw unchanged, and worker 3 crashes too. #309 had counted
    // workers 2 and 3 as start failures, hit the cap, built no worker 4, and
    // ran the poisoned input on the main thread with no watchdog.
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.answer(FakeWorker.instances[0]!.posted[0]!.id));

    act(() => useAppStore.setState({ rawData: 'crashy' }));
    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(2));
    act(() => FakeWorker.instances[0]!.crash('out of memory'));
    act(() => FakeWorker.instances[1]!.crash('out of memory'));
    expect(useAppStore.getState().validationDiagnostics[0]?.message).toMatch(/crashed repeatedly/);
    expect(FakeWorker.instances).toHaveLength(3);

    act(() => useAppStore.setState({ propsConf: `${PROPS}TRUNCATE = 0\n` }));
    await waitFor(() => expect(FakeWorker.instances[2]!.posted).toHaveLength(1));
    const edited = FakeWorker.instances[2]!.posted[0]!;
    act(() => FakeWorker.instances[2]!.crash('out of memory'));

    // A crash is not a load failure: a fresh worker is built and gets the
    // replay, under the watchdog, rather than the main thread getting the input.
    expect(FakeWorker.instances).toHaveLength(4);
    expect(FakeWorker.instances[3]!.posted).toEqual([edited]);
    expect(useAppStore.getState().isProcessing).toBe(true);

    act(() => FakeWorker.instances[3]!.crash('out of memory'));
    await settleInline();
    const state = useAppStore.getState();
    expect(state.processingResult).toBeNull();
    expect(state.isProcessing).toBe(false);
    expect(state.validationDiagnostics[0]?.message).toMatch(/crashed repeatedly/);
    expect(FakeWorker.instances).toHaveLength(5);
    expect(FakeWorker.instances[4]!.posted).toEqual([]);
  });

  it('does not run a request inline when its replay\'s worker then fails to load (#326)', async () => {
    // The request crashed worker 1; worker 2, carrying its replay, and worker 3
    // both fail to load, which exhausts the load-failure cap. The request still
    // crashed a worker, so it is reported rather than finished inline.
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    renderHook(() => useProcessingPipeline());

    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(1));
    act(() => FakeWorker.instances[0]!.answer(FakeWorker.instances[0]!.posted[0]!.id));
    act(() => useAppStore.setState({ rawData: 'crashy' }));
    await waitFor(() => expect(FakeWorker.instances[0]!.posted).toHaveLength(2));

    act(() => FakeWorker.instances[0]!.crash());
    act(() => FakeWorker.instances[1]!.failToLoad());
    act(() => FakeWorker.instances[2]!.failToLoad());
    expect(FakeWorker.instances).toHaveLength(3);

    await settleInline();
    const state = useAppStore.getState();
    expect(state.processingResult).toBeNull();
    expect(state.isProcessing).toBe(false);
    expect(state.validationDiagnostics[0]?.message).toMatch(/no replacement worker could be started/);
  });

  it('stops rebuilding a worker whose script throws before it is given anything (#326)', () => {
    // Crashes no longer count toward the cap, but a worker that dies with no
    // request ever sent to it died of its own script; rebuilding it on every
    // death would loop for as long as the tab is open.
    vi.stubGlobal('Worker', FakeWorker);
    seed();
    useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    renderHook(() => useProcessingPipeline());

    act(() => FakeWorker.instances[0]!.crash('SyntaxError'));
    act(() => FakeWorker.instances[1]!.crash('SyntaxError'));
    expect(FakeWorker.instances).toHaveLength(2);
  });

  describe('manual apply (#335)', () => {
    function seedManual() {
      seed();
      useAppStore.setState({ settings: { perEventPipeline: false, manualApply: true } });
    }

    it('is not dirty after a run made before the debounce settled', () => {
      vi.useFakeTimers();
      vi.stubGlobal('Worker', FakeWorker);
      seedManual();
      renderHook(() => useProcessingPipeline());
      act(() => void vi.advanceTimersByTime(300));

      // Type, then click Run well inside the debounce window.
      act(() => useAppStore.setState({ rawData: 'one\ntwo\nthree' }));
      act(() => void vi.advanceTimersByTime(100));
      act(() => useAppStore.getState().triggerManualRun());
      expect(latest().posted.at(-1)?.rawData).toBe('one\ntwo\nthree');
      expect(useAppStore.getState().pipelineDirty).toBe(false);

      // The debounce settles on the inputs that run already used.
      act(() => void vi.advanceTimersByTime(300));
      expect(useAppStore.getState().pipelineDirty).toBe(false);
    });

    it('is dirty when the inputs move on after a run', () => {
      vi.useFakeTimers();
      vi.stubGlobal('Worker', FakeWorker);
      seedManual();
      renderHook(() => useProcessingPipeline());
      act(() => void vi.advanceTimersByTime(300));
      act(() => useAppStore.getState().triggerManualRun());
      expect(useAppStore.getState().pipelineDirty).toBe(false);

      act(() => useAppStore.setState({ propsConf: `${PROPS}TRUNCATE = 0\n` }));
      act(() => void vi.advanceTimersByTime(300));
      expect(useAppStore.getState().pipelineDirty).toBe(true);

      // Editing back to what last ran leaves nothing to apply.
      act(() => useAppStore.setState({ propsConf: PROPS }));
      act(() => void vi.advanceTimersByTime(300));
      expect(useAppStore.getState().pipelineDirty).toBe(false);
    });

    it('is dirty when a pipeline option changes after a run', () => {
      vi.useFakeTimers();
      vi.stubGlobal('Worker', FakeWorker);
      seedManual();
      renderHook(() => useProcessingPipeline());
      act(() => void vi.advanceTimersByTime(300));
      act(() => useAppStore.getState().triggerManualRun());

      act(() => useAppStore.setState({ settings: { perEventPipeline: true, manualApply: true } }));
      expect(useAppStore.getState().pipelineDirty).toBe(true);
    });
  });
});
