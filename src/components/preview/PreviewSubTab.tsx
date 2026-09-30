// ---------------------------------------------------------------------------
// PreviewSubTab.tsx
// The Preview output tab: the run's events, enriched and filtered, shown by
// one of five sub-tabs over a shared filter bar and pagination.
// ---------------------------------------------------------------------------

import { memo, useEffect, useId, useMemo } from 'react';
import type { ReactNode } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { Tabs } from '../ui/Tabs';
import { tabId, tabPanelId } from '../ui/tabIds';
import type { PreviewSubTabId } from '../../engine/types';
import { RawTab } from './tabs/RawTab';
import { HighlightedTab } from './tabs/HighlightedTab';
import { DiffTab } from './tabs/DiffTab';
import { TimestampTab } from './tabs/timestamp';
import { RegexTab } from './tabs/regex';
import { PreviewFilterBar } from './PreviewFilterBar';
import { EventPagination, MIN_PAGE_SIZE } from './EventPagination';
import { usePagination } from '../../hooks/usePagination';
import { useDebounce } from '../../hooks/useDebounce';
import type { PipelineInputs } from './tabs/shared/usePipelineInputs';
import { enrichEvents, type EnrichedEvent } from './enrichEvents';
import type { FieldStats } from '../../utils/fieldStats';
import { anyFilter, matchesFilters, pruneSelection } from './previewFilters';

/** How long the preview search waits for typing to pause before filtering. */
const SEARCH_DEBOUNCE_MS = 200;

const PREVIEW_SUB_TABS: { id: PreviewSubTabId; label: string }[] = [
  { id: 'raw', label: 'Raw' },
  { id: 'timestamp', label: 'Timestamp' },
  { id: 'highlighted', label: 'Extractions' },
  { id: 'diff', label: 'Diff' },
  { id: 'regex', label: 'Regex' },
];

/** What the preview's sub-tabs read of the pipeline inputs: the Timestamp tab's config. */
export type PreviewInputs = Pick<PipelineInputs, 'propsConf' | 'metadata'>;

/** What the sub-tabs read between them; each takes the part it needs. */
interface SubTabData {
  items: EnrichedEvent[];
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
  search: string;
  fieldStats: FieldStats | undefined;
  inputs: PreviewInputs;
}

/** The active sub-tab. Called in place, not rendered as a component, so the tab is the panel's direct child. */
function subTabContent(subTab: PreviewSubTabId, d: SubTabData): ReactNode {
  switch (subTab) {
    case 'raw':
      return <RawTab items={d.items} currentPage={d.currentPage} eventsPerPage={d.eventsPerPage} search={d.search} />;
    case 'highlighted':
      return <HighlightedTab items={d.items} allEvents={d.allEvents} currentPage={d.currentPage} eventsPerPage={d.eventsPerPage} fieldStats={d.fieldStats} />;
    case 'diff':
      return <DiffTab items={d.items} currentPage={d.currentPage} eventsPerPage={d.eventsPerPage} />;
    case 'timestamp':
      return <TimestampTab items={d.items} currentPage={d.currentPage} eventsPerPage={d.eventsPerPage} inputs={d.inputs} />;
    case 'regex':
      return <RegexTab items={d.items} allEvents={d.allEvents} currentPage={d.currentPage} eventsPerPage={d.eventsPerPage} />;
  }
}

export const PreviewSubTab = memo(function PreviewSubTab({ pipelineInputs }: { pipelineInputs: PreviewInputs }) {
  const result = useAppStore((s) => s.processingResult);
  const events = useMemo(() => result?.events ?? [], [result]);
  const originalRaw = result?.originalRaw ?? '';

  // In the store, not local state: this component unmounts on every output
  // tab switch, on a switch to the phone's other panels and across the phone
  // breakpoint, and the sub-tab and filters are expected to outlive all three.
  const subTab = useAppStore((s) => s.previewSubTab);
  const setSubTab = useAppStore((s) => s.setPreviewSubTab);
  const filters = useAppStore((s) => s.previewFilters);
  const setFilters = useAppStore((s) => s.setPreviewFilters);
  const { search, fields: selectedFields, status: selectedStatus, changeState: selectedChangeState } = filters;
  const subTabsId = useId();
  // The input stays bound to `search`, so typing is immediate; everything the
  // filter drives reads this settled copy, so a keystroke does not rebuild
  // `filteredEvents`, which re-scans every event, re-runs the Extractions tab's
  // JSON scan and re-posts the whole dataset to the Regex tab's matcher.
  const debouncedSearch = useDebounce(search, SEARCH_DEBOUNCE_MS);

  // The metadata of the run that produced these events, not the live fields:
  // compared with the live fields, every event would read as modified while the
  // user typed, and the event lists would rebuild on each keystroke.
  const originalMetadata = result?.inputMetadata;

  // Enrich events with original raw + change/drop status
  const enrichedEvents = useMemo(
    () => enrichEvents(events, originalRaw, originalMetadata),
    [events, originalRaw, originalMetadata],
  );

  // Every field of the run, counted with the result rather than walked here.
  const fieldStats = result?.fieldStats;
  const allFields = useMemo(() => [...(fieldStats?.names ?? [])].sort(), [fieldStats]);

  // A field a later run no longer extracts has no checkbox to untick, yet
  // would keep filtering (to "0 / N" if it was the only one), so it is dropped
  // from the selection: filtered by the pruned set at once, and the store
  // corrected after the commit, without moving the page.
  const liveSelectedFields = useMemo(() => pruneSelection(selectedFields, allFields), [selectedFields, allFields]);
  useEffect(() => {
    if (liveSelectedFields !== selectedFields) setFilters({ fields: liveSelectedFields }, true);
  }, [liveSelectedFields, selectedFields, setFilters]);

  // With no filter set, the very same array: the tabs below read that as
  // "every event" and use the run's precomputed statistics.
  const filteredEvents = useMemo(() => {
    const filters = { search: debouncedSearch.toLowerCase(), selectedFields: liveSelectedFields, selectedStatus, selectedChangeState };
    if (!anyFilter(filters)) return enrichedEvents;
    return enrichedEvents.filter((item) => matchesFilters(item, filters));
  }, [enrichedEvents, debouncedSearch, liveSelectedFields, selectedStatus, selectedChangeState]);

  const { paginatedItems, currentPage, totalPages, eventsPerPage, totalItems, setCurrentPage, setEventsPerPage } =
    usePagination(filteredEvents);
  // Present while there is a choice of page size to make: with more events
  // than the smallest page. Shown only past the current page size, choosing a
  // larger size hid the control, and it could not be set back down.

  return (
    <div className="flex flex-col h-full">
      {/* Sub-tab bar */}
      <div className="flex-shrink-0 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
        <Tabs
          idPrefix={subTabsId}
          tabs={PREVIEW_SUB_TABS}
          activeTab={subTab}
          onTabChange={(id) => setSubTab(id as PreviewSubTabId)}
          ariaLabel="Event preview sub-tabs"
          size="sm"
          variant="secondary"
        />
      </div>

      {/* Shared filter bar */}
      <PreviewFilterBar
        search={search}
        onSearchChange={(v) => setFilters({ search: v })}
        allFields={allFields}
        selectedFields={liveSelectedFields}
        onFieldsChange={(f) => setFilters({ fields: f })}
        selectedStatus={selectedStatus}
        onStatusChange={(s) => setFilters({ status: s })}
        selectedChangeState={selectedChangeState}
        onChangeStateChange={(m) => setFilters({ changeState: m })}
        filteredCount={filteredEvents.length}
        totalCount={enrichedEvents.length}
      />

      {/* Sub-tab content */}
      <div
        className="flex-1 min-h-0 overflow-auto"
        role="tabpanel"
        id={tabPanelId(subTabsId, subTab)}
        aria-labelledby={tabId(subTabsId, subTab)}
      >
        {subTabContent(subTab, {
          items: paginatedItems,
          allEvents: filteredEvents,
          currentPage,
          eventsPerPage,
          search: debouncedSearch,
          fieldStats,
          inputs: pipelineInputs,
        })}
      </div>

      {/* Shared pagination */}
      {totalItems > MIN_PAGE_SIZE && (
        <EventPagination
          currentPage={currentPage}
          totalPages={totalPages}
          totalItems={totalItems}
          eventsPerPage={eventsPerPage}
          onPageChange={setCurrentPage}
          onEventsPerPageChange={setEventsPerPage}
        />
      )}
    </div>
  );
});
