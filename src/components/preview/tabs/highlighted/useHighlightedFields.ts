// ---------------------------------------------------------------------------
// useHighlightedFields.ts
// The Extractions tab's field state: categories and colours for the events
// shown, and which groups of the field tree are collapsed.
// ---------------------------------------------------------------------------

import { useCallback, useMemo, useState } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import type { EnrichedEvent } from '../../enrichEvents';
import type { FieldStats } from '../../../../utils/fieldStats';
import {
  assignFieldColors,
  classifyFields,
  fieldNamesInView,
  findContainerFields,
  type FieldFilter,
} from './fieldColoring';

/** The fields' categories, and the colour each one the filter shows is drawn in. */
export function useFieldColoring(
  allEvents: EnrichedEvent[],
  fieldFilter: FieldFilter,
  fieldStats: FieldStats | undefined,
) {
  const categories = useMemo(() => classifyFields(allEvents), [allEvents]);
  const containerFields = useMemo(() => findContainerFields(allEvents, fieldStats), [allEvents, fieldStats]);
  const fieldNames = useMemo(() => fieldNamesInView(allEvents, fieldStats), [allEvents, fieldStats]);

  const theme = useAppStore((s) => s.theme);
  const fieldColorMap = useMemo(
    () => assignFieldColors(fieldNames, categories, fieldFilter, theme),
    [fieldNames, categories, fieldFilter, theme],
  );

  // JSON containers are listed in the sidebar but not highlighted in the event.
  const highlightColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, color] of fieldColorMap) {
      if (!containerFields.has(key)) map.set(key, color);
    }
    return map;
  }, [fieldColorMap, containerFields]);

  return { categories, containerFields, fieldColorMap, highlightColorMap };
}

/**
 * Which field-tree groups are collapsed: every group, until the user expands
 * it. Held as the set the user expanded, so a group that appears later (a
 * re-run, another filter) starts collapsed like the rest, and the collapsed
 * set is rebuilt only when the groups or the expansions change.
 */
export function useGroupCollapse(allGroupNames: string[]) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const collapsed = useMemo(() => new Set(allGroupNames.filter((g) => !expanded.has(g))), [allGroupNames, expanded]);

  const toggleGroup = useCallback((name: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /** Collapse every group, or expand every group there is now. */
  const setAllCollapsed = useCallback(
    (all: boolean) => {
      setExpanded(all ? new Set() : new Set(allGroupNames));
    },
    [allGroupNames],
  );

  return { collapsed, toggleGroup, setAllCollapsed };
}
