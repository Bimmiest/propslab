// ---------------------------------------------------------------------------
// fieldColoring.ts
// The Extractions tab's passes over the events it shows: which category each
// field is in (auto, manual, calculated), which fields there are, which hold
// JSON, and the colour each shown field is drawn in.
// ---------------------------------------------------------------------------

import type { EnrichedEvent } from '../../enrichEvents';
import { fieldColorAt } from '../shared/fieldColors';
import { isJsonContainer, type FieldStats } from '../../../../utils/fieldStats';

const AUTO_PROCESSORS = ['KV_MODE', 'INDEXED_EXTRACTIONS'];
const MANUAL_PROCESSORS = ['EXTRACT', 'REPORT', 'TRANSFORMS', 'RULESET', 'SEDCMD'];

function isAutoProcessor(p: string) {
  return AUTO_PROCESSORS.some((a) => p.startsWith(a));
}
function isManualProcessor(p: string) {
  return MANUAL_PROCESSORS.some((m) => p.startsWith(m));
}

export type FieldFilter = 'auto' | 'manual' | 'calc' | 'all';

/** Which category each extracted field falls in, and the processor that produced it. */
export interface FieldCategories {
  autoFields: Set<string>;
  manualFields: Set<string>;
  calcFields: Set<string>;
  fieldProcessorMap: Map<string, string>;
}

/**
 * Events with the same steps share one trace array (see `toViewResult`), and
 * applying a trace twice in a row changes nothing, so a run of events with
 * the same trace is classified once. Runs, not distinct traces: which
 * processor a field is credited to depends on the order traces are applied.
 */
export function classifyFields(allEvents: EnrichedEvent[]): FieldCategories {
  const auto = new Set<string>();
  const manual = new Set<string>();
  const calc = new Set<string>();
  const processorMap = new Map<string, string>();
  let previous: EnrichedEvent['event']['processingTrace'] | null = null;
  for (const { event } of allEvents) {
    if (event.processingTrace === previous) continue;
    previous = event.processingTrace;
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

/**
 * The distinct fields of `allEvents`, in first-seen order: the run's own list
 * when `allEvents` is the whole run (the preview's filters only ever remove
 * events, so the same count means the same events), else a walk of the keys.
 */
export function fieldNamesInView(allEvents: EnrichedEvent[], stats: FieldStats | undefined): string[] {
  if (stats && allEvents.length === stats.eventCount) return stats.names;
  const names = new Set<string>();
  for (const { event } of allEvents) {
    for (const key in event.fields) {
      if (Object.hasOwn(event.fields, key)) names.add(key);
    }
  }
  return [...names];
}

/** Fields holding a JSON object or array: the run's, or found in `allEvents` without statistics. */
export function findContainerFields(allEvents: EnrichedEvent[], stats: FieldStats | undefined): Set<string> {
  if (stats) return new Set(stats.containers);
  const containers = new Set<string>();
  for (const { event } of allEvents) {
    for (const [key, value] of Object.entries(event.fields)) {
      if (isJsonContainer(value)) containers.add(key);
    }
  }
  return containers;
}

/** A colour for each field the filter shows, in first-seen order. */
export function assignFieldColors(
  fieldNames: string[],
  { autoFields, manualFields, calcFields }: FieldCategories,
  fieldFilter: FieldFilter,
  theme: 'light' | 'dark',
): Map<string, string> {
  const map = new Map<string, string>();
  const includeAuto = fieldFilter === 'auto' || fieldFilter === 'all';
  const includeManual = fieldFilter === 'manual' || fieldFilter === 'all';
  const includeCalc = fieldFilter === 'calc' || fieldFilter === 'all';

  for (const key of fieldNames) {
    // Membership, not single-bucket: a field extracted (manual) and then
    // overwritten by EVAL (calc) belongs to BOTH categories, so it must show
    // under each of their filters — and stay consistent with the filter counts.
    const inSelectedFilter =
      (includeAuto && autoFields.has(key)) ||
      (includeManual && manualFields.has(key)) ||
      (includeCalc && calcFields.has(key));
    if (inSelectedFilter) map.set(key, fieldColorAt(map.size, theme));
  }
  return map;
}
