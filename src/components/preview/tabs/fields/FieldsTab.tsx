import { useState, useMemo, useCallback, useId } from 'react';
import { useAppStore } from '../../../../store/useAppStore';
import { buildParentIndex, isFieldVisible } from '../shared/fieldCollapse';
import { COLUMNS, type PhaseFilter, type SortDir, type SortKey } from './data';
import { aggregateFields, buildAliasMap, buildFieldRows, buildRowIds, countChildren } from './fieldRows';
import { useCollapsedParents } from './useCollapsedParents';
import { FieldsToolbar } from './FieldsToolbar';
import { FieldTableRow } from './FieldTableRow';
import { ResizableHeader } from './ResizableHeader';

export function FieldsTab() {
  const result = useAppStore((s) => s.processingResult);
  const events = useMemo(() => result?.events ?? [], [result]);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('count');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [phaseFilter, setPhaseFilter] = useState<PhaseFilter>('all');
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(
    () => Object.fromEntries(COLUMNS.map((c) => [c.key, c.defaultWidth]))
  );

  const handleSort = useCallback((key: SortKey) => {
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
  }, [sortKey]);

  const aliasMap = useMemo(() => buildAliasMap(events), [events]);

  // The events × fields × trace walk depends on the events alone, so it has its
  // own memo rather than re-running on every search keystroke and header click.
  const aggregatedFields = useMemo(() => aggregateFields(events, aliasMap), [events, aliasMap]);

  const fieldSummary = useMemo(
    () => buildFieldRows(aggregatedFields, search, phaseFilter, sortKey, sortDir),
    [aggregatedFields, search, sortKey, sortDir, phaseFilter],
  );

  // Auto-collapse all parents on initial load
  const allParentNames = useMemo(
    () => fieldSummary.filter((f) => f.isParent).map((f) => f.name),
    [fieldSummary]
  );
  const { effectiveCollapsed, setCollapsedParents, toggleCollapse } = useCollapsedParents(allParentNames);

  // Name → parent, so the ancestor walk below is O(depth) instead of scanning
  // the whole field list at every step.
  const parentIndex = useMemo(() => buildParentIndex(fieldSummary), [fieldSummary]);

  // Immediate-child counts for the collapsed "(n)" badge, counted in one pass.
  // Filtering the whole summary for each visible parent row was O(rows²) on
  // every render — noticeable on wide JSON events with many nested parents.
  const childCounts = useMemo(() => countChildren(fieldSummary), [fieldSummary]);

  const rowIdPrefix = useId();
  const { rowIds, childRowIds } = useMemo(() => buildRowIds(fieldSummary, rowIdPrefix), [fieldSummary, rowIdPrefix]);

  const allCollapsed = allParentNames.every((p) => effectiveCollapsed.has(p));

  return (
    <div className="flex flex-col h-full">
      <FieldsToolbar
        search={search}
        setSearch={setSearch}
        fieldCount={fieldSummary.length}
        phaseFilter={phaseFilter}
        setPhaseFilter={setPhaseFilter}
        collapseToggle={allParentNames.length > 0 ? {
          allCollapsed,
          onToggle: () => setCollapsedParents(allCollapsed ? new Set() : new Set(allParentNames)),
        } : null}
      />
      <div className="flex-1 overflow-auto">
        <table className="w-full text-xs border-collapse" style={{ minWidth: Object.values(columnWidths).reduce((a, b) => a + b, 0) }}>
          <thead className="sticky top-0 z-10 bg-[var(--color-bg-secondary)]">
            <tr className="text-left text-[var(--color-text-muted)] border-b border-[var(--color-border-subtle)]">
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
          </thead>
          <tbody>
            {fieldSummary
              .filter((field) => isFieldVisible(field, effectiveCollapsed, parentIndex))
              .map((field) => {
                const collapsed = effectiveCollapsed.has(field.name);
                return (
                  <FieldTableRow
                    key={field.name}
                    field={field}
                    rowId={rowIds.get(field.name)}
                    eventCount={events.length}
                    columnWidths={columnWidths}
                    collapsed={collapsed}
                    childCount={field.isParent ? childCounts.get(field.name) ?? 0 : 0}
                    // Only while expanded: collapsed, the child rows are not rendered.
                    controls={collapsed ? undefined : childRowIds.get(field.name)?.join(' ')}
                    onToggle={toggleCollapse}
                  />
                );
              })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
