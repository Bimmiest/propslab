import { useEffect, useRef } from 'react';
import { Icon } from '../../../ui/Icon';
import type { ColumnDef, SortDir, SortKey } from './data';

export function ResizableHeader({
  col,
  width,
  sortKey,
  sortDir,
  onSort,
  onResize,
}: {
  col: ColumnDef;
  width: number;
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (key: SortKey) => void;
  onResize: (width: number) => void;
}) {
  const isActive = sortKey === col.key;

  // Teardown for a drag in progress. Kept so an unmount mid-drag — the tab
  // switched, or a new result emptied the table — can remove the document
  // listeners and give the page its cursor and text selection back; mouseup
  // never arrives for a header that is gone.
  const endDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endDragRef.current?.(), []);

  // Attach the document-level drag listeners only for the duration of a resize.
  // Registering them once per column in an effect kept N global mousemove
  // handlers running for the table's whole lifetime, firing on every mouse move.
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    endDragRef.current?.();
    const startX = e.clientX;
    const startWidth = width;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMouseMove(ev: MouseEvent) {
      onResize(Math.max(col.minWidth, startWidth + (ev.clientX - startX)));
    }
    function endDrag() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', endDrag);
      endDragRef.current = null;
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', endDrag);
    endDragRef.current = endDrag;
  };

  return (
    <th
      className="relative py-2 px-3 font-medium select-none"
      style={{ width }}
      // Only the sorted column carries it, per the APG sortable-table pattern;
      // the arrow icon alone leaves the order invisible to a screen reader.
      aria-sort={isActive ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
    >
      <button
        className="flex items-center gap-1 cursor-pointer bg-transparent border-none p-0 font-medium text-xs"
        style={{ color: isActive ? 'var(--color-accent)' : 'var(--color-text-muted)' }}
        onClick={() => onSort(col.key)}
      >
        {col.label}
        <SortIndicator active={isActive} dir={sortDir} />
      </button>
      {/* Resize handle */}
      {/* A focusable separator, so the column can be resized from the
          keyboard as well as by dragging: Left/Right step by 10px, and Shift
          by 50px. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${col.label} column`}
        aria-valuenow={width}
        aria-valuemin={col.minWidth}
        tabIndex={0}
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-[var(--color-accent)] focus-visible:bg-[var(--color-accent)] transition-colors z-10"
        onMouseDown={startResize}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const step = (e.shiftKey ? 50 : 10) * (e.key === 'ArrowLeft' ? -1 : 1);
          onResize(Math.max(col.minWidth, width + step));
        }}
      />
    </th>
  );
}

function SortIndicator({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) return <Icon name="sort" className="w-3 h-3 opacity-30" />;
  return <Icon name={dir === 'asc' ? 'chevron-up' : 'chevron-down'} className="w-3 h-3" />;
}
