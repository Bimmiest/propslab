import { useState, useMemo, useCallback, useEffect, useId, useRef } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { copyQuietly } from '../../../utils/clipboard';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuLabel } from '../../ui/ContextMenu';
import { buildParentIndex, isFieldVisible, reconcileCollapsed } from './shared/fieldCollapse';
import type { SplunkEvent } from '../../../engine/types';

type SortKey = 'name' | 'count' | 'distinct' | 'source' | 'aliases' | 'values';
type SortDir = 'asc' | 'desc';
type PhaseFilter = 'all' | 'index-time' | 'search-time';

interface ColumnDef {
  key: SortKey;
  label: string;
  defaultWidth: number;
  minWidth: number;
}

const COLUMNS: ColumnDef[] = [
  { key: 'name', label: 'Field Name', defaultWidth: 180, minWidth: 20 },
  { key: 'aliases', label: 'Aliases', defaultWidth: 140, minWidth: 20 },
  { key: 'count', label: 'Events', defaultWidth: 80, minWidth: 20 },
  { key: 'distinct', label: 'Distinct Values', defaultWidth: 100, minWidth: 20 },
  { key: 'source', label: 'Phase', defaultWidth: 150, minWidth: 20 },
  { key: 'values', label: 'Sample Values', defaultWidth: 300, minWidth: 20 },
];

/** One field, summarised across every event that has it. */
interface AggregatedField {
  name: string;
  values: Set<string>;
  count: number;
  sources: Set<string>;
  phases: Set<'index-time' | 'search-time'>;
  aliases: string[];
  /** Steps that rewrote _raw and changed this field's extracted value. */
  maskedBy: Set<string>;
}

/** A table row: a field, placed in the dotted-name tree. */
type FieldRow = AggregatedField & { isParent: boolean; depth: number; parentName: string | null };

/**
 * Alias mapping (target → source), read as data off the FIELDALIAS steps
 * rather than parsed out of `trace.description`, which is display text.
 */
function buildAliasMap(events: SplunkEvent[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const event of events) {
    for (const trace of event.processingTrace) {
      for (const { target, source } of trace.fieldAliases ?? []) {
        map.set(target, source);
      }
    }
  }
  return map;
}

function aggregateFields(events: SplunkEvent[], aliasMap: Map<string, string>): AggregatedField[] {
  const fields = new Map<string, AggregatedField>();

  for (const event of events) {
    // Entries this event contributed to, so the trace can be walked ONCE and
    // indexed into. Nesting the trace loop inside the field loop made this
    // O(fields × traces × fieldsAdded) per event — for a few hundred events
    // with a wide KV sourcetype, millions of `includes()` scans on every
    // re-render of the tab.
    const thisEvent = new Map<string, AggregatedField>();

    for (const [key, value] of Object.entries(event.fields)) {
      let entry = fields.get(key);
      if (!entry) {
        entry = { name: key, values: new Set(), count: 0, sources: new Set(), phases: new Set(), aliases: [], maskedBy: new Set() };
        fields.set(key, entry);
      }
      entry.count++;
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) entry.values.add(v);
      thisEvent.set(key, entry);
    }

    for (const trace of event.processingTrace) {
      for (const name of trace.fieldsAdded ?? []) {
        const entry = thisEvent.get(name);
        if (!entry) continue;
        entry.sources.add(trace.processor);
        entry.phases.add(trace.phase);
      }
      // The field extracts fine but an index-time rewrite destroyed its
      // value. Without this the row looks like a working extraction, and a
      // blank-looking value reads as "the extraction is wrong".
      for (const name of trace.fieldsModified ?? []) {
        thisEvent.get(name)?.maskedBy.add(trace.processor);
      }
    }
  }

  // Attach alias names to their source fields and remove alias entries as standalone rows
  for (const [target, source] of aliasMap) {
    const sourceEntry = fields.get(source);
    if (sourceEntry && !sourceEntry.aliases.includes(target)) {
      sourceEntry.aliases.push(target);
    }
    fields.delete(target);
  }

  return Array.from(fields.values());
}

/** Sort comparator based on current sort settings. */
function fieldComparator(sortKey: SortKey, sortDir: SortDir): (a: AggregatedField, b: AggregatedField) => number {
  const dir = sortDir === 'asc' ? 1 : -1;
  return (a, b) => {
    switch (sortKey) {
      case 'name': return dir * a.name.localeCompare(b.name);
      case 'count': return dir * (a.count - b.count);
      case 'distinct': return dir * (a.values.size - b.values.size);
      case 'source': {
        const aS = Array.from(a.sources).join(',');
        const bS = Array.from(b.sources).join(',');
        return dir * aS.localeCompare(bS);
      }
      case 'aliases': return dir * (a.aliases.length - b.aliases.length);
      case 'values': {
        const aV = Array.from(a.values).slice(0, 1).join('');
        const bV = Array.from(b.values).slice(0, 1).join('');
        return dir * aV.localeCompare(bV);
      }
      default: return 0;
    }
  };
}

/** Every field that has at least one child (another field prefixed with "field."). */
function findParentFields(allNames: Set<string>): Set<string> {
  const parentFields = new Set<string>();
  for (const name of allNames) {
    // Walk up all ancestor prefixes, e.g. "a.b.c" checks "a.b" then "a"
    const parts = name.split('.');
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join('.');
      if (allNames.has(ancestor)) {
        parentFields.add(ancestor);
      }
    }
  }
  return parentFields;
}

/** The nearest ancestor of `name` that exists as a field, or null. */
function immediateParent(name: string, allNames: Set<string>): string | null {
  const lastDot = name.lastIndexOf('.');
  if (lastDot === -1) return null;
  const candidate = name.substring(0, lastDot);
  // Walk up until we find an ancestor that exists as a field
  if (allNames.has(candidate)) return candidate;
  // If intermediate doesn't exist as a field, try higher ancestors
  return immediateParent(candidate, allNames);
}

/**
 * Arrange fields as a tree by dotted name, flattened with each child after its
 * parent. Top-level rows sort by the chosen key; children always sort by name
 * within their parent.
 */
function nestFields(entries: AggregatedField[], compare: (a: AggregatedField, b: AggregatedField) => number): FieldRow[] {
  const allNames = new Set(entries.map((e) => e.name));
  const parentFields = findParentFields(allNames);

  // Separate into top-level (no dot, or no existing parent field) and children
  const topLevel: AggregatedField[] = [];
  const childrenByParent = new Map<string, AggregatedField[]>();
  for (const entry of entries) {
    const immParent = immediateParent(entry.name, allNames);
    if (immParent === null) {
      topLevel.push(entry);
    } else {
      const siblings = childrenByParent.get(immParent) ?? [];
      siblings.push(entry);
      childrenByParent.set(immParent, siblings);
    }
  }

  topLevel.sort(compare);
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Flatten tree: recursively insert children after their parent
  const result: FieldRow[] = [];
  const insertWithChildren = (entry: AggregatedField, depth: number, parentName: string | null) => {
    result.push({ ...entry, isParent: parentFields.has(entry.name), depth, parentName });
    for (const child of childrenByParent.get(entry.name) ?? []) {
      insertWithChildren(child, depth + 1, entry.name);
    }
  };
  for (const entry of topLevel) {
    insertWithChildren(entry, 0, null);
  }
  return result;
}

/** The rows the table shows for a search, phase filter and sort. */
function buildFieldRows(
  aggregated: AggregatedField[],
  search: string,
  phaseFilter: PhaseFilter,
  sortKey: SortKey,
  sortDir: SortDir,
): FieldRow[] {
  // Filtered into a new array; the aggregated entries themselves are shared
  // with later passes and never mutated here.
  let entries = aggregated;
  if (search) {
    const lower = search.toLowerCase();
    entries = entries.filter((f) =>
      f.name.toLowerCase().includes(lower) ||
      f.aliases.some((a) => a.toLowerCase().includes(lower))
    );
  }
  if (phaseFilter !== 'all') {
    entries = entries.filter((f) => f.phases.has(phaseFilter));
  }
  return nestFields(entries, fieldComparator(sortKey, sortDir));
}

/**
 * Row ids, so a parent's toggle can name the child rows it shows and hides
 * in `aria-controls`. By position rather than by name: a field name
 * may hold spaces, which would split an id reference list.
 */
function buildRowIds(rows: FieldRow[], prefix: string): { rowIds: Map<string, string>; childRowIds: Map<string, string[]> } {
  const ids = new Map<string, string>();
  rows.forEach((f, i) => ids.set(f.name, `${prefix}-row-${i}`));
  const children = new Map<string, string[]>();
  for (const f of rows) {
    if (f.parentName === null) continue;
    const list = children.get(f.parentName) ?? [];
    list.push(ids.get(f.name) ?? '');
    children.set(f.parentName, list);
  }
  return { rowIds: ids, childRowIds: children };
}

/**
 * Which parents are collapsed. Every parent starts collapsed, including one
 * that first appears after a props.conf edit.
 */
function useCollapsedParents(allParentNames: string[]) {
  const [collapsedParents, setCollapsedParents] = useState<Set<string>>(() => new Set());
  // Parents already folded into the collapse decision, so new ones can be
  // collapsed on arrival without overriding the user's later choices.
  const [seenParents, setSeenParents] = useState<Set<string>>(() => new Set());

  const toggleCollapse = useCallback((parent: string) => {
    setCollapsedParents((prev) => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent);
      else next.add(parent);
      return next;
    });
  }, []);

  // Reconcile during render (React's recommended pattern for derived state —
  // avoids a useEffect and its cascading render). This runs whenever a parent
  // the user has not seen appears, not only on the first pass, so a parent that
  // appears after a props.conf edit starts collapsed too.
  const reconciled = reconcileCollapsed(allParentNames, seenParents, collapsedParents);
  if (reconciled) {
    setCollapsedParents(reconciled.collapsed);
    setSeenParents(reconciled.seen);
  }

  const effectiveCollapsed = reconciled ? reconciled.collapsed : collapsedParents;
  return { effectiveCollapsed, setCollapsedParents, toggleCollapse };
}

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
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of fieldSummary) {
      if (f.parentName !== null) counts.set(f.parentName, (counts.get(f.parentName) ?? 0) + 1);
    }
    return counts;
  }, [fieldSummary]);

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

function FieldsToolbar({
  search, setSearch, fieldCount, phaseFilter, setPhaseFilter, collapseToggle,
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
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 pointer-events-none"
          style={{ color: 'var(--color-text-muted)' }}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
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

function FieldTableRow({
  field, rowId, eventCount, columnWidths, collapsed, childCount, controls, onToggle,
}: {
  field: FieldRow;
  rowId: string | undefined;
  eventCount: number;
  columnWidths: Record<string, number>;
  collapsed: boolean;
  childCount: number;
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  return (
    <ContextMenu>
    <ContextMenuTrigger>
    <tr id={rowId} className="border-b border-[var(--color-border-subtle)] hover:bg-[var(--color-bg-secondary)] transition-colors">
      <td className="py-1.5 px-3 font-mono font-medium" style={{ width: columnWidths.name }}>
        <div className="flex items-center gap-1.5">
          <FieldNameCell
            name={field.name}
            depth={field.depth}
            isParent={field.isParent}
            parentName={field.parentName}
            collapsed={collapsed}
            childCount={childCount}
            controls={controls}
            onToggle={onToggle}
          />
          {field.maskedBy.size > 0 && (
            <span
              className="inline-block flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium font-sans bg-[var(--color-warning)]/10 text-[var(--color-warning)]"
              title={`Value rewritten at index time by ${Array.from(field.maskedBy).join(', ')}. The extraction works — the value it finds is not the original.`}
            >
              masked
            </span>
          )}
        </div>
      </td>
      <td className="py-1.5 px-3" style={{ width: columnWidths.aliases }}>
        {field.aliases.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {field.aliases.map((alias) => (
              <span
                key={alias}
                className="inline-block px-1.5 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-secondary)] font-mono text-xs"
                title={`FIELDALIAS: ${field.name} AS ${alias}`}
              >
                {alias}
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="py-1.5 px-3 text-[var(--color-text-secondary)]" style={{ width: columnWidths.count }}>
        {field.count}/{eventCount}
      </td>
      <td className="py-1.5 px-3 text-[var(--color-text-secondary)]" style={{ width: columnWidths.distinct }}>
        {field.values.size}
      </td>
      <td className="py-1.5 px-3" style={{ width: columnWidths.source }}>
        <div className="flex flex-wrap gap-1">
          {Array.from(field.phases).map((phase) => (
            <span
              key={phase}
              className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium"
              style={
                phase === 'index-time'
                  ? { backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)', opacity: 0.85 }
                  : { backgroundColor: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }
              }
              title={Array.from(field.sources).join(', ')}
            >
              {phase}
            </span>
          ))}
        </div>
      </td>
      <td className="py-1.5 px-3 font-mono text-[var(--color-text-secondary)] truncate" style={{ width: columnWidths.values, maxWidth: columnWidths.values }}>
        {Array.from(field.values).slice(0, 3).join(', ')}
      </td>
    </tr>
    </ContextMenuTrigger>
    <ContextMenuContent>
      <ContextMenuLabel>{field.name}</ContextMenuLabel>
      <ContextMenuItem onSelect={() => copyQuietly(field.name)}>Copy field name</ContextMenuItem>
      <ContextMenuItem onSelect={() => copyQuietly(Array.from(field.values).join(', '))}>Copy sample values</ContextMenuItem>
    </ContextMenuContent>
    </ContextMenu>
  );
}

/** The expand/collapse chevron on a parent field's row. */
function ToggleChevron({ name, collapsed, controls, onToggle }: {
  name: string;
  collapsed: boolean;
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  return (
    <button
      className="flex items-center justify-center w-4 h-4 rounded hover:bg-[var(--color-bg-tertiary)] cursor-pointer bg-transparent border-none p-0 transition-colors"
      onClick={() => onToggle(name)}
      // Named for the field it toggles, so a screen reader can tell a column
      // of them apart. The name stays fixed and `aria-expanded` carries the
      // state: a name that flipped between "Expand" and "Collapse" would
      // announce the change twice.
      aria-label={`Toggle ${name}`}
      aria-expanded={!collapsed}
      aria-controls={controls}
    >
      <svg
        className="w-3 h-3 transition-transform"
        style={{
          color: 'var(--color-text-muted)',
          transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
        }}
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </button>
  );
}

function FieldNameCell({
  name, depth, isParent, parentName, collapsed, childCount, controls, onToggle,
}: {
  name: string;
  depth: number;
  isParent: boolean;
  parentName: string | null;
  collapsed: boolean;
  childCount: number;
  /** Space-separated ids of the child rows the toggle shows and hides, when rendered. */
  controls: string | undefined;
  onToggle: (parent: string) => void;
}) {
  // Leaf name relative to immediate parent (e.g. "instanceId" from "responseElements.instancesSet.items.0.instanceId")
  const leafName = parentName ? name.substring(parentName.length + 1) : name;
  const chevron = <ToggleChevron name={name} collapsed={collapsed} controls={controls} onToggle={onToggle} />;

  if (depth === 0) {
    return (
      <span className="flex items-center gap-1 font-medium text-[var(--color-text-primary)]">
        {isParent && chevron}
        {name}
        {isParent && (
          <span
            className="text-[9px] px-1 py-px rounded"
            style={{ backgroundColor: 'var(--color-accent)', color: 'var(--color-text-on-accent)', opacity: 0.7 }}
          >
            JSON
          </span>
        )}
        {isParent && collapsed && (
          <span className="text-[9px] text-[var(--color-text-muted)]">
            ({childCount})
          </span>
        )}
      </span>
    );
  }

  // Sub-field: show indented with tree connector + optional expand chevron if it's also a parent
  return (
    <span
      className="flex items-center text-[var(--color-text-secondary)]"
      style={{ paddingLeft: `${Math.min(depth, 6) * 12 + (isParent ? 0 : 16)}px` }}
    >
      {isParent ? chevron : (
        <span className="text-[var(--color-text-muted)] mr-1" style={{ opacity: 0.4 }}>
          {'└─'}
        </span>
      )}
      <span title={name}>
        .{leafName}
      </span>
      {isParent && (
        <span
          className="text-[9px] px-1 py-px rounded ml-1"
          style={{ backgroundColor: 'var(--color-accent)', color: '#fff', opacity: 0.7 }}
        >
          JSON
        </span>
      )}
      {isParent && collapsed && (
        <span className="text-[9px] text-[var(--color-text-muted)] ml-1">
          ({childCount})
        </span>
      )}
    </span>
  );
}

function ResizableHeader({
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
  if (!active) {
    return (
      <svg className="w-3 h-3 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    );
  }
  if (dir === 'asc') {
    return (
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
    );
  }
  return (
    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}
