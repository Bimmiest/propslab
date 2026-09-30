// ---------------------------------------------------------------------------
// HighlightedSidebar.tsx
// The Extractions tab's field tree, with hover and pin.
// ---------------------------------------------------------------------------

import { FieldSidebar } from '../shared/FieldSidebar';
import { FieldTreeList } from '../shared/FieldTreeNode';
import type { FieldNode } from '../shared/fieldTreeUtils';
import { useActiveFields, type FieldFocusStore } from '../shared/useFieldFocus';

export function HighlightedSidebar({
  fieldCount, tree, allGroupNames, collapsed, setAllCollapsed, toggleGroup, focusStore, pinnedFields, onCollapse,
}: {
  fieldCount: number;
  tree: FieldNode[];
  allGroupNames: string[];
  collapsed: Set<string>;
  setAllCollapsed: (collapsed: boolean) => void;
  toggleGroup: (name: string) => void;
  focusStore: FieldFocusStore;
  pinnedFields: Set<string>;
  onCollapse: () => void;
}) {
  // The sidebar lists every field, so it takes the whole active set, and
  // subscribes here so a hover re-renders it without the cards beside it.
  const activeFields = useActiveFields(focusStore);
  const allCollapsed = allGroupNames.every((g) => collapsed.has(g));
  return (
    <FieldSidebar
      fieldCount={fieldCount}
      activeFields={activeFields}
      onCollapse={onCollapse}
      renderControls={() =>
        allGroupNames.length > 0 ? (
          <button
            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors cursor-pointer bg-transparent border-none p-0"
            onClick={() => setAllCollapsed(!allCollapsed)}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        ) : null
      }
      renderItems={(search, _focused, scrollRef) => (
        <FieldTreeList
          tree={tree}
          search={search}
          scrollRef={scrollRef}
          collapsed={collapsed}
          toggleGroup={toggleGroup}
          activeFields={activeFields}
          pinnedFields={pinnedFields}
          onHover={focusStore.setHoveredField}
          onClick={focusStore.togglePin}
        />
      )}
    />
  );
}
