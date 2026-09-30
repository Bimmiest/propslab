import { useLayoutEffect, useMemo, useState } from 'react';
import type { EnrichedEvent } from '../enrichEvents';
import { FieldFocusContext, useFieldFocus } from './shared/useFieldFocus';
import { FieldSplitLayout } from './shared/FieldSplitLayout';
import { buildFieldTree } from './shared/fieldTreeUtils';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import type { FieldStats } from '../../../utils/fieldStats';
import { fieldNamesInView, type FieldFilter } from './highlighted/fieldColoring';
import { NO_BADGES, eventBadges, groupNames, selectRows } from './highlighted/eventRows';
import { useFieldColoring, useGroupCollapse } from './highlighted/useHighlightedFields';
import { HighlightedFilterBar } from './highlighted/HighlightedFilterBar';
import { HighlightedSidebar } from './highlighted/HighlightedSidebar';
import { HighlightedEventCard } from './highlighted/HighlightedEventCard';

/**
 * Upper bound on rows rendered while a field is pinned. A pin filters the whole
 * dataset rather than the current page, so without a cap a common field renders
 * every event at once.
 */
const MAX_PINNED_ROWS = 100;

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
}

export function HighlightedTab({ items, allEvents, currentPage, eventsPerPage, fieldStats }: HighlightedTabProps) {
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { store: focusStore, pinnedFields, togglePin, setHoveredField } = useFieldFocus();

  const { categories, containerFields, fieldColorMap, highlightColorMap } = useFieldColoring(allEvents, fieldFilter, fieldStats);

  // Pins follow the run: a pinned field the latest run no longer extracts is
  // unpinned before the tab is painted. Every field of the run, not
  // just of the events a search leaves, so a search does not drop a pin.
  const runFields = useMemo(
    () => new Set(fieldStats?.names ?? fieldNamesInView(allEvents, undefined)),
    [fieldStats, allEvents],
  );
  useLayoutEffect(() => focusStore.retainPins(runFields), [focusStore, runFields]);

  const pinMatches = useMemo(
    () => selectRows({ items, allEvents, currentPage, eventsPerPage }, pinnedFields),
    [items, allEvents, pinnedFields, currentPage, eventsPerPage],
  );

  // A pin spans the whole dataset by design, but rendering every match at once
  // locked the UI for seconds to minutes: pinning a field present in every event
  // (`host`, or any KV field common to all lines) mounted a FieldEventCard per
  // event, each running value segmentation and a context-menu root per span.
  // Cap the rendered window and say what was left out, rather than silently
  // truncating or silently hanging.
  const pinnedOverflow = pinnedFields.size > 0 && pinMatches.length > MAX_PINNED_ROWS;
  const filteredItems = useMemo(
    () => (pinnedOverflow ? pinMatches.slice(0, MAX_PINNED_ROWS) : pinMatches),
    [pinMatches, pinnedOverflow],
  );

  const tree = useMemo(
    () => buildFieldTree(fieldColorMap, containerFields, categories.fieldProcessorMap),
    [fieldColorMap, containerFields, categories.fieldProcessorMap]
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
        pinned={pinnedFields.size > 0 ? {
          matching: pinMatches.length,
          total: allEvents.length,
          count: pinnedFields.size,
          clear: () => { for (const f of pinnedFields) togglePin(f); },
        } : null}
        sidebarCollapsed={sidebarCollapsed}
        toggleSidebar={() => setSidebarCollapsed((v) => !v)}
      />

      <div className="flex-1 min-h-0 flex">
        <FieldSplitLayout
          storageKey="highlighted-split-layout"
          collapsed={sidebarCollapsed}
          sidebar={sidebar}
        >
          {pinnedOverflow && <PinnedOverflowNote total={pinMatches.length} />}
          {/*
            Extraction directives that ran against these events and produced no
            field — the case where this tab otherwise shows an event with
            nothing highlighted and no reason why.
          */}
          <div className="mb-2">
            <DirectiveNoOpList events={filteredItems.map(({ item }) => item.event)} phase="search-time" />
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

function PinnedOverflowNote({ total }: { total: number }) {
  return (
    <div
      className="px-3 py-2 mb-2 text-xs rounded"
      style={{
        backgroundColor: 'var(--color-bg-tertiary)',
        color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      Showing the first {MAX_PINNED_ROWS.toLocaleString()} of{' '}
      {total.toLocaleString()} events with a pinned field. Narrow the
      set with the search box, or unpin to page through every event.
    </div>
  );
}
