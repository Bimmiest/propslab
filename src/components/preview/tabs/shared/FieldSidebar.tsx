import { type ReactNode, type RefObject, useRef, useState } from 'react';
import { isAnyFocused } from './useFieldFocus';
import { Icon } from '../../../ui/Icon';

interface FieldSidebarProps {
  fieldCount: number;
  activeFields: Set<string> | null;
  onCollapse: () => void;
  /**
   * Render the item list given current search and focused state. `scrollRef`
   * is the list's scrolling container, for windowing.
   */
  renderItems: (search: string, focused: boolean, scrollRef: RefObject<HTMLDivElement | null>) => ReactNode;
  /** Optional controls rendered between search and the item list (e.g. expand/collapse all) */
  renderControls?: (search: string) => ReactNode;
}

export function FieldSidebar({
  fieldCount,
  activeFields,
  onCollapse,
  renderItems,
  renderControls,
}: FieldSidebarProps) {
  const [search, setSearch] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const focused = isAnyFocused(activeFields);
  const lowerSearch = search.toLowerCase();

  return (
    <div className="h-full flex flex-col bg-[var(--color-bg-secondary)]">
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-2 py-1.5 border-b border-[var(--color-border)]">
        <span className="text-[10px] font-medium text-[var(--color-text-muted)] uppercase tracking-wider">Fields</span>
        <button
          className="flex items-center justify-center w-5 h-5 rounded hover:bg-[var(--color-bg-tertiary)] cursor-pointer bg-transparent border-none p-0 transition-colors"
          onClick={onCollapse}
          title="Collapse field panel"
        >
          <Icon name="chevron-right" className="w-3.5 h-3.5" style={{ color: 'var(--color-text-muted)' }} />
        </button>
      </div>

      {/* Search + controls */}
      <div className="flex-shrink-0 px-2 py-2 border-b border-[var(--color-border)]">
        <div className="relative mb-1.5">
          <Icon
            name="search"
            className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
            style={{ color: 'var(--color-text-muted)' }}
          />
          <input
            type="text"
            aria-label="Filter fields"
            placeholder="Filter fields..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-6 pr-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {fieldCount} fields
          </span>
          {renderControls?.(lowerSearch)}
        </div>
      </div>

      {/* Item list */}
      <div ref={listRef} className="flex-1 overflow-auto px-1 py-1">
        {renderItems(lowerSearch, focused, listRef)}
      </div>
    </div>
  );
}
