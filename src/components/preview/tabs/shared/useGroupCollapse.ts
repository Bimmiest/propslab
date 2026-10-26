import { useCallback, useMemo, useState } from 'react';

/**
 * Which field-tree groups are collapsed: every group, until the user expands
 * it. The Extractions tab's groups and the Fields tab's parents both use it. Held as the set the user expanded, so a group that appears later (a
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
