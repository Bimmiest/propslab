// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { HelpPanel } from '../HelpPanel';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

function renderWithSearch() {
  return render(
    <>
      <input type="search" aria-label="Search directives" />
      <HelpPanel />
    </>,
  );
}

describe('HelpPanel', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
  });

  it('lets Escape reach a search field while the panel is closed', () => {
    renderWithSearch();
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('Search directives'), { key: 'Escape' });
    expect(notPrevented).toBe(true);
  });

  it('lets Escape reach a search field after the panel has been opened and closed', () => {
    renderWithSearch();
    act(() => useAppStore.getState().toggleHelp());
    expect(screen.getByRole('dialog', { name: 'Pipeline reference' })).toBeInTheDocument();
    act(() => useAppStore.getState().toggleHelp());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    const notPrevented = fireEvent.keyDown(screen.getByLabelText('Search directives'), { key: 'Escape' });
    expect(notPrevented).toBe(true);
  });

  it('closes on Escape while open', () => {
    renderWithSearch();
    act(() => useAppStore.getState().toggleHelp());
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(useAppStore.getState().helpOpen).toBe(false);
  });

  it('carries the data-state hook the slide animation keys on', () => {
    renderWithSearch();
    act(() => useAppStore.getState().toggleHelp());
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveClass('drawer-slide');
    expect(dialog).toHaveAttribute('data-state', 'open');
  });
});
