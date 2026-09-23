// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// SelectableRaw.test.tsx
// The drag's window listeners, and the keyboard path to the same selection
// (#300).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { SelectableRaw, type RawSelection } from '../SelectableRaw';

const RAW = 'user=alice ip=10.0.0.1';
// tokens: user[0,4) alice[5,10) ip[11,13) 10.0.0.1[14,22)

function Harness({ onChange }: { onChange?: (s: RawSelection | null) => void }) {
  const [sel, setSel] = useState<RawSelection | null>(null);
  return (
    <>
      <SelectableRaw
        raw={RAW}
        selection={sel}
        onChange={(s) => { setSel(s); onChange?.(s); }}
      />
      <output data-testid="sel">{sel ? RAW.slice(sel.start, sel.end) : ''}</output>
    </>
  );
}

const selected = () => screen.getByTestId('sel').textContent;

/**
 * jsdom has no layout, so caret hit-testing is stubbed: every point resolves to
 * `offset` characters into the first text node under the textbox.
 */
function stubCaretAt(offset: number) {
  const doc = document as Document & { caretRangeFromPoint?: (x: number, y: number) => Range | null };
  doc.caretRangeFromPoint = () => {
    const box = screen.getByRole('textbox');
    const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node && remaining > (node.textContent ?? '').length) {
      remaining -= (node.textContent ?? '').length;
      node = walker.nextNode();
    }
    const range = document.createRange();
    range.setStart(node!, remaining);
    return range;
  };
}

describe('SelectableRaw', () => {
  afterEach(() => {
    delete (document as { caretRangeFromPoint?: unknown }).caretRangeFromPoint;
    vi.restoreAllMocks();
  });

  it('selects the token under a click', () => {
    render(<Harness />);
    stubCaretAt(6);
    const box = screen.getByRole('textbox');
    fireEvent.mouseDown(box, { button: 0 });
    fireEvent.mouseUp(window);
    expect(selected()).toBe('alice');
    expect(document.activeElement).toBe(box);
  });

  it('extends the selection on shift-click', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    stubCaretAt(1);
    fireEvent.mouseDown(box, { button: 0 });
    fireEvent.mouseUp(window);
    expect(selected()).toBe('user');

    stubCaretAt(15);
    fireEvent.mouseDown(box, { button: 0 });
    fireEvent.mouseUp(window, { shiftKey: true });
    expect(selected()).toBe(RAW);
  });

  it('detaches its window listeners when unmounted mid-drag', () => {
    const onChange = vi.fn();
    const removed = vi.spyOn(window, 'removeEventListener');
    const { unmount } = render(<Harness onChange={onChange} />);
    stubCaretAt(1);
    fireEvent.mouseDown(screen.getByRole('textbox'), { button: 0 });
    unmount();

    expect(removed.mock.calls.map(([type]) => type)).toEqual(expect.arrayContaining(['mousemove', 'mouseup']));
    fireEvent.mouseUp(window);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('selects tokens from the keyboard', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    box.focus();

    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(selected()).toBe('user');
    fireEvent.keyDown(box, { key: 'ArrowRight' });
    expect(selected()).toBe('alice');
    fireEvent.keyDown(box, { key: 'ArrowRight', shiftKey: true });
    expect(selected()).toBe('alice ip');
    fireEvent.keyDown(box, { key: 'ArrowLeft' });
    expect(selected()).toBe('user');
    fireEvent.keyDown(box, { key: 'End' });
    expect(selected()).toBe('10.0.0.1');
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(selected()).toBe('');
  });

  it('announces the selection', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'Home' });
    expect(screen.getByText('Selected: user')).toBeInTheDocument();
  });

  it('copies the controlled selection', () => {
    render(<Harness />);
    const box = screen.getByRole('textbox');
    fireEvent.keyDown(box, { key: 'End' });
    const setData = vi.fn();
    fireEvent.copy(box, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', '10.0.0.1');
  });
});
