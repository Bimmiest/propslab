// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import * as RadixTooltip from '@radix-ui/react-tooltip';
import { ActivityRail } from '../ActivityRail';
import { useAppStore } from '../../../store/useAppStore';

function renderRail() {
  return render(
    <RadixTooltip.Provider>
      <ActivityRail />
    </RadixTooltip.Provider>,
  );
}

const initial = useAppStore.getState();

describe('ActivityRail', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('names its icon-only buttons, which carry no visible text', () => {
    renderRail();
    expect(screen.getByRole('tab', { name: 'Simulator' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Dictionary' })).toBeInTheDocument();
  });

  it('marks the active view selected', () => {
    renderRail();
    expect(screen.getByRole('tab', { name: 'Simulator' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Dictionary' })).toHaveAttribute('aria-selected', 'false');
  });

  it('switches the view on click', () => {
    renderRail();
    fireEvent.click(screen.getByRole('tab', { name: 'Dictionary' }));
    expect(useAppStore.getState().activeView).toBe('dictionary');
  });

  it('declares itself vertical so arrow-key expectations match', () => {
    renderRail();
    expect(screen.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  });

  it('moves between views with the arrow keys', () => {
    renderRail();
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(useAppStore.getState().activeView).toBe('dictionary');

    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(useAppStore.getState().activeView).toBe('simulator');
  });

  it('wraps around at the ends', () => {
    renderRail();
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(useAppStore.getState().activeView).toBe('dictionary');
  });

  it('jumps to the ends with Home and End', () => {
    renderRail();
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'End' });
    expect(useAppStore.getState().activeView).toBe('dictionary');

    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(useAppStore.getState().activeView).toBe('simulator');
  });

  it('keeps only the active item in the tab order', () => {
    renderRail();
    expect(screen.getByRole('tab', { name: 'Simulator' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('tab', { name: 'Dictionary' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('ActivityRail aria-controls (#495)', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('points at the simulator panel, which is always mounted', () => {
    renderRail();
    expect(screen.getByRole('tab', { name: 'Simulator' })).toHaveAttribute('aria-controls', 'view-panel-simulator');
  });

  it('does not point at a dictionary panel that is not in the DOM yet', () => {
    renderRail();
    expect(screen.getByRole('tab', { name: 'Dictionary' })).not.toHaveAttribute('aria-controls');
  });

  it('points at the dictionary panel once it is mounted', () => {
    render(
      <RadixTooltip.Provider>
        <ActivityRail dictionaryMounted />
      </RadixTooltip.Provider>,
    );
    expect(screen.getByRole('tab', { name: 'Dictionary' })).toHaveAttribute('aria-controls', 'view-panel-dictionary');
  });
});
