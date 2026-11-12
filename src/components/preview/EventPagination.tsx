import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { pageStart, parsePageInput } from '../../utils/pagination';

interface EventPaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  eventsPerPage: number;
  onPageChange: (page: number) => void;
  onEventsPerPageChange: (count: number) => void;
  /**
   * What the paged events have in common, appended to the summary
   * ("with src_ip"). Set while a pin narrows the Extractions tab, so the
   * footer does not count events that the tab does not show.
   */
  scope?: string;
}

/** The smallest page size: with no more events than this, there is nothing to choose. */
export const MIN_PAGE_SIZE = 5;

const PAGE_SIZE_OPTIONS = [MIN_PAGE_SIZE, 10, 25, 50];

// min-w-6/min-h-6: 24 px, the WCAG 2.2 minimum target size (2.5.8).
const BUTTON_CLASS =
  'inline-flex items-center justify-center min-w-6 min-h-6 px-1.5 rounded cursor-pointer border-none outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:enabled:bg-[var(--color-border)] press';

const CONTROL_STYLE = {
  backgroundColor: 'var(--color-bg-tertiary)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-control)',
};

/** The 1-based numbers of the first and the last item on `page`. */
function itemRange(page: number, perPage: number, totalItems: number): [number, number] {
  if (totalItems === 0) return [0, 0];
  return [pageStart(page, perPage) + 1, Math.min(page * perPage, totalItems)];
}

export function EventPagination({
  currentPage,
  totalPages,
  totalItems,
  eventsPerPage,
  onPageChange,
  onEventsPerPageChange,
  scope,
}: EventPaginationProps) {
  // Set only by the page controls, so a new run or a search that changes the
  // page count is not read out as if the user moved.
  const [announcement, setAnnouncement] = useState('');
  const [startItem, endItem] = itemRange(currentPage, eventsPerPage, totalItems);

  const goTo = (page: number) => {
    if (page === currentPage) return;
    onPageChange(page);
    const [first, last] = itemRange(page, eventsPerPage, totalItems);
    setAnnouncement(`Page ${page} of ${totalPages}, events ${first} to ${last}`);
  };

  const atFirst = currentPage <= 1;
  const atLast = currentPage >= totalPages;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs"
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <span style={{ color: 'var(--color-text-muted)' }}>
        Showing events {startItem}-{endItem} of {totalItems}
        {scope ? ` ${scope}` : ''}
      </span>

      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <PageSizeSelect value={eventsPerPage} onChange={onEventsPerPageChange} />

        <nav aria-label="Event pages" className="flex items-center gap-1">
          <PageButton icon="chevrons-left" label="First page" disabled={atFirst} onClick={() => goTo(1)} />
          <PageButton
            icon="chevron-left"
            label="Previous page"
            disabled={atFirst}
            onClick={() => goTo(currentPage - 1)}
          />
          <PageBox currentPage={currentPage} totalPages={totalPages} onGo={goTo} />
          <PageButton icon="chevron-right" label="Next page" disabled={atLast} onClick={() => goTo(currentPage + 1)} />
          <PageButton icon="chevrons-right" label="Last page" disabled={atLast} onClick={() => goTo(totalPages)} />
        </nav>
      </div>
    </div>
  );
}

function PageSizeSelect({ value, onChange }: { value: number; onChange: (count: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <label htmlFor="events-per-page" style={{ color: 'var(--color-text-muted)' }}>
        Per page:
      </label>
      <select
        id="events-per-page"
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="min-h-6 px-1.5 py-0.5 text-xs rounded cursor-pointer"
        style={CONTROL_STYLE}
      >
        {PAGE_SIZE_OPTIONS.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
    </div>
  );
}

/** "Page [n] of N": the box takes a page number, and goes there on Enter or when it loses the focus. */
function PageBox({
  currentPage,
  totalPages,
  onGo,
}: {
  currentPage: number;
  totalPages: number;
  onGo: (page: number) => void;
}) {
  const id = useId();
  // What the box shows while the user types; null shows the current page.
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft === null) return;
    const page = parsePageInput(draft, totalPages);
    if (page !== null) onGo(page);
    setDraft(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      setDraft(null);
    }
  };

  return (
    <span className="flex items-center gap-1 px-1 tabular-nums" style={{ color: 'var(--color-text-secondary)' }}>
      <label htmlFor={id}>Page</label>
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={draft ?? String(currentPage)}
        onChange={(e) => setDraft(e.target.value)}
        aria-describedby={`${id}-of`}
        onKeyDown={onKeyDown}
        onBlur={commit}
        onFocus={(e) => e.currentTarget.select()}
        disabled={totalPages <= 1}
        // Wide enough for the largest page number, so the row does not move.
        style={{ ...CONTROL_STYLE, width: `calc(${String(totalPages).length}ch + 1rem)` }}
        className="min-h-6 px-1 text-xs text-center rounded tabular-nums disabled:opacity-60"
      />
      <span id={`${id}-of`}>of {totalPages}</span>
    </span>
  );
}

function PageButton({
  icon,
  label,
  disabled,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} className={BUTTON_CLASS} aria-label={label}>
      <Icon name={icon} size={14} className="" />
    </button>
  );
}
