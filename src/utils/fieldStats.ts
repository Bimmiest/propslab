// ---------------------------------------------------------------------------
// fieldStats.ts
// What the preview's views need to know about a run's fields as a whole,
// computed once per run (in the worker, by `toViewResult`) rather than by
// each view walking every event's fields again on the main thread.
// ---------------------------------------------------------------------------

/** The part of an event this module reads. */
interface WithFields {
  fields: Record<string, string | string[]>;
}

export interface FieldStats {
  /** How many events the statistics cover. */
  eventCount: number;
  /** Every field name any event has, in first-seen order. */
  names: string[];
  /** How many events have each field. */
  counts: Map<string, number>;
  /**
   * Fields whose value is a whole JSON object or array in at least one event:
   * listed as fields, but not highlighted in the event text.
   */
  containers: string[];
}

export const EMPTY_FIELD_STATS: FieldStats = { eventCount: 0, names: [], counts: new Map(), containers: [] };

/** Whether a field value is a complete JSON object or array. */
export function isJsonContainer(value: string | string[]): boolean {
  if (Array.isArray(value)) return false;
  const t = value.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      JSON.parse(t);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export function computeFieldStats(events: readonly WithFields[]): FieldStats {
  const counts = new Map<string, number>();
  const containers = new Set<string>();
  for (const { fields } of events) {
    for (const key in fields) {
      if (!Object.hasOwn(fields, key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      // A field is a container once; later values need no JSON.parse.
      if (!containers.has(key) && isJsonContainer(fields[key]!)) containers.add(key);
    }
  }
  return { eventCount: events.length, names: [...counts.keys()], counts, containers: [...containers] };
}

/** One collator for every field-name and value sort, rather than `localeCompare` per comparison. */
export const fieldCollator = new Intl.Collator();
