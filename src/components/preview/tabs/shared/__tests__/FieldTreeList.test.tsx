// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// FieldTreeList.test.tsx
// The windowed field tree under the sidebar's own scroller (#469): the scroll
// ref belongs to an ancestor element, which React attaches only after this
// component's layout effects have run.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { useRef } from 'react';
import { render, act } from '@testing-library/react';
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

function Sidebar() {
  const listRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={listRef} data-testid="scroller" style={{ overflow: 'auto', height: 300 }}>
      <FieldTreeList
        tree={tree}
        search=""
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
  return [...container.querySelectorAll<HTMLElement>('[data-window-index]')].map((e) => Number(e.dataset.windowIndex));
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
