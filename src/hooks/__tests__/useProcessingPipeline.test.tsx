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
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
}

describe('useProcessingPipeline', () => {
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
});
