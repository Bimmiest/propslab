import { memo, useCallback, useMemo, useState } from 'react';
import { getField, hasField } from '../../../engine/utils/fieldBag';
import type { EnrichedEvent } from '../PreviewPanel';
import {
  FieldFocusContext, fieldColorAt, useActiveFields, useFieldFocus, useFieldFocusState, type FieldFocusStore,
} from './shared/useFieldFocus';
import { useAppStore } from '../../../store/useAppStore';
import { FieldEventCard } from './shared/FieldEventCard';
import { FieldSidebar } from './shared/FieldSidebar';
import { FieldSplitLayout } from './shared/FieldSplitLayout';
import { FieldTreeNode } from './shared/FieldTreeNode';
import { buildFieldTree } from './shared/fieldTreeUtils';
import type { FieldNode } from './shared/fieldTreeUtils';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import { pressable } from '../../ui/pressable';
import { tint } from '../../../utils/tint';

const AUTO_PROCESSORS = ['KV_MODE', 'INDEXED_EXTRACTIONS'];
const MANUAL_PROCESSORS = ['EXTRACT', 'REPORT', 'TRANSFORMS', 'RULESET', 'SEDCMD'];
/**
 * Upper bound on rows rendered while a field is pinned. A pin filters the whole
 * dataset rather than the current page, so without a cap a common field renders
 * every event at once.
 */
const MAX_PINNED_ROWS = 100;

function isAutoProcessor(p: string) { return AUTO_PROCESSORS.some((a) => p.startsWith(a)); }
function isManualProcessor(p: string) { return MANUAL_PROCESSORS.some((m) => p.startsWith(m)); }

type FieldFilter = 'auto' | 'manual' | 'calc' | 'all';

function isJsonContainer(value: string | string[]): boolean {
  if (Array.isArray(value)) return false;
  const t = value.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { JSON.parse(t); return true; } catch { return false; }
  }
  return false;
}

export interface HighlightedTabProps {
  items: EnrichedEvent[];
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

/** Which category each extracted field falls in, and the processor that produced it. */
interface FieldCategories {
  autoFields: Set<string>;
  manualFields: Set<string>;
  calcFields: Set<string>;
  fieldProcessorMap: Map<string, string>;
}

function classifyFields(allEvents: EnrichedEvent[]): FieldCategories {
  const auto = new Set<string>();
  const manual = new Set<string>();
  const calc = new Set<string>();
  const processorMap = new Map<string, string>();
  for (const { event } of allEvents) {
    for (const step of event.processingTrace) {
      if (!step.fieldsAdded) continue;
      if (isAutoProcessor(step.processor)) {
        for (const f of step.fieldsAdded) {
          auto.add(f);
          if (!processorMap.has(f)) processorMap.set(f, step.processor);
        }
      } else if (isManualProcessor(step.processor)) {
        for (const f of step.fieldsAdded) {
          manual.add(f);
          processorMap.set(f, step.processor);
        }
      } else if (step.processor === 'EVAL') {
        for (const f of step.fieldsAdded) {
          calc.add(f);
          processorMap.set(f, 'EVAL');
        }
      }
    }
  }
  return { autoFields: auto, manualFields: manual, calcFields: calc, fieldProcessorMap: processorMap };
}

function findContainerFields(allEvents: EnrichedEvent[]): Set<string> {
  const containers = new Set<string>();
  for (const { event } of allEvents) {
    for (const [key, value] of Object.entries(event.fields)) {
      if (isJsonContainer(value)) containers.add(key);
    }
  }
  return containers;
}

/** A colour for each field the filter shows, in first-seen order. */
function assignFieldColors(
  allEvents: EnrichedEvent[],
  { autoFields, manualFields, calcFields }: FieldCategories,
  fieldFilter: FieldFilter,
  theme: 'light' | 'dark',
): Map<string, string> {
  const map = new Map<string, string>();
  let colorIdx = 0;
  const includeAuto = fieldFilter === 'auto' || fieldFilter === 'all';
  const includeManual = fieldFilter === 'manual' || fieldFilter === 'all';
  const includeCalc = fieldFilter === 'calc' || fieldFilter === 'all';

  for (const { event } of allEvents) {
    for (const key of Object.keys(event.fields)) {
      // Membership, not single-bucket: a field extracted (manual) and then
      // overwritten by EVAL (calc) belongs to BOTH categories, so it must show
      // under each of their filters — and stay consistent with the filter counts.
      const inSelectedFilter =
        (includeAuto && autoFields.has(key)) || (includeManual && manualFields.has(key)) || (includeCalc && calcFields.has(key));
      if (!inSelectedFilter) continue;
      if (!map.has(key)) {
        map.set(key, fieldColorAt(colorIdx, theme));
        colorIdx++;
      }
    }
  }
  return map;
}

interface EventRow {
  item: EnrichedEvent;
  globalIdx: number;
}

/**
 * The rows to render. Each carries its TRUE global event index so the "Event #"
 * badge stays correct whether we're showing a paginated page or a pin-filtered
 * view. When fields are pinned the filter spans every event (a pin is a global
 * filter), so we index into allEvents rather than reusing the current page's
 * offset math.
 */
function selectRows(
  { items, allEvents, currentPage, eventsPerPage }: HighlightedTabProps,
  pinnedFields: Set<string>,
): EventRow[] {
  if (pinnedFields.size === 0) {
    const offset = (currentPage - 1) * eventsPerPage;
    return items.map((item, i) => ({ item, globalIdx: offset + i + 1 }));
  }
  const out: EventRow[] = [];
  allEvents.forEach((item, i) => {
    for (const pinned of pinnedFields) {
      // `in` walks the prototype chain, so pinning a field named `toString`
      // would match every event in the dataset.
      if (hasField(item.event.fields, pinned)) {
        out.push({ item, globalIdx: i + 1 });
        break;
      }
    }
  });
  return out;
}

function groupNames(tree: FieldNode[]): string[] {
  const groups: string[] = [];
  function walk(nodes: FieldNode[]) {
    for (const n of nodes) { if (n.children.length > 0) { groups.push(n.name); walk(n.children); } }
  }
  walk(tree);
  return groups;
}

interface CalcField {
  name: string;
  expression: string;
  value: string | string[];
}

interface EventBadges {
  eventCalcFields: CalcField[];
  autoCount: number;
  manualCount: number;
  calcCount: number;
}

/** The per-category counts an event's card is badged with, and its calculated fields. */
function eventBadges(
  item: EnrichedEvent,
  fieldFilter: FieldFilter,
  highlightColorMap: Map<string, string>,
  { manualFields, calcFields }: FieldCategories,
): EventBadges {
  const eventFields = Object.keys(item.event.fields).filter((f) => highlightColorMap.has(f));
  // Straight off the EVAL step: the expressions that actually ran for THIS
  // event, already resolved through stanza matching, line continuations and
  // the parser's case-sensitivity rule — none of which a scan of the raw
  // props.conf text would honour.
  const showCalcStrip = fieldFilter === 'calc' || fieldFilter === 'all';
  const evalTrace = item.event.processingTrace.find((t) => t.processor === 'EVAL');
  const eventCalcFields = showCalcStrip
    ? Object.entries(evalTrace?.evalExpressions ?? {}).flatMap(([name, expression]) => {
        const value = getField(item.event.fields, name);
        if (value === undefined || value === 'null' || value === '') return [];
        return [{ name, expression, value }];
      })
    : [];
  let autoCount = 0;
  let manualCount = 0;
  if (fieldFilter === 'auto') {
    autoCount = eventFields.length;
  } else if (fieldFilter === 'manual') {
    manualCount = eventFields.length;
  } else if (fieldFilter !== 'calc') {
    for (const f of eventFields) {
      if (calcFields.has(f)) { /* counted above */ }
      else if (manualFields.has(f)) manualCount++;
      else autoCount++;
    }
  }
  return { eventCalcFields, autoCount, manualCount, calcCount: eventCalcFields.length };
}

/**
 * Which field-tree groups are collapsed. Until the user toggles one, every
 * group is collapsed.
 */
function useGroupCollapse(allGroupNames: string[]) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
  const effectiveCollapsed = collapsedGroups ?? new Set(allGroupNames);

  const toggleGroup = useCallback((name: string) => {
    setCollapsedGroups((prev) => {
      const base = prev ?? new Set(allGroupNames);
      const next = new Set(base);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, [allGroupNames]);

  return { effectiveCollapsed, setCollapsedGroups, toggleGroup };
}

/** The fields' categories, and the colour each one the filter shows is drawn in. */
function useFieldColoring(allEvents: EnrichedEvent[], fieldFilter: FieldFilter) {
  const categories = useMemo(() => classifyFields(allEvents), [allEvents]);
  const containerFields = useMemo(() => findContainerFields(allEvents), [allEvents]);

  const theme = useAppStore((s) => s.theme);
  const fieldColorMap = useMemo(
    () => assignFieldColors(allEvents, categories, fieldFilter, theme),
    [allEvents, categories, fieldFilter, theme],
  );

  // JSON containers are listed in the sidebar but not highlighted in the event.
  const highlightColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, color] of fieldColorMap) {
      if (!containerFields.has(key)) map.set(key, color);
    }
    return map;
  }, [fieldColorMap, containerFields]);

  return { categories, containerFields, fieldColorMap, highlightColorMap };
}

export function HighlightedTab({ items, allEvents, currentPage, eventsPerPage }: HighlightedTabProps) {
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { store: focusStore, pinnedFields, togglePin, setHoveredField } = useFieldFocus();

  const { categories, containerFields, fieldColorMap, highlightColorMap } = useFieldColoring(allEvents, fieldFilter);

  const pinMatches = useMemo(
    () => selectRows({ items, allEvents, currentPage, eventsPerPage }, pinnedFields),
    [items, allEvents, pinnedFields, currentPage, eventsPerPage],
  );

  // A pin spans the whole dataset by design, but rendering every match at once
  // locked the UI for seconds to minutes: pinning a field present in every event
  // (`host`, or any KV field common to all lines) mounted a FieldEventCard per
  // event, each running value segmentation and a context-menu root per span.
  // Cap the rendered window and say what was left out, rather than silently
  // truncating or silently hanging.
  const pinnedOverflow = pinnedFields.size > 0 && pinMatches.length > MAX_PINNED_ROWS;
  const filteredItems = useMemo(
    () => (pinnedOverflow ? pinMatches.slice(0, MAX_PINNED_ROWS) : pinMatches),
    [pinMatches, pinnedOverflow],
  );

  const tree = useMemo(
    () => buildFieldTree(fieldColorMap, containerFields, categories.fieldProcessorMap),
    [fieldColorMap, containerFields, categories.fieldProcessorMap]
  );
  const allGroupNames = useMemo(() => groupNames(tree), [tree]);
  const { effectiveCollapsed, setCollapsedGroups, toggleGroup } = useGroupCollapse(allGroupNames);

  const eventBadgeCounts = useMemo(
    () => filteredItems.map(({ item }) => eventBadges(item, fieldFilter, highlightColorMap, categories)),
    [filteredItems, fieldFilter, highlightColorMap, categories],
  );

  const sidebar = (
    <HighlightedSidebar
      fieldCount={fieldColorMap.size}
      tree={tree}
      allGroupNames={allGroupNames}
      effectiveCollapsed={effectiveCollapsed}
      setCollapsedGroups={setCollapsedGroups}
      toggleGroup={toggleGroup}
      focusStore={focusStore}
      pinnedFields={pinnedFields}
      onCollapse={() => setSidebarCollapsed(true)}
    />
  );

  return (
    <FieldFocusContext.Provider value={focusStore}>
    <div className="flex flex-col h-full">
      <FilterBar
        categories={categories}
        fieldFilter={fieldFilter}
        setFieldFilter={setFieldFilter}
        pinned={pinnedFields.size > 0 ? {
          matching: pinMatches.length,
          total: allEvents.length,
          count: pinnedFields.size,
          clear: () => { for (const f of pinnedFields) togglePin(f); },
        } : null}
        sidebarCollapsed={sidebarCollapsed}
        toggleSidebar={() => setSidebarCollapsed((v) => !v)}
      />

      <div className="flex-1 min-h-0 flex">
        <FieldSplitLayout
          storageKey="highlighted-split-layout"
          collapsed={sidebarCollapsed}
          sidebar={sidebar}
        >
          {pinnedOverflow && <PinnedOverflowNote total={pinMatches.length} />}
          {/*
            Extraction directives that ran against these events and produced no
            field — the case where this tab otherwise shows an event with
            nothing highlighted and no reason why.
          */}
          <div className="mb-2">
            <DirectiveNoOpList events={filteredItems.map(({ item }) => item.event)} phase="search-time" />
          </div>
          {filteredItems.map(({ item, globalIdx }, idx) => (
            <HighlightedEventCard
              key={globalIdx}
              item={item}
              globalIdx={globalIdx}
              badges={eventBadgeCounts[idx] ?? { eventCalcFields: [], autoCount: 0, manualCount: 0, calcCount: 0 }}
              highlightColorMap={highlightColorMap}
              fieldColorMap={fieldColorMap}
              categories={categories}
              pinnedFields={pinnedFields}
              togglePin={togglePin}
              setHoveredField={setHoveredField}
            />
          ))}
        </FieldSplitLayout>
      </div>
    </div>
    </FieldFocusContext.Provider>
  );
}

function FilterBar({ categories, fieldFilter, setFieldFilter, pinned, sidebarCollapsed, toggleSidebar }: {
  categories: FieldCategories;
  fieldFilter: FieldFilter;
  setFieldFilter: (filter: FieldFilter) => void;
  /** The pinned-field summary, when anything is pinned. */
  pinned: { matching: number; total: number; count: number; clear: () => void } | null;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}) {
  const { autoFields, manualFields, calcFields } = categories;
  // Category membership overlaps by design (see assignFieldColors), so summing
  // the three sizes double-counts a field that is, say, both manual and calc —
  // and the sidebar a few pixels away shows the DISTINCT count. Union, so the
  // two labels agree by construction rather than by coincidence.
  const distinctFieldCount = useMemo(
    () => new Set([...autoFields, ...manualFields, ...calcFields]).size,
    [autoFields, manualFields, calcFields],
  );

  const filterButtons: { id: FieldFilter; label: string; count: number }[] = [
    { id: 'auto', label: 'Auto', count: autoFields.size },
    { id: 'manual', label: 'Manual', count: manualFields.size },
    { id: 'calc', label: 'Calculated', count: calcFields.size },
    { id: 'all', label: 'All', count: distinctFieldCount },
  ];

  return (
    <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-text-muted)]">Show:</span>
        <div className="inline-flex rounded-md border border-[var(--color-border)] overflow-hidden">
          {filterButtons.map(({ id, label, count }) => (
            <button
              key={id}
              onClick={() => setFieldFilter(id)}
              className="px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
              style={{
                backgroundColor: fieldFilter === id ? 'var(--color-accent)' : 'transparent',
                color: fieldFilter === id ? 'var(--color-text-on-accent)' : 'var(--color-text-muted)',
              }}
            >
              {label}
              {count > 0 && <span className="ml-1">({count})</span>}
            </button>
          ))}
        </div>

        {pinned && (
          <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
            {pinned.matching}/{pinned.total} events match {pinned.count} pinned field{pinned.count > 1 ? 's' : ''}
            <button
              type="button"
              onClick={pinned.clear}
              className="text-[10px] text-[var(--color-accent)] hover:underline bg-transparent border-none p-0 cursor-pointer"
            >
              Clear
            </button>
          </span>
        )}

        {/* Fields sidebar toggle — right-aligned */}
        <button
          type="button"
          onClick={toggleSidebar}
          title={sidebarCollapsed ? 'Show fields sidebar' : 'Hide fields sidebar'}
          className={[
            'flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors ml-auto',
            !sidebarCollapsed
              ? 'bg-[var(--color-bg-elevated)] border-[var(--color-border)] text-[var(--color-text-primary)] shadow-sm'
              : 'border-transparent text-[var(--color-text-muted)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-secondary)]',
          ].join(' ')}
        >
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
          Fields
        </button>
      </div>
    </div>
  );
}

function HighlightedSidebar({
  fieldCount, tree, allGroupNames, effectiveCollapsed, setCollapsedGroups, toggleGroup, focusStore, pinnedFields, onCollapse,
}: {
  fieldCount: number;
  tree: FieldNode[];
  allGroupNames: string[];
  effectiveCollapsed: Set<string>;
  setCollapsedGroups: (groups: Set<string>) => void;
  toggleGroup: (name: string) => void;
  focusStore: FieldFocusStore;
  pinnedFields: Set<string>;
  onCollapse: () => void;
}) {
  // The sidebar lists every field, so it takes the whole active set, and
  // subscribes here so a hover re-renders it without the cards beside it.
  const activeFields = useActiveFields(focusStore);
  const allCollapsed = allGroupNames.every((g) => effectiveCollapsed.has(g));
  return (
    <FieldSidebar
      fieldCount={fieldCount}
      activeFields={activeFields}
      onCollapse={onCollapse}
      renderControls={() =>
        allGroupNames.length > 0 ? (
          <button
            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors cursor-pointer bg-transparent border-none p-0"
            onClick={() => setCollapsedGroups(allCollapsed ? new Set() : new Set(allGroupNames))}
          >
            {allCollapsed ? 'Expand all' : 'Collapse all'}
          </button>
        ) : null
      }
      renderItems={(search) =>
        tree.map((node) => (
          <FieldTreeNode
            key={node.name}
            node={node}
            collapsed={effectiveCollapsed}
            toggleGroup={toggleGroup}
            activeFields={activeFields}
            pinnedFields={pinnedFields}
            onHover={focusStore.setHoveredField}
            onClick={focusStore.togglePin}
            search={search}
          />
        ))
      }
    />
  );
}

function PinnedOverflowNote({ total }: { total: number }) {
  return (
    <div
      className="px-3 py-2 mb-2 text-xs rounded"
      style={{
        backgroundColor: 'var(--color-bg-tertiary)',
        color: 'var(--color-text-secondary)',
        border: '1px solid var(--color-border-subtle)',
      }}
    >
      Showing the first {MAX_PINNED_ROWS.toLocaleString()} of{' '}
      {total.toLocaleString()} events with a pinned field. Narrow the
      set with the search box, or unpin to page through every event.
    </div>
  );
}

interface FocusHandlers {
  pinnedFields: Set<string>;
  togglePin: (field: string) => void;
  setHoveredField: (field: string | null) => void;
}

/**
 * Memoised, and given no hover state: hover reaches the spans through
 * FieldFocusContext, so a card re-renders only when its event, the colours or
 * the pins change.
 */
const HighlightedEventCard = memo(function HighlightedEventCard({
  item, globalIdx, badges, highlightColorMap, fieldColorMap, categories, pinnedFields, togglePin, setHoveredField,
}: {
  item: EnrichedEvent;
  globalIdx: number;
  badges: EventBadges;
  highlightColorMap: Map<string, string>;
  fieldColorMap: Map<string, string>;
  categories: FieldCategories;
} & FocusHandlers) {
  const { eventCalcFields, autoCount, manualCount, calcCount } = badges;
  const { manualFields, calcFields } = categories;
  // A new Map would defeat HighlightedRaw's segmentation memo on every render.
  const fieldValues = useMemo(
    () => new Map<string, string | string[]>(
      Object.entries(item.event.fields).filter(([k]) => highlightColorMap.has(k)),
    ),
    [item.event.fields, highlightColorMap],
  );
  const focus = { pinnedFields, togglePin, setHoveredField };

  return (
    <FieldEventCard
      event={item.event}
      globalIdx={globalIdx}
      fieldColorMap={highlightColorMap}
      fieldValues={fieldValues}
      fieldSourceKeys={item.event.fieldSourceKeys}
      fieldOffsets={item.event.fieldOffsets}
      titleFor={(field, value) => {
        const tag = manualFields.has(field) ? 'manual' : calcFields.has(field) ? 'calc' : 'auto';
        return `${field} (${tag}): ${value}`;
      }}
      onFieldHover={setHoveredField}
      onFieldClick={togglePin}
      badges={
        <>
          {autoCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)]">
              {autoCount} auto
            </span>
          )}
          {manualCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-accent)]/10 text-[var(--color-accent)]">
              {manualCount} manual
            </span>
          )}
          {calcCount > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)]">
              {calcCount} calc
            </span>
          )}
        </>
      }
    >
      {/* Calculated field summary strip + Eval Expressions (only when calc filter active) */}
      {eventCalcFields.length > 0 && (
        <>
          <div className="border-t border-[var(--color-border)] px-3 py-2">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {eventCalcFields.map((cf) => (
                <CalcFieldChip key={cf.name} cf={cf} color={fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)'} focus={focus} />
              ))}
            </div>
          </div>
          <details className="border-t border-[var(--color-border)]">
            <summary className="px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text-secondary)] transition-colors">
              Eval Expressions
            </summary>
            <div className="px-3 py-2 border-t border-[var(--color-border)]">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {eventCalcFields.map((cf) => (
                  <CalcFieldChip
                    key={cf.name}
                    cf={cf}
                    color={fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)'}
                    focus={focus}
                    showExpression
                  />
                ))}
              </div>
            </div>
          </details>
        </>
      )}
    </FieldEventCard>
  );
});

/**
 * A calculated field, as `name=value` in the summary strip or as its EVAL
 * expression in the details. Hovering focuses the field; pressing pins it.
 */
function CalcFieldChip({ cf, color, focus, showExpression = false }: {
  cf: CalcField;
  color: string;
  focus: FocusHandlers;
  showExpression?: boolean;
}) {
  const { pinnedFields, setHoveredField, togglePin } = focus;
  const focusState = useFieldFocusState(cf.name);
  const focused = focusState !== 'none';
  const active = focusState !== 'dim';
  const pinned = pinnedFields.has(cf.name);
  const display = Array.isArray(cf.value) ? cf.value.join(', ') : cf.value;
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer select-none"
      style={{ opacity: focused && !active ? 0.2 : 1, transition: 'opacity 0.15s' }}
      onMouseEnter={() => setHoveredField(cf.name)}
      onMouseLeave={() => setHoveredField(null)}
      {...pressable(() => togglePin(cf.name), (f) => setHoveredField(f ? cf.name : null))}
      aria-pressed={pinned}
    >
      {showExpression ? (
        <>
          <span style={{ color }} className="font-medium">{cf.name}</span>
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">expr</span>
          <code
            className="text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 rounded"
            style={{ outline: pinned ? `2px solid ${color}` : 'none', outlineOffset: '1px' }}
          >
            {cf.expression}
          </code>
        </>
      ) : (
        <>
          <span className="text-[var(--color-text-muted)]">{cf.name}=</span>
          <span
            className="px-1 py-0.5 rounded-sm max-w-48 truncate"
            style={{
              color,
              backgroundColor: active && focused ? tint(color, 13) : 'transparent',
              outline: pinned ? `2px solid ${color}` : 'none',
              outlineOffset: '1px',
              transition: 'background-color 0.15s, color 0.15s',
            }}
            title={display}
          >
            {display}
          </span>
        </>
      )}
    </span>
  );
}
