import { Icon } from '../../../ui/Icon';
import type { PhaseFilter } from './data';

export function FieldsToolbar({
  search,
  setSearch,
  fieldCount,
  phaseFilter,
  setPhaseFilter,
  collapseToggle,
}: {
  search: string;
  setSearch: (value: string) => void;
  fieldCount: number;
  phaseFilter: PhaseFilter;
  setPhaseFilter: (value: PhaseFilter) => void;
  /** The expand/collapse-all control, when there are parents to fold. */
  collapseToggle: { allCollapsed: boolean; onToggle: () => void } | null;
}) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--color-border-subtle)] bg-[var(--color-bg-secondary)]">
      <div className="relative flex-1 max-w-[240px]">
        <Icon
          name="search"
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
          style={{ color: 'var(--color-text-muted)' }}
        />
        <input
          type="text"
          aria-label="Search fields"
          placeholder="Search fields..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
        />
      </div>
      <span className="text-xs text-[var(--color-text-muted)]">{fieldCount} fields</span>
      <div className="flex items-center gap-0.5 rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-px">
        {(['all', 'index-time', 'search-time'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setPhaseFilter(f)}
            // A toggle group: aria-pressed conveys the selected phase, which
            // styling alone does not.
            aria-pressed={phaseFilter === f}
            className={[
              'px-1.5 py-0.5 text-[10px] rounded transition-colors cursor-pointer border-none',
              phaseFilter === f
                ? 'bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)] font-medium shadow-sm'
                : 'text-[var(--color-text-muted)] hover:text-[var(--color-text-secondary)] bg-transparent',
            ].join(' ')}
          >
            {f === 'all' ? 'All' : f === 'index-time' ? 'Index-time' : 'Search-time'}
          </button>
        ))}
      </div>
      {collapseToggle && (
        <button
          className="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors cursor-pointer bg-transparent border-none p-0"
          onClick={collapseToggle.onToggle}
        >
          {collapseToggle.allCollapsed ? 'Expand all' : 'Collapse all'}
        </button>
      )}
    </div>
  );
}
