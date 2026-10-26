// ---------------------------------------------------------------------------
// useHighlightedFields.ts
// The Extractions tab's field state: categories and colours for the events
// shown. Which groups are collapsed is shared/useGroupCollapse.ts.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
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
