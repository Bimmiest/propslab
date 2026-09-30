import { createContext, useContext, useState, useSyncExternalStore } from 'react';
export { FIELD_COLORS, fieldColorAt } from './fieldColors';

export function isFieldActive(field: string, activeFields: Set<string> | null): boolean {
  return activeFields === null || activeFields.has(field);
}

export function isAnyFocused(activeFields: Set<string> | null): boolean {
  return activeFields !== null;
}

/**
 * Hover and pin state, held outside React state so that hovering a field does
 * not re-render the tab that owns it. Every card on the page used to re-render
 * on each hover; now each span subscribes to what it draws (see
 * `useFieldFocusState`), and only the spans whose look changes update.
 */
export interface FieldFocusStore {
  subscribe: (listener: () => void) => () => void;
  getPinned: () => Set<string>;
  /** Pinned fields if any, else the hovered one, else null. Stable between changes. */
  getActive: () => Set<string> | null;
  setHoveredField: (field: string | null) => void;
  togglePin: (field: string) => void;
  /**
   * Unpin every field not in `fields`. A pin on a field the latest run no
   * longer extracts has no sidebar entry to unpin it from, and would leave
   * the tab filtering to "0/N events" with nothing to show.
   */
  retainPins: (fields: ReadonlySet<string>) => void;
}

export function createFieldFocusStore(): FieldFocusStore {
  let pinned = new Set<string>();
  let hovered: string | null = null;
  let active: Set<string> | null = null;
  const listeners = new Set<() => void>();

  const update = () => {
    active = pinned.size > 0 ? pinned : hovered ? new Set([hovered]) : null;
    for (const l of listeners) l();
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getPinned: () => pinned,
    getActive: () => active,
    setHoveredField: (field) => {
      if (field === hovered) return;
      hovered = field;
      update();
    },
    togglePin: (field) => {
      const next = new Set(pinned);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      pinned = next;
      update();
    },
    retainPins: (fields) => {
      const kept = [...pinned].filter((f) => fields.has(f));
      if (kept.length === pinned.size) return;
      pinned = new Set(kept);
      update();
    },
  };
}

/** The store the highlighted spans below read; null draws everything unfocused. */
export const FieldFocusContext = createContext<FieldFocusStore | null>(null);

const noSubscribe = () => () => {};

/** The owning tab's store, plus the pins it filters rows by. Hover does not re-render the caller. */
export function useFieldFocus() {
  const [store] = useState(createFieldFocusStore);
  const pinnedFields = useSyncExternalStore(store.subscribe, store.getPinned);
  return { store, pinnedFields, togglePin: store.togglePin, setHoveredField: store.setHoveredField };
}

/** The whole active set, for the sidebar, which lists every field anyway. */
export function useActiveFields(store: FieldFocusStore): Set<string> | null {
  return useSyncExternalStore(store.subscribe, store.getActive);
}

/**
 * How one span should draw: `none` when nothing is focused, else whether its
 * field is `active` or dimmed. Pass no field for plain text, which is dimmed
 * whenever anything is focused. Returns a string so a hover elsewhere that
 * leaves this span's look alone does not re-render it.
 */
export function useFieldFocusState(field?: string): 'none' | 'active' | 'dim' {
  const store = useContext(FieldFocusContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, () => {
    const active = store?.getActive() ?? null;
    if (active === null) return 'none';
    return field !== undefined && active.has(field) ? 'active' : 'dim';
  });
}
