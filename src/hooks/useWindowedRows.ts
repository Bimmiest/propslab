import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type FocusEvent, type RefObject } from 'react';

/** A rendered row, or blank space standing in for the rows not rendered. */
export type WindowSegment =
  | { kind: 'row'; index: number }
  | { kind: 'spacer'; key: string; height: number };

export interface WindowOptions {
  /** Row height to assume until one has been measured. */
  estimate: number;
  /** Rows rendered beyond each edge of the viewport, so Tab always has a next row. */
  overscan?: number;
  /** Below this many rows everything is rendered. */
  threshold?: number;
}

/** Viewport height assumed before the container has been laid out. */
const FALLBACK_VIEWPORT = 800;
/**
 * Scroll positions are tracked in steps this size, so a scroll re-renders the
 * list every few rows rather than every pixel; the overscan covers the slack.
 */
const SCROLL_STEP = 64;

/**
 * The rows to render for a scroll position, as segments in order.
 *
 * `pinned` is a row kept rendered wherever it is, so the row holding focus
 * is not unmounted (taking focus to <body>) when a wheel scroll moves the
 * window away from it.
 */
export function computeWindow(
  count: number,
  scrollTop: number,
  viewport: number,
  rowHeight: number,
  overscan: number,
  threshold: number,
  pinned: number | null,
): WindowSegment[] {
  const rows = (from: number, to: number): WindowSegment[] =>
    Array.from({ length: Math.max(0, to - from) }, (_, i) => ({ kind: 'row' as const, index: from + i }));
  if (count <= threshold) return rows(0, count);

  const height = viewport > 0 ? viewport : FALLBACK_VIEWPORT;
  const first = Math.floor(Math.max(0, scrollTop) / rowHeight);
  const start = Math.max(0, Math.min(count, first) - overscan);
  const end = Math.min(count, first + Math.ceil(height / rowHeight) + overscan);

  const out: WindowSegment[] = [];
  const spacer = (key: string, n: number) => {
    if (n > 0) out.push({ kind: 'spacer', key, height: n * rowHeight });
  };
  const pin = pinned !== null && pinned >= 0 && pinned < count && (pinned < start || pinned >= end) ? pinned : null;

  if (pin !== null && pin < start) {
    spacer('before-pinned', pin);
    out.push({ kind: 'row', index: pin });
    spacer('before', start - pin - 1);
  } else {
    spacer('before', start);
  }
  out.push(...rows(start, end));
  if (pin !== null && pin >= end) {
    spacer('after', pin - end);
    out.push({ kind: 'row', index: pin });
    spacer('after-pinned', count - pin - 1);
  } else {
    spacer('after', count - end);
  }
  return out;
}

/**
 * Render only the rows of a long list that are near the scroll viewport
 * (#454): a wide JSON event flattens to thousands of fields, and every row
 * was in the DOM.
 *
 * Rows are assumed to be one height, measured from the rendered rows (each
 * marked `data-window-row`) after every render, so a row that wraps shifts
 * the estimate rather than breaking it. The caller renders the segments in
 * order and spreads `onFocus` onto the scroll container; each row element
 * carries `data-window-index` so the focused one stays rendered.
 */
export function useWindowedRows(
  scrollRef: RefObject<HTMLElement | null>,
  count: number,
  { estimate, overscan = 12, threshold = 150 }: WindowOptions,
): { segments: WindowSegment[]; onFocus: (e: FocusEvent<HTMLElement>) => void } {
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [rowHeight, setRowHeight] = useState(estimate);
  const [pinned, setPinned] = useState<number | null>(null);
  const active = count > threshold;

  // A passive effect, not a layout one: the ref is often owned by an ancestor
  // (the field sidebar's list), whose host element is attached only after this
  // component's layout effects have run, so `scrollRef.current` was null on a
  // first mount and the listeners were never attached (#469). Refs are all
  // attached by the time passive effects run.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const onScroll = () => setScrollTop(Math.floor(el.scrollTop / SCROLL_STEP) * SCROLL_STEP);
    const measure = () => setViewport(el.clientHeight);
    onScroll();
    measure();
    el.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      observer?.disconnect();
    };
  }, [scrollRef, active]);

  const segments = useMemo(
    () => computeWindow(count, scrollTop, viewport, rowHeight, overscan, threshold, pinned),
    [count, scrollTop, viewport, rowHeight, overscan, threshold, pinned],
  );

  // Whenever the rendered rows change: rows that wrap make the real height
  // differ from the estimate, and the spacers are only right if the average is.
  // Layout, so a correction lands before paint; on a first mount under an
  // ancestor-owned ref the element is not attached yet, and the first
  // scroll/measure state change in the effect above re-runs this.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !active) return;
    const rendered = el.querySelectorAll<HTMLElement>('[data-window-row]');
    if (rendered.length === 0) return;
    let total = 0;
    for (const row of rendered) total += row.getBoundingClientRect().height;
    const measured = total / rendered.length;
    if (measured > 0 && Math.abs(measured - rowHeight) > 1) setRowHeight(measured);
  }, [scrollRef, active, segments, rowHeight]);

  const onFocus = useCallback((e: FocusEvent<HTMLElement>) => {
    const row = e.target.closest<HTMLElement>('[data-window-index]');
    const index = row ? Number(row.dataset['windowIndex']) : NaN;
    setPinned(Number.isInteger(index) ? index : null);
  }, []);

  return { segments, onFocus };
}
