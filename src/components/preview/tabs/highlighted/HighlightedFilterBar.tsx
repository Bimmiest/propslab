// ---------------------------------------------------------------------------
// HighlightedFilterBar.tsx
// The Extractions tab's toolbar: the category filter, the pinned-field
// summary and the sidebar toggle.
// ---------------------------------------------------------------------------

import { useMemo } from 'react';
import type { FieldCategories, FieldFilter } from './fieldColoring';

export function HighlightedFilterBar({
  categories,
  fieldFilter,
  setFieldFilter,
  pinned,
  sidebarCollapsed,
  toggleSidebar,
}: {
  categories: FieldCategories;
  fieldFilter: FieldFilter;
  setFieldFilter: (filter: FieldFilter) => void;
  /** The pinned-field summary, when anything is pinned. */
  pinned: { matching: number; total: number; count: number; clear: () => void } | null;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}) {
  const { autoFields, manualFields, calcFields } = categories;
  // Category membership overlaps by design (see assignFieldColors), so summing
  // the three sizes double-counts a field that is, say, both manual and calc —
  // and the sidebar a few pixels away shows the DISTINCT count. Union, so the
  // two labels agree by construction rather than by coincidence.
  const distinctFieldCount = useMemo(
    () => new Set([...autoFields, ...manualFields, ...calcFields]).size,
    [autoFields, manualFields, calcFields],
  );

  const filterButtons: { id: FieldFilter; label: string; count: number }[] = [
    { id: 'auto', label: 'Auto', count: autoFields.size },
    { id: 'manual', label: 'Manual', count: manualFields.size },
    { id: 'calc', label: 'Calculated', count: calcFields.size },
    { id: 'all', label: 'All', count: distinctFieldCount },
  ];

  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-text-muted)]">Show:</span>
        <div className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden">
          {filterButtons.map(({ id, label, count }) => (
            <button
              key={id}
              type="button"
              aria-pressed={fieldFilter === id}
              onClick={() => setFieldFilter(id)}
              className="px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
              style={{
                backgroundColor: fieldFilter === id ? 'var(--color-accent)' : 'transparent',
                color: fieldFilter === id ? 'var(--color-text-on-accent)' : 'var(--color-text-muted)',
              }}
            >
              {label}
              {count > 0 && <span className="ml-1">({count})</span>}
            </button>
          ))}
        </div>

        {pinned && (
          <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
            {pinned.matching}/{pinned.total} events match {pinned.count} pinned field{pinned.count > 1 ? 's' : ''}
            <button
              type="button"
              onClick={pinned.clear}
              className="text-[10px] text-[var(--color-accent)] hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              Clear
            </button>
          </span>
        )}

        {/* Fields sidebar toggle — right-aligned */}
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Show fields sidebar' : 'Hide fields sidebar'}
          className={[
            'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors ml-auto',
            !sidebarCollapsed
              ? 'bg-[var(--color-bg-elevated)] border-[var(--color-border)] text-[var(--color-text-primary)] shadow-sm'
              : 'border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]',
          ].join(' ')}
        >
          <svg
            className="w-3.5 h-3.5 flex-shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          Fields
        </button>
      </div>
    </div>
  );
}
