import { useEffect, type RefObject } from 'react';

/**
 * Marks which ends of a horizontal scroller cut off content, for the
 * `.scroll-fade` rule in index.css to fade (#893). A row of tabs or a table
 * cut at a pane's edge otherwise reads as complete, with no sign that it
 * scrolls.
 *
 * It writes the marks to the element itself (`data-cut-start`,
 * `data-cut-end`, and `--scroll-gutter` for a vertical scrollbar that the fade
 * must not cover), so a scroll does not re-render the component.
 */
export function useScrollFade(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const hidden = el.scrollWidth - el.clientWidth;
      // Sub-pixel layout can leave a remainder of under a pixel that nobody can scroll to.
      el.toggleAttribute('data-cut-start', el.scrollLeft > 1);
      el.toggleAttribute('data-cut-end', hidden - el.scrollLeft > 1);
      el.style.setProperty('--scroll-gutter', `${String(el.offsetWidth - el.clientWidth)}px`);
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    // The scroller and its content: a column resized or a tab label changed
    // alters what is cut without a scroll or a change to the scroller's size.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    observer?.observe(el);
    for (const child of el.children) observer?.observe(child);
    return () => {
      el.removeEventListener('scroll', update);
      observer?.disconnect();
    };
  }, [ref]);
}
