import { useEffect, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

/**
 * How a disclosure popover closes: on Escape, with focus back on its trigger;
 * on a Tab that leaves it, so it does not cover whatever the user has moved
 * on to; and on a press outside. Spread the handlers on the element that holds
 * both the trigger and the popup.
 */
export function usePopoverDismiss(
  ref: RefObject<HTMLElement | null>,
  triggerRef: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
): { onKeyDown: (e: KeyboardEvent) => void; onBlur: (e: FocusEvent) => void } {
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [ref, open, close]);

  return {
    onKeyDown: (e) => {
      if (e.key === 'Escape' && open) {
        e.stopPropagation();
        close();
        triggerRef.current?.focus();
      }
    },
    // Only a move to a known element outside closes it. A press on something
    // unfocusable inside the popup (its padding, an option's label text) moves
    // focus to the nearest focusable ancestor: none (a null relatedTarget), or
    // an ancestor such as the skip link's <main tabIndex={-1}> (#751). The
    // outside-mousedown handler already covers a press that is truly outside.
    onBlur: (e) => {
      const next = e.relatedTarget as Node | null;
      if (open && next && ref.current && !ref.current.contains(next) && !next.contains(ref.current)) close();
    },
  };
}
