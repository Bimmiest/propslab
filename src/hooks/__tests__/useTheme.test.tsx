// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { applyTheme, useTheme } from '../useTheme';
import { useAppStore } from '../../store/useAppStore';

const initial = useAppStore.getState();

describe('applyTheme', () => {
  beforeEach(() => {
    useAppStore.setState(initial, true);
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
  });

  it('sets the dark class and color-scheme together, so native controls follow the theme (#498)', () => {
    applyTheme('dark');
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');

    applyTheme('light');
    expect(document.documentElement).not.toHaveClass('dark');
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('follows the store when the theme is toggled', () => {
    useAppStore.setState({ theme: 'light' });
    renderHook(() => useTheme());
    expect(document.documentElement.style.colorScheme).toBe('light');

    act(() => useAppStore.getState().toggleTheme());
    expect(document.documentElement.style.colorScheme).toBe('dark');
    expect(document.documentElement).toHaveClass('dark');
  });
});
