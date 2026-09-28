/**
 * The range a Date can hold: ±8.64e15 ms (100,000,000 days) around the epoch.
 * Past it `new Date(ms)` is an Invalid Date, whose accessors return NaN and
 * whose toISOString() throws — in whatever renders the event, long after the
 * directive that set it.
 */
const MAX_DATE_MS = 8.64e15;

/**
 * An epoch in seconds as a Date, or null when no Date can hold it: a
 * microsecond epoch written where seconds belong, or `pow(10,20)`. Shared by
 * everything that sets `_time` from a computed number (INGEST_EVAL, DEST_KEY
 * = _time), so an out-of-range value keeps the previous `_time` everywhere.
 */
export function dateFromEpochSeconds(seconds: number): Date | null {
  const ms = seconds * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms) : null;
}

/** The warning for a value `dateFromEpochSeconds` refused. */
export const epochOutOfRangeMessage = (setter: string, value: string | number): string =>
  `${setter}: timestamp ${value} is out of range; the event keeps its previous _time`;
