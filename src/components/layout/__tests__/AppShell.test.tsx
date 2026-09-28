// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// AppShell.test.tsx
// The pipeline hook subscribes to every input. Called from AppShell it
// re-rendered the whole app per keystroke (#424); it now lives in a leaf.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { AppShell } from '../AppShell';
import { useAppStore } from '../../../store/useAppStore';

const renders = vi.hoisted(() => ({ simulator: 0, pipeline: 0 }));

vi.mock('../SimulatorView', () => ({
  SimulatorView: () => {
    renders.simulator++;
    return null;
  },
}));

// The real hook's subscriptions, without the worker behind them.
vi.mock('../../../hooks/useProcessingPipeline', async () => {
  const { useAppStore: store } = await import('../../../store/useAppStore');
  return {
    useProcessingPipeline: () => {
      renders.pipeline++;
      store((s) => s.rawData);
      store((s) => s.propsConf);
      store((s) => s.transformsConf);
      store((s) => s.metadata);
      store((s) => s.settings);
    },
  };
});

describe('AppShell', () => {
  it('keeps pipeline input changes out of the shell', () => {
    render(
      <RadixTooltip.Provider>
        <AppShell />
      </RadixTooltip.Provider>,
    );
    const simulatorBefore = renders.simulator;
    const pipelineBefore = renders.pipeline;

    const { setRawData, setPropsConf, setTransformsConf } = useAppStore.getState();
    act(() => setRawData('a=1'));
    act(() => setPropsConf('[st]'));
    act(() => setTransformsConf('[t]'));

    expect(renders.pipeline).toBeGreaterThan(pipelineBefore);
    expect(renders.simulator).toBe(simulatorBefore);
  });
});
