import { useState, useMemo, useCallback, useId } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import { buildParentIndex, isFieldVisible } from '../shared/fieldCollapse';
import { COLUMNS, type PhaseFilter, type SortDir, type SortKey } from './data';
import { aggregateFields, buildAliasMap, buildFieldRows, buildRowIds, countChildren } from './fieldRows';
import { useGroupCollapse } from '../shared/useGroupCollapse';
import { FieldsToolbar } from './FieldsToolbar';
import { FieldsTable } from './FieldsTable';
import { ResizableHeader } from './ResizableHeader';

export function FieldsTab() {
  const result = useAppStore((s) => s.processingResult);
  const events = useMemo(() => result?.events ?? [], [result]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('count');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('all');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(COLUMNS.map((c) => [c.key, c.defaultWidth])),
  );

  const handleSort = useCallback(
    (key: SortKey) => {
      // Don't nest a setSortDir call inside a setSortKey updater — that updater is
      // impure, so StrictMode's double-invoke queues two direction toggles that
      // cancel out and the active column's direction never flips in dev. Call both
      // setters at the top level; setSortDir uses a pure functional updater.
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'name' ? 'asc' : 'desc');
      }
    },
    [sortKey],
  );

  const aliasMap = useMemo(() => buildAliasMap(events), [events]);

  // The events × fields × trace walk depends on the events alone, so it has its
  // own memo rather than re-running on every search keystroke and header click.
  const aggregatedFields = useMemo(
    () => aggregateFields(events, aliasMap, result?.fieldStats),
    [events, aliasMap, result],
  );

  const fieldSummary = useMemo(
    () => buildFieldRows(aggregatedFields, search, phaseFilter, sortKey, sortDir),
    [aggregatedFields, search, sortKey, sortDir, phaseFilter],
  );

  // Every parent starts collapsed, including one that appears after an edit.
  const allParentNames = useMemo(() => fieldSummary.filter((f) => f.isParent).map((f) => f.name), [fieldSummary]);
  const { collapsed, toggleGroup, setAllCollapsed } = useGroupCollapse(allParentNames);

  // Name → parent, so the ancestor walk below is O(depth) instead of scanning
  // the whole field list at every step.
  const parentIndex = useMemo(() => buildParentIndex(fieldSummary), [fieldSummary]);

  // Immediate-child counts for the collapsed "(n)" badge, counted in one pass.
  // Filtering the whole summary for each visible parent row was O(rows²) on
  // every render — noticeable on wide JSON events with many nested parents.
  const childCounts = useMemo(() => countChildren(fieldSummary), [fieldSummary]);

  const rowIdPrefix = useId();
  const { rowIds, childRowIds } = useMemo(() => buildRowIds(fieldSummary, rowIdPrefix), [fieldSummary, rowIdPrefix]);

  const allCollapsed = allParentNames.every((p) => collapsed.has(p));

  const visibleRows = useMemo(
    () => fieldSummary.filter((field) => isFieldVisible(field, collapsed, parentIndex)),
    [fieldSummary, collapsed, parentIndex],
  );

  return (
    <div className="flex flex-col h-full">
      <FieldsToolbar
        search={search}
        setSearch={setSearch}
        fieldCount={fieldSummary.length}
        phaseFilter={phaseFilter}
        setPhaseFilter={setPhaseFilter}
        collapseToggle={
          allParentNames.length > 0
            ? {
                allCollapsed,
                onToggle: () => setAllCollapsed(!allCollapsed),
              }
            : null
        }
      />
      <FieldsTable
        rows={visibleRows}
        rowIds={rowIds}
        childRowIds={childRowIds}
        childCounts={childCounts}
        collapsedParents={collapsed}
        eventCount={events.length}
        columnWidths={columnWidths}
        onToggle={toggleGroup}
        header={
          <tr
            aria-rowindex={1}
            className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]"
          >
            {COLUMNS.map((col) => (
              <ResizableHeader
                key={col.key}
                col={col}
                width={columnWidths[col.key] ?? 0}
                sortKey={sortKey}
                sortDir={sortDir}
                onSort={handleSort}
                onResize={(w) => setColumnWidths((prev) => ({ ...prev, [col.key]: w }))}
              />
            ))}
          </tr>
        }
      />
    </div>
  );
}
