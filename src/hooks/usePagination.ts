import { useEffect, useMemo } from 'react';
import { useAppStore } from '../store/useAppStore';
import { pageStart } from '../utils/pagination';

export function usePagination<T>(items: T[]) {
  const currentPage = useAppStore((s) => s.currentPage);
  const eventsPerPage = useAppStore((s) => s.eventsPerPage);
  const setCurrentPage = useAppStore((s) => s.setCurrentPage);
  const setEventsPerPage = useAppStore((s) => s.setEventsPerPage);

  const totalPages = Math.max(1, Math.ceil(items.length / eventsPerPage));

  // When the event count shrinks (e.g. a new pipeline run yields fewer events) the
  // stored currentPage can point past the last page and the view would show nothing.
  // Clamp for rendering immediately, and sync the store back to a valid page.
  const safePage = Math.min(currentPage, totalPages);
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages, setCurrentPage]);

  const paginatedItems = useMemo(() => {
    const start = pageStart(safePage, eventsPerPage);
    return items.slice(start, start + eventsPerPage);
  }, [items, safePage, eventsPerPage]);

  return {
    paginatedItems,
    currentPage: safePage,
    totalPages,
    eventsPerPage,
    totalItems: items.length,
    setCurrentPage,
    setEventsPerPage,
  };
}
