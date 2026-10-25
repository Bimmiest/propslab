import { useRef, type KeyboardEvent } from 'react';

/**
 * Roving-tabindex keyboard navigation for a tablist: only the active tab sits
 * in the tab order (the caller sets `tabIndex`), and the arrows, Home and End
 * select another tab and move the focus to it, wrapping at the ends.
 *
 * A vertical list is driven by Up/Down, and Left/Right are also accepted
 * because the pattern is muscle-memory from the horizontal tab strips.
 *
 * Put `ref` and `onKeyDown` on the `role="tablist"` element; its
 * `[role="tab"]` descendants must be in the order of `ids`.
 */
export function useRovingTabs<T extends string>(
  ids: readonly T[],
  activeId: T,
  onChange: (id: T) => void,
  orientation: 'horizontal' | 'vertical' = 'horizontal',
) {
  const ref = useRef<HTMLDivElement>(null);

  const onKeyDown = (e: KeyboardEvent) => {
    const current = ids.indexOf(activeId);
    const vertical = orientation === 'vertical';
    let next = -1;
    if (e.key === 'ArrowRight' || (vertical && e.key === 'ArrowDown')) next = (current + 1) % ids.length;
    else if (e.key === 'ArrowLeft' || (vertical && e.key === 'ArrowUp')) next = (current - 1 + ids.length) % ids.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = ids.length - 1;
    const target = ids[next];
    // Not a navigation key, or no tabs: leave the key to the browser.
    if (next < 0 || target === undefined) return;
    e.preventDefault();
    onChange(target);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return { ref, onKeyDown };
}
