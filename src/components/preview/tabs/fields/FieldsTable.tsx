import { useMemo, useRef, type ReactNode } from 'react';
import { useWindowedRows } from '../../../../hooks/useWindowedRows';
import { COLUMNS } from './data';
import { controlledRowIds, renderedRowIds, type FieldRow } from './fieldRows';
import { FieldTableRow } from './FieldTableRow';

/**
 * The table itself, windowed (#454): a wide JSON event flattens to thousands
 * of fields, and only the rows near the viewport are rendered.
 */
export function FieldsTable({
  rows, rowIds, childRowIds, childCounts, collapsedParents, eventCount, columnWidths, onToggle, header,
}: {
  /** The visible rows: every field not hidden under a collapsed parent. */
  rows: FieldRow[];
  rowIds: Map<string, string>;
  childRowIds: Map<string, string[]>;
  childCounts: Map<string, number>;
  collapsedParents: Set<string>;
  eventCount: number;
  columnWidths: Record<string, number>;
  onToggle: (parent: string) => void;
  header: ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const { segments, onFocus } = useWindowedRows(scrollRef, rows.length, { estimate: 29 });
  // A toggle names only the child rows that exist: with the table windowed,
  // most of them may not be rendered.
  const rendered = useMemo(() => renderedRowIds(segments, rows, rowIds), [segments, rows, rowIds]);

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto" onFocus={onFocus}>
      <table
        className="w-full text-xs border-collapse"
        style={{ minWidth: Object.values(columnWidths).reduce((a, b) => a + b, 0) }}
        // The header row plus every visible field, rendered or not, so a
        // screen reader reports the table's real size when it is windowed.
        aria-rowcount={rows.length + 1}
      >
        <thead className="sticky top-0 z-10 bg-[var(--color-bg-secondary)]">{header}</thead>
        <tbody>
          {segments.map((seg) => {
            if (seg.kind === 'spacer') {
              return (
                <tr key={seg.key} aria-hidden="true" style={{ height: seg.height }}>
                  <td colSpan={COLUMNS.length} className="p-0" />
                </tr>
              );
            }
            const field = rows[seg.index];
            if (!field) return null;
            const collapsed = collapsedParents.has(field.name);
            return (
              <FieldTableRow
                key={field.name}
                field={field}
                rowId={rowIds.get(field.name)}
                rowIndex={seg.index}
                eventCount={eventCount}
                columnWidths={columnWidths}
                collapsed={collapsed}
                childCount={field.isParent ? childCounts.get(field.name) ?? 0 : 0}
                controls={controlledRowIds(childRowIds.get(field.name), collapsed, rendered)}
                onToggle={onToggle}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
