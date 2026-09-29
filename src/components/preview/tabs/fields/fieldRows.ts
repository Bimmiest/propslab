import type { SplunkEvent } from '../../../../engine/types';
import type { WindowSegment } from '../../../../hooks/useWindowedRows';
import type { PhaseFilter, SortDir, SortKey } from './data';

/** One field, summarised across every event that has it. */
export interface AggregatedField {
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
export type FieldRow = AggregatedField & { isParent: boolean; depth: number; parentName: string | null };

/**
 * Alias mapping (target → source), read as data off the FIELDALIAS steps
 * rather than parsed out of `trace.description`, which is display text.
 */
export function buildAliasMap(events: SplunkEvent[]): Map<string, string> {
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

export function aggregateFields(events: SplunkEvent[], aliasMap: Map<string, string>): AggregatedField[] {
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
export function fieldComparator(sortKey: SortKey, sortDir: SortDir): (a: AggregatedField, b: AggregatedField) => number {
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
export function findParentFields(allNames: Set<string>): Set<string> {
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
export function immediateParent(name: string, allNames: Set<string>): string | null {
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
export function nestFields(entries: AggregatedField[], compare: (a: AggregatedField, b: AggregatedField) => number): FieldRow[] {
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
export function buildFieldRows(
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
export function buildRowIds(rows: FieldRow[], prefix: string): { rowIds: Map<string, string>; childRowIds: Map<string, string[]> } {
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

/** Each parent's number of immediate children, for the collapsed "(n)" badge. */
export function countChildren(rows: FieldRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const f of rows) {
    if (f.parentName !== null) counts.set(f.parentName, (counts.get(f.parentName) ?? 0) + 1);
  }
  return counts;
}

/**
 * Ids of the rows a windowed table renders (#454): with only the rows near
 * the viewport in the DOM, a toggle's `aria-controls` may name only these.
 */
export function renderedRowIds(segments: WindowSegment[], rows: FieldRow[], rowIds: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const seg of segments) {
    const name = seg.kind === 'row' ? rows[seg.index]?.name : undefined;
    const id = name === undefined ? undefined : rowIds.get(name);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * A parent's `aria-controls`: its child rows that are rendered, or nothing
 * while collapsed (the child rows are not rendered at all then).
 */
export function controlledRowIds(
  childIds: string[] | undefined,
  collapsed: boolean,
  rendered: Set<string>,
): string | undefined {
  if (collapsed) return undefined;
  return childIds?.filter((id) => rendered.has(id)).join(' ') || undefined;
}
