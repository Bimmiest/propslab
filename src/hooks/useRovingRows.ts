// ---------------------------------------------------------------------------
// useRovingRows.ts
// One Tab stop for a windowed list of rows (roving tabindex, as in the
// dictionary listbox): hundreds of `tabIndex=0` rows would make the list
// impossible to Tab past. Arrow keys, Home and End move between rows. Shared
// by the field tree and the Fields table (#745), whose rows also open their
// context menu from the keyboard once they can take the focus.
//
// Each focusable row carries `data-field-row={name}`, on or inside the element
// with its `data-window-index`.
// ---------------------------------------------------------------------------

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import type { WindowSegment } from './useWindowedRows';

export function useRovingRows<T extends HTMLElement>(
  names: readonly string[],
  segments: readonly WindowSegment[],
  scrollRef: RefObject<HTMLElement | null>,
) {
  // The roving row, by name so it survives a filter or a collapse reshaping
  // the list. If it is windowed out (or gone), the first rendered row takes
  // the tab stop, so the list can always be tabbed into.
  const [activeName, setActiveName] = useState<string | null>(null);
  const renderedIndexes = segments.flatMap((seg) => (seg.kind === 'row' ? [seg.index] : []));
  const activeIndex = activeName === null ? -1 : names.indexOf(activeName);
  const tabStopIndex = renderedIndexes.includes(activeIndex) ? activeIndex : (renderedIndexes[0] ?? -1);

  const containerRef = useRef<T>(null);
  const pendingFocus = useRef<number | null>(null);
  const focusRow = useCallback((index: number): boolean => {
    const at = `[data-window-index="${index}"]`;
    const el = containerRef.current?.querySelector<HTMLElement>(`${at}[data-field-row], ${at} [data-field-row]`);
    if (!el) return false;
    el.focus();
    el.scrollIntoView({ block: 'nearest' });
    return true;
  }, []);

  // A move to a row that was not rendered (Home/End across a long list)
  // scrolls it into the window first; the focus lands once it has mounted.
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index !== null && focusRow(index)) pendingFocus.current = null;
  }, [segments, focusRow]);

  const onFocus = (e: FocusEvent<HTMLElement>) => {
    const name = e.target instanceof HTMLElement ? e.target.dataset['fieldRow'] : undefined;
    if (name !== undefined) setActiveName(name);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    // Only from a row itself: keys in the context menu, portalled but still
    // inside this React subtree, are the menu's.
    const { target: source } = e;
    if (!(source instanceof HTMLElement) || source.dataset['fieldRow'] === undefined) return;
    const current = names.indexOf(source.dataset['fieldRow']);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(current + 1, names.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(current - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = names.length - 1;
    if (next < 0 || current < 0) return;
    e.preventDefault();
    const target = names[next];
    if (target === undefined) return;
    setActiveName(target);
    if (focusRow(next)) return;
    const scroller = scrollRef.current;
    if (!scroller) return;
    const rowHeight =
      containerRef.current?.querySelector<HTMLElement>('[data-window-row]')?.getBoundingClientRect().height || 24;
    pendingFocus.current = next;
    scroller.scrollTop = next * rowHeight;
  };

  return { containerRef, tabStopIndex, onFocus, onKeyDown };
}
