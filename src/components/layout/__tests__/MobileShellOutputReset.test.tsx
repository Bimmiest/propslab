// @vitest-environment jsdom
// The Output boundary of the phone layout clears when the next result arrives,
// as the desktop layout's does (#563, #883). In its own file because it
// replaces the Output panel with one that throws on demand.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render as baseRender, screen, act, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { MobileShell } from '../MobileShell';
import { useAppStore } from '../../../store/useAppStore';

const panel = vi.hoisted(() => ({ broken: true }));

vi.mock('../../preview/PreviewPanel', () => ({
  PreviewPanel: () => {
    if (panel.broken) throw new Error('kaboom');
    return <p>output is fine</p>;
  },
}));

const initial = useAppStore.getState();

describe('MobileShell Output boundary (#883)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    panel.broken = true;
    // React logs the error the boundary catches.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  it('recovers when the pipeline answers again, and not before', () => {
    baseRender(
      <RadixTooltip.Provider>
        <MobileShell />
      </RadixTooltip.Provider>,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Output' }));
    expect(screen.getByRole('alert')).toHaveTextContent('kaboom');

    // The input is fixed, but no new result has arrived yet.
    panel.broken = false;
    expect(screen.getByRole('alert')).toBeInTheDocument();

    act(() => useAppStore.getState().setProcessingResult({} as never));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('output is fine')).toBeInTheDocument();
  });
});
