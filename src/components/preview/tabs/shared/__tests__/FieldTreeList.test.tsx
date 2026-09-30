// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// FieldTreeList.test.tsx
// The windowed field tree under the sidebar's own scroller (#469): the scroll
// ref belongs to an ancestor element, which React attaches only after this
// component's layout effects have run.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, act, fireEvent } from '@testing-library/react';
import { FieldTreeList } from '../FieldTreeNode';
import type { FieldNode } from '../fieldTreeUtils';

const ROWS = 400;

const tree: FieldNode[] = Array.from({ length: ROWS }, (_, i) => ({
  name: `field${i}`,
  leafName: `field${i}`,
  color: '#3b82f6',
  processor: null,
  isContainer: false,
  depth: 0,
  children: [],
}));

function Sidebar({ search = '' }: { search?: string }) {
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={listRef} data-testid="scroller" style={{ overflow: 'auto', height: 300 }}>
      <FieldTreeList
        tree={tree}
        search={search}
        scrollRef={listRef}
        collapsed={new Set()}
        toggleGroup={() => {}}
        activeFields={null}
        pinnedFields={new Set()}
        onHover={() => {}}
        onClick={() => {}}
      />
    </div>
  );
}

function renderedIndexes(container: HTMLElement): number[] {
  return [...container.querySelectorAll<HTMLElement>('[data-window-index]')].map((e) => Number(e.dataset['windowIndex']));
}

describe('FieldTreeList windowing (#469)', () => {
  it('renders only a window of a long list, not every row', () => {
    const { container } = render(<Sidebar />);
    const rendered = renderedIndexes(container);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(ROWS);
    expect(Math.min(...rendered)).toBe(0);
  });

  it('follows a scroll of an ancestor-owned scroller mounted past the threshold', () => {
    const { container, getByTestId } = render(<Sidebar />);
    const before = Math.max(...renderedIndexes(container));

    const scroller = getByTestId('scroller');
    // 24 px estimated rows: this puts row ~250 at the top of the viewport.
    scroller.scrollTop = 6000;
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });

    const after = renderedIndexes(container);
    expect(Math.max(...after)).toBeGreaterThan(before);
    expect(after).toContain(250);
    expect(after).not.toContain(0);
  });
});

describe('FieldTreeList keyboard model (#495)', () => {
  const rowsIn = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[data-field-row]')];
  const tabStops = (container: HTMLElement) => rowsIn(container).filter((el) => el.tabIndex === 0);

  it('is a single tab stop, not one per row', () => {
    const { container } = render(<Sidebar />);
    expect(rowsIn(container).length).toBeGreaterThan(1);
    expect(tabStops(container)).toHaveLength(1);
    expect(tabStops(container)[0]?.dataset['fieldRow']).toBe('field0');
  });

  it('moves the focus and the tab stop with the arrow keys', () => {
    const { container } = render(<Sidebar />);
    act(() => rowsIn(container)[0]?.focus());

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement).toHaveAttribute('data-field-row', 'field1');
    expect(tabStops(container).map((el) => el.dataset['fieldRow'])).toEqual(['field1']);

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-field-row', 'field0');
    // Not past either end.
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement).toHaveAttribute('data-field-row', 'field0');
  });

  it('makes the row that took focus by other means the tab stop', () => {
    const { container } = render(<Sidebar />);
    act(() => rowsIn(container)[3]?.focus());
    expect(tabStops(container).map((el) => el.dataset['fieldRow'])).toEqual(['field3']);
  });

  it('reaches a row that is not rendered with End and Home', () => {
    const { container, getByTestId } = render(<Sidebar />);
    const scroller = getByTestId('scroller');
    act(() => rowsIn(container)[0]?.focus());

    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(document.activeElement).toHaveAttribute('data-field-row', `field${ROWS - 1}`);
    expect(tabStops(container).map((el) => el.dataset['fieldRow'])).toEqual([`field${ROWS - 1}`]);

    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    act(() => {
      scroller.dispatchEvent(new Event('scroll'));
    });
    expect(document.activeElement).toHaveAttribute('data-field-row', 'field0');
  });

  it('keeps a tab stop when the roving row leaves the list', () => {
    const { container, rerender } = render(<Sidebar />);
    act(() => rowsIn(container)[3]?.focus());
    expect(tabStops(container).map((el) => el.dataset['fieldRow'])).toEqual(['field3']);

    // A filter that no longer matches field3.
    rerender(<Sidebar search="field1" />);
    expect(rowsIn(container).some((el) => el.dataset['fieldRow'] === 'field3')).toBe(false);
    expect(tabStops(container)).toHaveLength(1);
  });
});
