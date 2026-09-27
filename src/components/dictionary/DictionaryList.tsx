import { useRef, type KeyboardEvent } from 'react';
import { Icon } from '../ui/Icon';
import { Chip, FileBadge, PhaseBadge } from './DictionaryBadges';
import { groupEntries, type DictionaryEntry, type DictionaryFilters } from './entries';

/** Segmented single-choice control used by the phase and file filters. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex rounded-md overflow-hidden border"
        style={{ borderColor: 'var(--color-border)' }}
      >
        {options.map((option) => {
          const isActive = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(option.value)}
              className={[
                'flex-1 min-w-0 truncate px-2 py-1 text-[11px] font-medium cursor-pointer border-none',
                'outline-none focus-visible:ring-2 transition-colors',
                isActive
                  ? 'bg-[var(--color-accent)] text-[var(--color-text-on-accent)]'
                  : 'bg-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]',
              ].join(' ')}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DictionaryFilterBar({
  filters,
  onChange,
  resultCount,
  totalCount,
}: {
  filters: DictionaryFilters;
  onChange: (next: DictionaryFilters) => void;
  resultCount: number;
  totalCount: number;
}) {
  return (
    <div
      className="shrink-0 flex flex-col gap-3 px-3 py-3 border-b"
      style={{ borderColor: 'var(--color-border-subtle)' }}
    >
      <div
        className="flex items-center gap-2 px-2 rounded-md border"
        style={{ borderColor: 'var(--color-border)', backgroundColor: 'var(--color-bg-primary)' }}
      >
        <Icon name="search" className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-muted)]" />
        <input
          type="search"
          value={filters.search}
          onChange={(e) => onChange({ ...filters, search: e.target.value })}
          placeholder="Search directives…"
          aria-label="Search directives"
          className="flex-1 min-w-0 h-8 bg-transparent text-xs outline-none placeholder:text-[var(--color-text-muted)]"
          style={{ color: 'var(--color-text-primary)' }}
        />
      </div>

      <Segmented
        label="Phase"
        value={filters.phase}
        onChange={(phase) => onChange({ ...filters, phase })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'index-time', label: 'Index' },
          { value: 'search-time', label: 'Search' },
        ]}
      />

      <Segmented
        label="File"
        value={filters.file}
        onChange={(file) => onChange({ ...filters, file })}
        options={[
          { value: 'all', label: 'All' },
          { value: 'props.conf', label: 'props' },
          { value: 'transforms.conf', label: 'transforms' },
        ]}
      />

      <label className="flex items-center gap-2 text-[11px] cursor-pointer text-[var(--color-text-secondary)]">
        <input
          type="checkbox"
          checked={filters.hideDeprecated}
          onChange={(e) => onChange({ ...filters, hideDeprecated: e.target.checked })}
          className="accent-[var(--color-accent)] cursor-pointer"
        />
        Hide deprecated
      </label>

      <p className="text-[10px] text-[var(--color-text-muted)]" role="status" aria-live="polite">
        {resultCount === totalCount
          ? `${totalCount} entries`
          : `${resultCount} of ${totalCount} entries`}
      </p>
    </div>
  );
}

/**
 * The browse list: entries grouped by category, with stanza headers first.
 *
 * Implemented as a listbox rather than a stack of buttons so that arrow keys
 * walk the results — with 80-odd entries, tabbing through every row to reach
 * the one you want is not a real option.
 */
/**
 * DOM id for an option row. Entry ids contain characters that are legal in an
 * id but awkward to select for (`stanza:source`), so they are sanitised rather
 * than used raw.
 */
function optionDomId(entryId: string): string {
  return `dict-option-${entryId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

export function DictionaryList({
  entries,
  selectedId,
  onSelect,
}: {
  entries: DictionaryEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const groups = groupEntries(entries);

  const handleKeyDown = (e: KeyboardEvent) => {
    const current = entries.findIndex((entry) => entry.id === selectedId);
    let next = -1;
    if (e.key === 'ArrowDown') next = Math.min(current + 1, entries.length - 1);
    else if (e.key === 'ArrowUp') next = Math.max(current - 1, 0);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = entries.length - 1;
    if (next < 0 || next === current) return;
    e.preventDefault();
    const target = entries[next];
    if (!target) return;
    onSelect(target.id);
    listRef.current
      ?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(target.id)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  };

  if (entries.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center px-4">
        <p className="text-xs text-center text-[var(--color-text-muted)]">
          No directives match these filters.
        </p>
      </div>
    );
  }

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Splunk directives"
      tabIndex={0}
      // The options are not individually focusable — focus stays on the listbox
      // and moves the selection, which is what lets one Tab stop cover 80 rows.
      aria-activedescendant={selectedId ? optionDomId(selectedId) : undefined}
      onKeyDown={handleKeyDown}
      // `@container` so the rows can respond to the PANEL's width rather than
      // the viewport's — the list is resizable, so a viewport breakpoint would
      // describe the wrong box entirely.
      className="@container flex-1 min-h-0 overflow-y-auto py-1 outline-none focus-visible:ring-2 focus-visible:ring-inset"
    >
      {groups.map(({ group, entries: items }) => (
        <div key={group} role="group" aria-label={group}>
          <p
            className="sticky top-0 z-10 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
            style={{ backgroundColor: 'var(--color-bg-secondary)' }}
          >
            {group}
          </p>
          {items.map((entry) => {
            const isSelected = entry.id === selectedId;
            return (
              <div
                key={entry.id}
                role="option"
                id={optionDomId(entry.id)}
                data-entry-id={entry.id}
                aria-selected={isSelected}
                onClick={() => onSelect(entry.id)}
                className={[
                  'flex items-center gap-1.5 px-3 py-1.5 cursor-pointer transition-colors',
                  isSelected
                    ? 'bg-[var(--color-accent)]/15'
                    : 'hover:bg-[var(--color-bg-tertiary)]',
                ].join(' ')}
                style={
                  isSelected
                    ? { boxShadow: 'inset 2px 0 0 var(--color-accent)' }
                    : undefined
                }
              >
                <span
                  className="flex-1 min-w-0 truncate text-[11px] font-mono"
                  style={{
                    color: isSelected ? 'var(--color-accent)' : 'var(--color-text-primary)',
                  }}
                >
                  {entry.title}
                </span>
                {/* Dropped once the panel is too narrow to hold a key beside
                    them — a truncated key is worse than an absent badge, and
                    the detail pane repeats both anyway. */}
                <span className="hidden @[260px]:flex items-center gap-1.5">
                  {entry.kind === 'directive' ? (
                    <>
                      <FileBadge appliesTo={entry.info.appliesTo} short />
                      <PhaseBadge phase={entry.info.phase} />
                    </>
                  ) : (
                    <>
                      <FileBadge appliesTo="props.conf" short />
                      <Chip>stanza</Chip>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
