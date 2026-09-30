// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// AppShell.test.tsx
// The pipeline hook subscribes to every input. Called from AppShell it
// re-rendered the whole app per keystroke (#424); it now lives in a leaf.
//
// Nothing here is replaced but what jsdom cannot provide. The shell, its
// pipeline leaf and the real hook run (#507): the hook used to be swapped for a
// copy of its subscriptions, which passes however the real one changes, and the
// simulator for a stub that counted renders. Now:
//  - Monaco is the real editor, made mountable by monacoJsdom (contributions
//    that need layout are left out; see that file).
//  - `Worker` is a fake that records what the hook posts, so a test can see the
//    input changes reach the pipeline, not only that the shell stayed still.
//  - ActivityRail is wrapped, not replaced: it is rendered by AppShell itself
//    with props and is not memoised, so it renders exactly when the shell does.
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import type { ComponentType } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { PIPELINE_DEBOUNCE_MS } from '../../../hooks/workerLifecycle';
import type { PipelineWorkerRequest } from '../../../engine/pipelineWorker';

const shell = vi.hoisted(() => ({ renders: 0 }));

vi.mock('../ActivityRail', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ActivityRail')>();
  const Real = actual.ActivityRail as ComponentType<Record<string, unknown>>;
  return {
    ...actual,
    ActivityRail: (props: Record<string, unknown>) => {
      shell.renders++;
      return <Real {...props} />;
    },
  };
});

/** Records what the pipeline hook posts. It never answers, so no result reaches the store. */
class RecordingWorker {
  static posted: PipelineWorkerRequest[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;
  postMessage(message: PipelineWorkerRequest) {
    RecordingWorker.posted.push(message);
  }
  terminate() {}
}

const initial = useAppStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', RecordingWorker);
  RecordingWorker.posted = [];
  shell.renders = 0;
  useAppStore.setState(initial, true);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AppShell', () => {
  it('keeps pipeline input changes out of the shell', async () => {
    const { AppShell } = await import('../AppShell');
    render(
      <RadixTooltip.Provider>
        <AppShell />
      </RadixTooltip.Provider>,
    );
    const rendersBefore = shell.renders;
    expect(rendersBefore).toBeGreaterThan(0);

    const { setRawData, setPropsConf, setTransformsConf } = useAppStore.getState();
    act(() => setRawData('a=1'));
    act(() => setPropsConf('[st]'));
    act(() => setTransformsConf('[t]'));
    act(() => {
      vi.advanceTimersByTime(PIPELINE_DEBOUNCE_MS + 1);
    });

    // The pipeline saw the change: the last request carries all three inputs...
    const last = RecordingWorker.posted.at(-1);
    expect(last).toMatchObject({ rawData: 'a=1', propsConfText: '[st]', transformsConfText: '[t]' });
    // ...and the shell rendered none of it.
    expect(shell.renders).toBe(rendersBefore);
  });
});
