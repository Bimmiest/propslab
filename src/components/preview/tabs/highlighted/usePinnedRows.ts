// ---------------------------------------------------------------------------
// usePinnedRows.ts
// The rows the Extractions tab draws, and the pinned view it gives the shared
// pager: while a field is pinned, the pager pages through the events with it.
// ---------------------------------------------------------------------------

import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import { pageOfRows, pinScope, selectRows, type EventRow, type RowSource } from './eventRows';

/** The events a pin leaves, which the shared pager pages through instead of every event. */
export interface PinnedView {
  total: number;
  /** What the events have in common, for the pager's summary ("with src_ip"). */
  scope: string;
}

export interface PinnedRows {
  /** Every event with a pinned field, or the page's events when nothing is pinned. */
  pinMatches: EventRow[];
  /** The rows to draw: one page of `pinMatches`. */
  rows: EventRow[];
}

export function usePinnedRows(
  source: RowSource,
  pinnedFields: Set<string>,
  onPinnedViewChange?: (view: PinnedView | null) => void,
): PinnedRows {
  const { items, allEvents, currentPage, eventsPerPage } = source;
  const pinMatches = useMemo(
    () => selectRows({ items, allEvents, currentPage, eventsPerPage }, pinnedFields),
    [items, allEvents, pinnedFields, currentPage, eventsPerPage],
  );

  // A pin spans the whole dataset, and the shared pager pages through its
  // matches, so the page size bounds the cards rendered: each card runs value
  // segmentation, and a field on every event would otherwise mount them all.
  const pinned = pinnedFields.size > 0;
  const rows = useMemo(
    () => (pinned ? pageOfRows(pinMatches, currentPage, eventsPerPage) : pinMatches),
    [pinned, pinMatches, currentPage, eventsPerPage],
  );

  // Before paint, so the pager never shows the unpinned count under pinned rows.
  const pinnedTotal = pinned ? pinMatches.length : null;
  const scope = pinScope(pinnedFields);
  useLayoutEffect(() => {
    if (!onPinnedViewChange || pinnedTotal === null) return;
    onPinnedViewChange({ total: pinnedTotal, scope });
    return () => onPinnedViewChange(null);
  }, [onPinnedViewChange, pinnedTotal, scope]);

  // A new set of pins is a new list of events: start it at its first page.
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const shownPins = useRef(pinnedFields);
  useEffect(() => {
    if (shownPins.current === pinnedFields) return;
    shownPins.current = pinnedFields;
    setCurrentPage(1);
  }, [pinnedFields, setCurrentPage]);

  return { pinMatches, rows };
}
