// ---------------------------------------------------------------------------
// fieldSpans.ts
// The highlighted values of an event card, read off the DOM: the one context
// menu of the card asks which value a right-click or Shift+F10 landed on, and
// the arrow keys move between the values.
// ---------------------------------------------------------------------------

/** The attribute that marks a highlighted value with its field. */
export const FIELD_SELECTOR = '[data-field]';

/** The highlighted value that a contextmenu event landed on. */
export interface FieldTarget {
  field: string;
  /** The value of that occurrence, as its menu copies it. */
  value: string;
  pinned: boolean;
}

/** The highlighted value at or around `target`, inside `container`, or null for the rest of the card. */
export function fieldTargetOf(target: EventTarget | null, container: Element): FieldTarget | null {
  if (!(target instanceof Element)) return null;
  const span = target.closest<HTMLElement>(FIELD_SELECTOR);
  if (!span || !container.contains(span)) return null;
  const { field, value } = span.dataset;
  if (field === undefined) return null;
  return { field, value: value ?? span.textContent, pinned: span.getAttribute('aria-pressed') === 'true' };
}

/**
 * The index of the value a key moves the focus to, among `count` values, from
 * `index`; null for a key that does not move it. It stops at the ends.
 */
export function rovingIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return Math.min(index + 1, count - 1);
    case 'ArrowLeft':
      return Math.max(index - 1, 0);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
