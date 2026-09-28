import { useCallback, useState } from 'react';
import { reconcileCollapsed } from '../shared/fieldCollapse';

/**
 * Which parents are collapsed. Every parent starts collapsed, including one
 * that first appears after a props.conf edit.
 */
export function useCollapsedParents(allParentNames: string[]) {
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set());
  // Parents already folded into the collapse decision, so new ones can be
  // collapsed on arrival without overriding the user's later choices.
  const [seenParents, setSeenParents] = useState<Set<string>>(() => new Set());

  const toggleCollapse = useCallback((parent: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent);
      else next.add(parent);
      return next;
    });
  }, []);

  // Reconcile during render (React's recommended pattern for derived state —
  // avoids a useEffect and its cascading render). This runs whenever a parent
  // the user has not seen appears, not only on the first pass, so a parent that
  // appears after a props.conf edit starts collapsed too.
  const reconciled = reconcileCollapsed(allParentNames, seenParents, collapsedParents);
  if (reconciled) {
    setCollapsedParents(reconciled.collapsed);
    setSeenParents(reconciled.seen);
  }

  const effectiveCollapsed = reconciled ? reconciled.collapsed : collapsedParents;
  return { effectiveCollapsed, setCollapsedParents, toggleCollapse };
}
