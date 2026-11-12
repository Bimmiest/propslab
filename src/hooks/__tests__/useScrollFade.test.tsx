// @vitest-environment jsdom
// The marks that the .scroll-fade rule reads (#893). jsdom lays nothing out, so
// each test gives the scroller its sizes and scroll offset by hand.
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useScrollFade } from '../useScrollFade';

function Scroller() {
  const ref = useRef<HTMLDivElement>(null);
  useScrollFade(ref);
  return (
    <div ref={ref} data-testid="scroller">
      <span>content</span>
    </div>
  );
}

/** Gives the scroller its box before the hook first reads it. */
function sized({
  scrollWidth,
  clientWidth,
  offsetWidth = clientWidth,
}: {
  scrollWidth: number;
  clientWidth: number;
  offsetWidth?: number;
}) {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(scrollWidth);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(clientWidth);
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(offsetWidth);
}

describe('useScrollFade', () => {
  it('marks nothing when the content fits', () => {
    sized({ scrollWidth: 300, clientWidth: 300 });
    render(<Scroller />);
    const el = screen.getByTestId('scroller');
    expect(el).not.toHaveAttribute('data-cut-start');
    expect(el).not.toHaveAttribute('data-cut-end');
  });

  it('ignores a remainder of under a pixel that cannot be scrolled to', () => {
    sized({ scrollWidth: 301, clientWidth: 300 });
    render(<Scroller />);
    expect(screen.getByTestId('scroller')).not.toHaveAttribute('data-cut-end');
  });

  it('marks the end at rest, then both ends, then the start as the user scrolls', () => {
    sized({ scrollWidth: 600, clientWidth: 300 });
    render(<Scroller />);
    const el = screen.getByTestId('scroller');
    expect(el).toHaveAttribute('data-cut-end');
    expect(el).not.toHaveAttribute('data-cut-start');

    el.scrollLeft = 150;
    fireEvent.scroll(el);
    expect(el).toHaveAttribute('data-cut-start');
    expect(el).toHaveAttribute('data-cut-end');

    el.scrollLeft = 300;
    fireEvent.scroll(el);
    expect(el).toHaveAttribute('data-cut-start');
    expect(el).not.toHaveAttribute('data-cut-end');
  });

  it('gives the width of a vertical scrollbar, which the fade must leave opaque', () => {
    sized({ scrollWidth: 600, clientWidth: 292, offsetWidth: 300 });
    render(<Scroller />);
    expect(screen.getByTestId('scroller').style.getPropertyValue('--scroll-gutter')).toBe('8px');
  });

  it('measures again when the scroller or its content resizes, and stops when unmounted', () => {
    const observed: Element[] = [];
    let resized = () => {};
    const disconnect = vi.fn();
    vi.spyOn(globalThis, 'ResizeObserver').mockImplementation(function (callback: ResizeObserverCallback) {
      resized = () => callback([], {} as ResizeObserver);
      return { observe: (el: Element) => observed.push(el), unobserve() {}, disconnect } as ResizeObserver;
    });
    sized({ scrollWidth: 300, clientWidth: 300 });
    const { unmount } = render(<Scroller />);
    const el = screen.getByTestId('scroller');
    expect(observed).toEqual([el, el.firstElementChild]);
    expect(el).not.toHaveAttribute('data-cut-end');

    sized({ scrollWidth: 600, clientWidth: 300 });
    resized();
    expect(el).toHaveAttribute('data-cut-end');

    unmount();
    expect(disconnect).toHaveBeenCalled();
  });
});
