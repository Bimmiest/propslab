// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// pressable.test.tsx
// The pin toggles and field-tree rows were click-only (#300). `pressable`
// gives them what a <button> has for free: a tab stop, a role, and Enter/Space.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { pressable } from '../pressable';

describe('pressable', () => {
  it('is a focusable button activated by click, Enter and Space', () => {
    const onPress = vi.fn();
    render(<span {...pressable(onPress)}>pin</span>);
    const el = screen.getByRole('button', { name: 'pin' });
    expect(el.tabIndex).toBe(0);

    fireEvent.click(el);
    fireEvent.keyDown(el, { key: 'Enter' });
    fireEvent.keyDown(el, { key: ' ' });
    fireEvent.keyDown(el, { key: 'a' });
    expect(onPress).toHaveBeenCalledTimes(3);
  });

  it('ignores keys pressed inside a nested control', () => {
    const onPress = vi.fn();
    render(
      <div {...pressable(onPress)}>
        <input aria-label="inner" />
      </div>,
    );
    fireEvent.keyDown(screen.getByLabelText('inner'), { key: 'Enter' });
    expect(onPress).not.toHaveBeenCalled();
  });

  it('reports focus so hover-driven highlighting follows the keyboard', () => {
    const onFocusChange = vi.fn();
    render(<span {...pressable(() => {}, onFocusChange)}>pin</span>);
    const el = screen.getByRole('button');
    fireEvent.focus(el);
    fireEvent.blur(el);
    expect(onFocusChange.mock.calls).toEqual([[true], [false]]);
  });
});
