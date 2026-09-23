interface EventPaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  eventsPerPage: number;
  onPageChange: (page: number) => void;
  onEventsPerPageChange: (count: number) => void;
}

const PAGE_SIZE_OPTIONS = [5, 10, 25, 50];

export function EventPagination({
  currentPage,
  totalPages,
  totalItems,
  eventsPerPage,
  onPageChange,
  onEventsPerPageChange,
}: EventPaginationProps) {
  const startItem = totalItems === 0 ? 0 : (currentPage - 1) * eventsPerPage + 1;
  const endItem = Math.min(currentPage * eventsPerPage, totalItems);

  return (
    <div
      className="flex items-center justify-between px-3 py-2 text-xs"
      style={{
        backgroundColor: 'var(--color-bg-secondary)',
        borderTop: '1px solid var(--color-border)',
      }}
    >
      <span style={{ color: 'var(--color-text-muted)' }}>
        Showing events {startItem}-{endItem} of {totalItems}
      </span>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <label
            htmlFor="events-per-page"
            style={{ color: 'var(--color-text-muted)' }}
          >
            Per page:
          </label>
          <select
            id="events-per-page"
            value={eventsPerPage}
            onChange={(e) => onEventsPerPageChange(Number(e.target.value))}
            className="px-1.5 py-0.5 text-xs rounded cursor-pointer"
            style={{
              backgroundColor: 'var(--color-bg-tertiary)',
              color: 'var(--color-text-primary)',
              border: '1px solid var(--color-border)',
            }}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage <= 1}
            className="px-2 py-1 rounded cursor-pointer border-none outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:enabled:bg-[var(--color-border)]"
            aria-label="Previous page"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>

          <span
            className="px-1 tabular-nums"
            style={{ color: 'var(--color-text-secondary)' }}
          >
            Page {currentPage} of {totalPages}
          </span>

          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="px-2 py-1 rounded cursor-pointer border-none outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-40 bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] hover:enabled:bg-[var(--color-border)]"
            aria-label="Next page"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
