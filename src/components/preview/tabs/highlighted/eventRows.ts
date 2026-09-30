// ---------------------------------------------------------------------------
// eventRows.ts
// Which events the Extractions tab draws, numbered as in the dataset, and
// what each card is badged with.
// ---------------------------------------------------------------------------

import { getField, hasField } from '../../../../engine/utils/fieldBag';
import type { EnrichedEvent } from '../../enrichEvents';
import type { FieldNode } from '../shared/fieldTreeUtils';
import type { FieldCategories, FieldFilter } from './fieldColoring';

export interface EventRow {
  item: EnrichedEvent;
  globalIdx: number;
}

export interface RowSource {
  /** The current page's events. */
  items: EnrichedEvent[];
  /** Every event the filters leave. */
  allEvents: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

/**
 * The rows to render. Each carries its TRUE global event index so the "Event #"
 * badge stays correct whether we're showing a paginated page or a pin-filtered
 * view. When fields are pinned the filter spans every event (a pin is a global
 * filter), so we index into allEvents rather than reusing the current page's
 * offset math.
 */
export function selectRows(
  { items, allEvents, currentPage, eventsPerPage }: RowSource,
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

/** Every node of the field tree that has children, depth first. */
export function groupNames(tree: FieldNode[]): string[] {
  const groups: string[] = [];
  function walk(nodes: FieldNode[]) {
    for (const n of nodes) {
      if (n.children.length > 0) {
        groups.push(n.name);
        walk(n.children);
      }
    }
  }
  walk(tree);
  return groups;
}

export interface CalcField {
  name: string;
  expression: string;
  value: string | string[];
}

export interface EventBadges {
  eventCalcFields: CalcField[];
  autoCount: number;
  manualCount: number;
  calcCount: number;
}

export const NO_BADGES: EventBadges = { eventCalcFields: [], autoCount: 0, manualCount: 0, calcCount: 0 };

/**
 * The per-category counts an event's card is badged with, and its calculated
 * fields. The calc count is the calculated fields shown; a highlighted field
 * that is also calculated is counted there, not as manual or auto.
 */
export function eventBadges(
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
  } else if (fieldFilter === 'all') {
    for (const f of eventFields) {
      if (calcFields.has(f)) continue;
      if (manualFields.has(f)) manualCount++;
      else autoCount++;
    }
  }
  return { eventCalcFields, autoCount, manualCount, calcCount: eventCalcFields.length };
}
