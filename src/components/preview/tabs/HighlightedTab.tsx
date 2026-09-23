import { useCallback, useMemo, useState } from 'react';
import { getField, hasField } from '../../../engine/utils/fieldBag';
import type { EnrichedEvent } from '../PreviewPanel';
import { fieldColorAt, isFieldActive, isAnyFocused, useFieldFocus } from './shared/useFieldFocus';
import { FieldEventCard } from './shared/FieldEventCard';
import { FieldSidebar } from './shared/FieldSidebar';
import { FieldSplitLayout } from './shared/FieldSplitLayout';
import { FieldTreeNode } from './shared/FieldTreeNode';
import { buildFieldTree } from './shared/fieldTreeUtils';
import type { FieldNode } from './shared/fieldTreeUtils';
import { DirectiveNoOpList } from './shared/DirectiveNoOpList';
import { pressable } from '../../ui/pressable';

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

export function HighlightedTab({ items, allEvents, currentPage, eventsPerPage }: HighlightedTabProps) {
  const [fieldFilter, setFieldFilter] = useState<FieldFilter>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const { pinnedFields, activeFields, togglePin, setHoveredField } = useFieldFocus();

  const { autoFields, manualFields, calcFields, fieldProcessorMap } = useMemo(() => {
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
  }, [allEvents]);

  const containerFields = useMemo(() => {
    const containers = new Set<string>();
    for (const { event } of allEvents) {
      for (const [key, value] of Object.entries(event.fields)) {
        if (isJsonContainer(value)) containers.add(key);
      }
    }
    return containers;
  }, [allEvents]);

  const fieldColorMap = useMemo(() => {
    const map = new Map<string, string>();
    let colorIdx = 0;
    const includeAuto = fieldFilter === 'auto' || fieldFilter === 'all';
    const includeManual = fieldFilter === 'manual' || fieldFilter === 'all';
    const includeCalc = fieldFilter === 'calc' || fieldFilter === 'all';

    for (const { event } of allEvents) {
      for (const key of Object.keys(event.fields)) {
        const isAuto = autoFields.has(key);
        const isManual = manualFields.has(key);
        const isCalc = calcFields.has(key);
        // Membership, not single-bucket: a field extracted (manual) and then
        // overwritten by EVAL (calc) belongs to BOTH categories, so it must show
        // under each of their filters — and stay consistent with the filter counts.
        const inSelectedFilter =
          (includeAuto && isAuto) || (includeManual && isManual) || (includeCalc && isCalc);
        if (!inSelectedFilter) continue;
        if (!map.has(key)) {
          map.set(key, fieldColorAt(colorIdx));
          colorIdx++;
        }
      }
    }
    return map;
  }, [allEvents, autoFields, manualFields, calcFields, fieldFilter]);

  const highlightColorMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const [key, color] of fieldColorMap) {
      if (!containerFields.has(key)) map.set(key, color);
    }
    return map;
  }, [fieldColorMap, containerFields]);

  // Each rendered row carries its TRUE global event index so the "Event #" badge
  // stays correct whether we're showing a paginated page or a pin-filtered view.
  // When fields are pinned the filter spans every event (a pin is a global filter),
  // so we index into allEvents rather than reusing the current page's offset math.
  const pinMatches = useMemo<{ item: EnrichedEvent; globalIdx: number }[]>(() => {
    if (pinnedFields.size === 0) {
      const offset = (currentPage - 1) * eventsPerPage;
      return items.map((item, i) => ({ item, globalIdx: offset + i + 1 }));
    }
    const out: { item: EnrichedEvent; globalIdx: number }[] = [];
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
  }, [items, allEvents, pinnedFields, currentPage, eventsPerPage]);

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
    () => buildFieldTree(fieldColorMap, containerFields, fieldProcessorMap),
    [fieldColorMap, containerFields, fieldProcessorMap]
  );

  const allGroupNames = useMemo(() => {
    const groups: string[] = [];
    function walk(nodes: FieldNode[]) {
      for (const n of nodes) { if (n.children.length > 0) { groups.push(n.name); walk(n.children); } }
    }
    walk(tree);
    return groups;
  }, [tree]);

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

  const showCalcStrip = fieldFilter === 'calc' || fieldFilter === 'all';

  const eventBadgeCounts = useMemo(() =>
    filteredItems.map(({ item }) => {
      const eventFields = Object.keys(item.event.fields).filter((f) => highlightColorMap.has(f));
      // Straight off the EVAL step: the expressions that actually ran for THIS
      // event, already resolved through stanza matching. This used to be a
      // case-insensitive regex over the raw props.conf text, which ignored
      // stanza scoping (an EVAL- under a sourcetype the user is not simulating
      // still appeared), line continuations, and the case-sensitivity rule the
      // parser enforces one step earlier.
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
      const calcCount = eventCalcFields.length;
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
      return { eventCalcFields, autoCount, manualCount, calcCount };
    }),
    [filteredItems, fieldFilter, highlightColorMap, showCalcStrip, manualFields, calcFields]
  );

  const sidebar = (
    <FieldSidebar
      fieldCount={fieldColorMap.size}
      activeFields={activeFields}
      onCollapse={() => setSidebarCollapsed(true)}
      renderControls={() =>
        allGroupNames.length > 0 ? (
          <button
            className="text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors cursor-pointer bg-transparent border-none p-0"
            onClick={() => {
              const allCollapsed = allGroupNames.every((g) => effectiveCollapsed.has(g));
              setCollapsedGroups(allCollapsed ? new Set() : new Set(allGroupNames));
            }}
          >
            {allGroupNames.every((g) => effectiveCollapsed.has(g)) ? 'Expand all' : 'Collapse all'}
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
            onHover={setHoveredField}
            onClick={togglePin}
            search={search}
          />
        ))
      }
    />
  );

  // Category membership overlaps by design (see fieldColorMap above), so summing
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
    <div className="flex flex-col h-full">
      {/* Filter bar */}
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
                {count > 0 && <span className="ml-1 opacity-70">({count})</span>}
              </button>
            ))}
          </div>

          {pinnedFields.size > 0 && (
            <span className="text-[10px] text-[var(--color-text-muted)] flex items-center gap-1.5">
              {filteredItems.length}/{allEvents.length} events match {pinnedFields.size} pinned field{pinnedFields.size > 1 ? 's' : ''}
              <button
                type="button"
                onClick={() => { for (const f of pinnedFields) togglePin(f); }}
                className="text-[10px] text-[var(--color-accent)] hover:underline bg-transparent border-none p-0 cursor-pointer"
              >
                Clear
              </button>
            </span>
          )}

          {/* Fields sidebar toggle — right-aligned */}
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
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

      <div className="flex-1 min-h-0 flex">
        <FieldSplitLayout
          storageKey="highlighted-split-layout"
          collapsed={sidebarCollapsed}
          sidebar={sidebar}
        >
          {pinnedOverflow && (
            <div
              className="px-3 py-2 mb-2 text-xs rounded"
              style={{
                backgroundColor: 'var(--color-bg-tertiary)',
                color: 'var(--color-text-secondary)',
                border: '1px solid var(--color-border-subtle)',
              }}
            >
              Showing the first {MAX_PINNED_ROWS.toLocaleString()} of{' '}
              {pinMatches.length.toLocaleString()} events with a pinned field. Narrow the
              set with the search box, or unpin to page through every event.
            </div>
          )}
          {/*
            Extraction directives that ran against these events and produced no
            field (#84) — the case where this tab otherwise shows an event with
            nothing highlighted and no reason why.
          */}
          <div className="mb-2">
            <DirectiveNoOpList events={filteredItems.map(({ item }) => item.event)} phase="search-time" />
          </div>
          {filteredItems.map(({ item, globalIdx }, idx) => {
            const { eventCalcFields, autoCount, manualCount, calcCount } =
              eventBadgeCounts[idx] ?? { eventCalcFields: [], autoCount: 0, manualCount: 0, calcCount: 0 };

            const fieldValues = new Map<string, string | string[]>(
              Object.entries(item.event.fields).filter(([k]) => highlightColorMap.has(k))
            );

            const focused = isAnyFocused(activeFields);

            return (
              <FieldEventCard
                key={globalIdx}
                event={item.event}
                globalIdx={globalIdx}
                fieldColorMap={highlightColorMap}
                fieldValues={fieldValues}
                activeFields={activeFields}
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
                      <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/15 text-[var(--color-warning)]">
                        {autoCount} auto
                      </span>
                    )}
                    {manualCount > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-accent)]/15 text-[var(--color-accent)]">
                        {manualCount} manual
                      </span>
                    )}
                    {calcCount > 0 && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/15 text-[var(--color-success)]">
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
                        {eventCalcFields.map((cf) => {
                          const color = fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)';
                          const display = Array.isArray(cf.value) ? cf.value.join(', ') : cf.value;
                          const active = isFieldActive(cf.name, activeFields);
                          const pinned = pinnedFields.has(cf.name);
                          return (
                            <span
                              key={cf.name}
                              className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer select-none"
                              style={{ opacity: focused && !active ? 0.2 : 1, transition: 'opacity 0.15s' }}
                              onMouseEnter={() => setHoveredField(cf.name)}
                              onMouseLeave={() => setHoveredField(null)}
                              {...pressable(() => togglePin(cf.name), (f) => setHoveredField(f ? cf.name : null))}
                              aria-pressed={pinned}
                            >
                              <span className="text-[var(--color-text-muted)]">{cf.name}=</span>
                              <span
                                className="px-1 py-0.5 rounded-sm max-w-48 truncate"
                                style={{
                                  color,
                                  backgroundColor: active && focused ? color + '20' : 'transparent',
                                  outline: pinned ? `2px solid ${color}` : 'none',
                                  outlineOffset: '1px',
                                  transition: 'background-color 0.15s, color 0.15s',
                                }}
                                title={display}
                              >
                                {display}
                              </span>
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <details className="border-t border-[var(--color-border)]">
                      <summary className="px-3 py-2 text-xs font-medium text-[var(--color-text-muted)] cursor-pointer select-none hover:text-[var(--color-text-secondary)] transition-colors">
                        Eval Expressions
                      </summary>
                      <div className="px-3 py-2 border-t border-[var(--color-border)]">
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {eventCalcFields.map((cf) => {
                            const color = fieldColorMap.get(cf.name) ?? 'var(--color-text-muted)';
                            const active = isFieldActive(cf.name, activeFields);
                            const pinned = pinnedFields.has(cf.name);
                            return (
                              <span
                                key={cf.name}
                                className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer select-none"
                                style={{ opacity: focused && !active ? 0.2 : 1, transition: 'opacity 0.15s' }}
                                onMouseEnter={() => setHoveredField(cf.name)}
                                onMouseLeave={() => setHoveredField(null)}
                                {...pressable(() => togglePin(cf.name), (f) => setHoveredField(f ? cf.name : null))}
                                aria-pressed={pinned}
                              >
                                <span style={{ color }} className="font-medium">{cf.name}</span>
                                <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">expr</span>
                                <code
                                  className="text-[var(--color-text-secondary)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 rounded"
                                  style={{ outline: pinned ? `2px solid ${color}` : 'none', outlineOffset: '1px' }}
                                >
                                  {cf.expression}
                                </code>
                              </span>
                            );
                          })}
                        </div>
                      </div>
                    </details>
                  </>
                )}
              </FieldEventCard>
            );
          })}
        </FieldSplitLayout>
      </div>
    </div>
  );
}
