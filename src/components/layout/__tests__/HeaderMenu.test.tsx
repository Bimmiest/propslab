// @vitest-environment jsdom
// The phone header's one menu for settings, the pipeline reference and the
// theme (#893).
import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HeaderMenu } from '../HeaderMenu';
import { useAppStore } from '../../../store/useAppStore';

const initial = useAppStore.getState();

function open() {
  fireEvent.click(screen.getByRole('button', { name: 'More' }));
  return screen.getByRole('group', { name: 'More' });
}

describe('HeaderMenu', () => {
  beforeEach(() => useAppStore.setState(initial, true));

  it('is closed until its button is pressed', () => {
    render(<HeaderMenu />);
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('group', { name: 'More' })).not.toBeInTheDocument();
    const group = open();
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls', group.id);
  });

  it('opens the settings, closes, and gives the focus back to its button', () => {
    render(<HeaderMenu />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(useAppStore.getState().settingsOpen).toBe(true);
    expect(screen.queryByRole('group', { name: 'More' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More' })).toHaveFocus();
  });

  it('opens the pipeline reference', () => {
    render(<HeaderMenu />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Pipeline reference' }));
    expect(useAppStore.getState().helpOpen).toBe(true);
  });

  it('shows which panel is open', () => {
    useAppStore.setState({ settingsOpen: true });
    render(<HeaderMenu />);
    open();
    expect(screen.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pipeline reference' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the theme, and names the theme it switches to', () => {
    useAppStore.setState({ theme: 'dark' });
    render(<HeaderMenu />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to light mode' }));
    expect(useAppStore.getState().theme).toBe('light');
    open();
    expect(screen.getByRole('button', { name: 'Switch to dark mode' })).toBeInTheDocument();
  });

  it('closes on Escape', () => {
    render(<HeaderMenu />);
    open();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Settings' }), { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'More' })).not.toBeInTheDocument();
    expect(useAppStore.getState().settingsOpen).toBe(false);
  });
});
