// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRovingTabs } from '../useRovingTabs';

const IDS = ['a', 'b', 'c'];

function Strip({ orientation, ids = IDS }: { orientation?: 'horizontal' | 'vertical'; ids?: string[] }) {
  const [active, setActive] = useState('a');
  const { ref, onKeyDown } = useRovingTabs(ids, active, setActive, orientation);
  return (
    <div ref={ref} role="tablist" onKeyDown={onKeyDown}>
      {ids.map((id) => (
        <button key={id} type="button" role="tab" aria-selected={id === active} tabIndex={id === active ? 0 : -1}>
          {id}
        </button>
      ))}
    </div>
  );
}

const selected = () => screen.getByRole('tab', { selected: true });

describe('useRovingTabs', () => {
  it('moves the selection and the focus with Left and Right, wrapping at the ends', () => {
    render(<Strip />);
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('b');
    expect(document.activeElement).toBe(selected());

    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('a');

    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(selected()).toHaveTextContent('c');
    expect(document.activeElement).toBe(selected());
  });

  it('jumps to the ends with Home and End', () => {
    render(<Strip />);
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'End' });
    expect(selected()).toHaveTextContent('c');

    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(selected()).toHaveTextContent('a');
  });

  it('leaves Up and Down to the browser in a horizontal list', () => {
    render(<Strip />);
    const tablist = screen.getByRole('tablist');

    expect(fireEvent.keyDown(tablist, { key: 'ArrowDown' })).toBe(true);
    expect(fireEvent.keyDown(tablist, { key: 'ArrowUp' })).toBe(true);
    expect(selected()).toHaveTextContent('a');
  });

  it('takes Up and Down, and still Left and Right, in a vertical list', () => {
    render(<Strip orientation="vertical" />);
    const tablist = screen.getByRole('tablist');

    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(selected()).toHaveTextContent('b');
    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(selected()).toHaveTextContent('a');
    fireEvent.keyDown(tablist, { key: 'ArrowLeft' });
    expect(selected()).toHaveTextContent('c');
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(selected()).toHaveTextContent('a');
  });

  it('cancels the default only for a key it handles', () => {
    render(<Strip />);
    const tablist = screen.getByRole('tablist');

    // fireEvent returns false when the handler called preventDefault.
    expect(fireEvent.keyDown(tablist, { key: 'ArrowRight' })).toBe(false);
    expect(fireEvent.keyDown(tablist, { key: 'Enter' })).toBe(true);
    expect(fireEvent.keyDown(tablist, { key: 'a' })).toBe(true);
  });

  it('does nothing over an empty list', () => {
    render(<Strip ids={[]} />);
    const tablist = screen.getByRole('tablist');

    expect(fireEvent.keyDown(tablist, { key: 'ArrowRight' })).toBe(true);
    expect(fireEvent.keyDown(tablist, { key: 'End' })).toBe(true);
  });
});
