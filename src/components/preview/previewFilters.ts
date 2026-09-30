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
      if (Object.hasOwn(item.event.fields, field)) { any = true; break; }
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
