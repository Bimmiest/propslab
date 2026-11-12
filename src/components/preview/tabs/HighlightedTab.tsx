import { useLayoutEffect, useMemo, useState } from 'react';
import type { EnrichedEvent } from '../enrichEvents';
import { FieldFocusContext, useFieldFocus } from './shared/useFieldFocus';
import { FieldSplitLayout } from './shared/FieldSplitLayout';
import { buildFieldTree } from './shared/fieldTreeUtils';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import type { FieldStats } from '../../../utils/fieldStats';
import { fieldNamesInView, type FieldFilter } from './highlighted/fieldColoring';
import { NO_BADGES, eventBadges, groupNames } from './highlighted/eventRows';
import { usePinnedRows, type PinnedView } from './highlighted/usePinnedRows';
import { useFieldColoring } from './highlighted/useHighlightedFields';
import { useGroupCollapse } from './shared/useGroupCollapse';
import { HighlightedFilterBar } from './highlighted/HighlightedFilterBar';
import { HighlightedSidebar } from './highlighted/HighlightedSidebar';
import { HighlightedEventCard } from './highlighted/HighlightedEventCard';

export interface HighlightedTabProps {
  items: EnrichedEvent[];
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
  /**
   * The run's field statistics (`ViewResult.fieldStats`). While `allEvents`
   * is every event of the run, the field list is read from here instead of
   * walked; the JSON containers always are.
   */
  fieldStats?: FieldStats;
  /** Told the pinned view while a field is pinned, and null when no field is, or the tab unmounts. */
  onPinnedViewChange?: (view: PinnedView | null) => void;
}

export function HighlightedTab({
  items,
  allEvents,
  currentPage,
  eventsPerPage,
  fieldStats,
  onPinnedViewChange,
}: HighlightedTabProps) {
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { store: focusStore, pinnedFields, togglePin, setHoveredField } = useFieldFocus();

  const { categories, containerFields, fieldColorMap, highlightColorMap } = useFieldColoring(
    allEvents,
    fieldFilter,
    fieldStats,
  );

  // Pins follow the run: a pinned field the latest run no longer extracts is
  // unpinned before the tab is painted. Every field of the run, not
  // just of the events a search leaves, so a search does not drop a pin.
  const runFields = useMemo(
    () => new Set(fieldStats?.names ?? fieldNamesInView(allEvents, undefined)),
    [fieldStats, allEvents],
  );
  useLayoutEffect(() => focusStore.retainPins(runFields), [focusStore, runFields]);

  const { pinMatches, rows: filteredItems } = usePinnedRows(
    { items, allEvents, currentPage, eventsPerPage },
    pinnedFields,
    onPinnedViewChange,
  );

  // Every event the filters leave, not this page's: a directive that fires only
  // on another page would otherwise read as never fired (#772).
  const noOpEvents = useMemo(() => allEvents.map((item) => item.event), [allEvents]);

  const tree = useMemo(
    () => buildFieldTree(fieldColorMap, containerFields, categories.fieldProcessorMap),
    [fieldColorMap, containerFields, categories.fieldProcessorMap],
  );
  const allGroupNames = useMemo(() => groupNames(tree), [tree]);
  const { collapsed, toggleGroup, setAllCollapsed } = useGroupCollapse(allGroupNames);

  const eventBadgeCounts = useMemo(
    () => filteredItems.map(({ item }) => eventBadges(item, fieldFilter, highlightColorMap, categories)),
    [filteredItems, fieldFilter, highlightColorMap, categories],
  );

  const sidebar = (
    <HighlightedSidebar
      fieldCount={fieldColorMap.size}
      tree={tree}
      allGroupNames={allGroupNames}
      collapsed={collapsed}
      setAllCollapsed={setAllCollapsed}
      toggleGroup={toggleGroup}
      focusStore={focusStore}
      pinnedFields={pinnedFields}
      onCollapse={() => setSidebarCollapsed(true)}
    />
  );

  return (
    <FieldFocusContext.Provider value={focusStore}>
      <div className="flex flex-col h-full">
        <HighlightedFilterBar
          categories={categories}
          fieldFilter={fieldFilter}
          setFieldFilter={setFieldFilter}
          pinned={
            pinnedFields.size > 0
              ? {
                  matching: pinMatches.length,
                  total: allEvents.length,
                  count: pinnedFields.size,
                  clear: () => {
                    for (const f of pinnedFields) togglePin(f);
                  },
                }
              : null
          }
          sidebarCollapsed={sidebarCollapsed}
          toggleSidebar={() => setSidebarCollapsed((v) => !v)}
        />

        <div className="flex-1 min-h-0 flex">
          <FieldSplitLayout storageKey="highlighted-split-layout" collapsed={sidebarCollapsed} sidebar={sidebar}>
            {/*
            Extraction directives that ran and produced no field — the case
            where this tab otherwise shows an event with nothing highlighted
            and no reason why.
          */}
            <div className="mb-2">
              <DirectiveNoOpList events={noOpEvents} phase="search-time" />
            </div>
            {filteredItems.map(({ item, globalIdx }, idx) => (
              <HighlightedEventCard
                key={globalIdx}
                item={item}
                globalIdx={globalIdx}
                badges={eventBadgeCounts[idx] ?? NO_BADGES}
                highlightColorMap={highlightColorMap}
                fieldColorMap={fieldColorMap}
                categories={categories}
                pinnedFields={pinnedFields}
                togglePin={togglePin}
                setHoveredField={setHoveredField}
              />
            ))}
          </FieldSplitLayout>
        </div>
      </div>
    </FieldFocusContext.Provider>
  );
}
