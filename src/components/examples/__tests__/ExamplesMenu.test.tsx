// @vitest-environment jsdom
// The example library (#666): grouped, loads into a clean session at once, and
// asks before it replaces edits.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { ExamplesMenu } from '../ExamplesMenu';
import { SAMPLE_CONFIGS } from '../../../engine/sampleData';
import { selectSessionDirty, useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();
beforeEach(() => {
  useAppStore.setState(initial, true);
});

const open = (name = 'Examples') => {
  fireEvent.click(screen.getByRole('button', { name }));
  return screen.getByRole('group', { name: 'Examples' });
};

describe('ExamplesMenu', () => {
  it('lists every example under its category, as a disclosure', () => {
    render(<ExamplesMenu />);
    const trigger = screen.getByRole('button', { name: 'Examples' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const popup = open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', popup.id);
    for (const sample of SAMPLE_CONFIGS) {
      const group = within(popup).getByRole('region', { name: sample.category });
      expect(
        within(group).getByRole('button', { name: (accessibleName) => accessibleName.startsWith(sample.name) }),
      ).toBeInTheDocument();
    }
  });

  it('loads an example into a clean session at once, and closes', () => {
    render(<ExamplesMenu prominent />);
    const popup = open('Load an example');
    fireEvent.click(within(popup).getByRole('button', { name: /Cisco ASA/ }));
    const state = useAppStore.getState();
    const asa = SAMPLE_CONFIGS.find((s) => s.name === 'Cisco ASA');
    expect(state.rawData).toBe(asa?.rawData);
    expect(state.metadata).toEqual(asa?.metadata);
    expect(selectSessionDirty(state)).toBe(false);
    expect(screen.queryByRole('group', { name: 'Examples' })).not.toBeInTheDocument();
  });

  it('asks before it replaces edits, and keeps them on Cancel', () => {
    act(() => useAppStore.getState().setPropsConf('[mine]\nTRUNCATE = 5'));
    render(<ExamplesMenu />);
    fireEvent.click(within(open()).getByRole('button', { name: /Linux SSH Auth/ }));
    const dialog = screen.getByRole('alertdialog', { name: 'Replace your current work?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(useAppStore.getState().propsConf).toBe('[mine]\nTRUNCATE = 5');

    fireEvent.click(within(open()).getByRole('button', { name: /Linux SSH Auth/ }));
    fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Load example' }));
    expect(useAppStore.getState().metadata.sourcetype).toBe('linux_secure');
  });

  it('fits the list in the room between its button and the bottom of the pane that scrolls it (#694)', () => {
    render(
      <div data-testid="pane" style={{ overflowY: 'auto' }}>
        <ExamplesMenu prominent />
      </div>,
    );
    const pane = screen.getByTestId('pane');
    const trigger = screen.getByRole('button', { name: 'Load an example' });
    vi.spyOn(pane, 'getBoundingClientRect').mockReturnValue({ bottom: 760 } as DOMRect);
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({ bottom: 540 } as DOMRect);
    expect(open('Load an example').style.maxHeight).toBe('min(70vh, 208px)');
  });

  it('closes on Escape and gives focus back to its button', () => {
    render(<ExamplesMenu />);
    const popup = open();
    fireEvent.keyDown(popup, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Examples' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Examples' })).toHaveFocus();
  });
});
