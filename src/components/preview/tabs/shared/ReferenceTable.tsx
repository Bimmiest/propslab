import { useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../../../ui/Icon';
import { filterReference, type ReferenceCategory } from './referenceFilter';

/**
 * A collapsed-by-default, searchable reference table of directives grouped by
 * category, as the Regex and Timestamp tabs show. The rows are the caller's:
 * one tab's rows insert a pattern, the other's mark the directives in use.
 */
export function ReferenceTable<R>({
  title,
  searchLabel,
  searchPlaceholder,
  panelId,
  columns,
  categories,
  searchText,
  renderCategory,
}: {
  title: string;
  searchLabel: string;
  searchPlaceholder: string;
  /** The id of the expanded panel, for the toggle's aria-controls. */
  panelId?: string;
  /** Header cells, by their full class list. */
  columns: { label: string; className: string }[];
  categories: ReferenceCategory<R>[];
  /** The texts a search matches a row against. */
  searchText: (row: R) => string[];
  renderCategory: (category: ReferenceCategory<R>) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => filterReference(categories, search, searchText), [categories, search, searchText]);

  return (
    <div className="flex-shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <button
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={panelId}
        className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer text-left"
      >
        <Icon
          name="chevron-right"
          className="w-3 h-3 transition-transform flex-shrink-0"
          style={{ color: 'var(--color-text-muted)', transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
        />
        <span className="text-xs font-medium text-[var(--color-text-muted)]">{title}</span>
      </button>
      {open && (
        <div id={panelId} className="px-3 pb-2">
          <div className="relative mb-2">
            <Icon
              name="search"
              className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
              style={{ color: 'var(--color-text-muted)' }}
            />
            <input
              type="text"
              aria-label={searchLabel}
              placeholder={searchPlaceholder}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full max-w-xs pl-6 pr-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
            />
          </div>
          <div className="max-h-56 overflow-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                  {columns.map((c) => (
                    <th key={c.label} className={c.className}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>{filtered.map(renderCategory)}</tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
