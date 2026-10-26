// ---------------------------------------------------------------------------
// previewFilters.ts
// The Preview tab's filter bar as predicates over enriched events.
// ---------------------------------------------------------------------------

import type { EnrichedEvent } from './enrichEvents';

export interface ActiveFilters {
  search: string;
  selectedFields: ReadonlySet<string>;
  selectedStatus: ReadonlySet<string>;
  selectedChangeState: ReadonlySet<string>;
}

/**
 * The Status and Changes states that the run's events have, in display order
 * (#752). Status is offered only when an event was dropped, and Changes only
 * when an event's _raw or metadata changed: otherwise each would only select
 * every event or none.
 */
export function filterOptions(events: readonly EnrichedEvent[]): { status: string[]; changeState: string[] } {
  let accepted = false;
  let dropped = false;
  let raw = false;
  let meta = false;
  let unmodified = false;
  for (const e of events) {
    if (e.isDropped) dropped = true;
    else accepted = true;
    if (e.hasChanges) raw = true;
    if (e.hasMetadataChanges) meta = true;
    if (!e.hasChanges && !e.hasMetadataChanges) unmodified = true;
  }
  const status: string[] = [];
  if (dropped) {
    if (accepted) status.push('Accepted');
    status.push('Dropped');
  }
  const changeState: string[] = [];
  if (raw || meta) {
    if (raw) changeState.push('Raw Modified');
    if (meta) changeState.push('Metadata Modified');
    if (unmodified) changeState.push('Unmodified');
  }
  return { status, changeState };
}

/** `selected` without the entries `options` lacks; the same set when none are missing. */
export function pruneSelection(selected: ReadonlySet<string>, options: string[]): ReadonlySet<string> {
  if (selected.size === 0) return selected;
  const available = new Set(options);
  const kept = [...selected].filter((s) => available.has(s));
  return kept.length === selected.size ? selected : new Set(kept);
}

/** Whether any filter would remove an event. */
export function anyFilter({ search, selectedFields, selectedStatus, selectedChangeState }: ActiveFilters): boolean {
  return search !== '' || selectedFields.size > 0 || selectedStatus.size > 0 || selectedChangeState.size > 0;
}

/** `filters.search` is lower-cased by the caller, once for the whole pass. */
export function matchesFilters(item: EnrichedEvent, filters: ActiveFilters): boolean {
  const { search, selectedFields, selectedStatus, selectedChangeState } = filters;
  if (search && !item.searchText.includes(search)) return false;
  if (selectedFields.size > 0) {
    let any = false;
    for (const field of selectedFields) {
      if (Object.hasOwn(item.event.fields, field)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  if (selectedStatus.size > 0) {
    if (selectedStatus.has('Dropped') && !selectedStatus.has('Accepted') && !item.isDropped) return false;
    if (selectedStatus.has('Accepted') && !selectedStatus.has('Dropped') && item.isDropped) return false;
  }
  if (selectedChangeState.size > 0) {
    const wantRaw = selectedChangeState.has('Raw Modified');
    const wantMeta = selectedChangeState.has('Metadata Modified');
    const wantUnmodified = selectedChangeState.has('Unmodified');
    const matchesRaw = item.hasChanges;
    const matchesMeta = item.hasMetadataChanges;
    const matchesUnmodified = !item.hasChanges && !item.hasMetadataChanges;
    const matches = (wantRaw && matchesRaw) || (wantMeta && matchesMeta) || (wantUnmodified && matchesUnmodified);
    if (!matches) return false;
  }
  return true;
}
