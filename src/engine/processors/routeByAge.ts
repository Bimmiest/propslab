import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';
import { atDirective } from '../parser/provenance';

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Parse `<non-negative integer>[s|m|h|d]` into milliseconds, or null when the
 * value is not in that form.
 *
 * A bare integer is read as seconds. The spec makes the unit optional without
 * naming the default; seconds is the unit the other bare-number age settings
 * in props.conf are counted in (MAX_DIFF_SECS_AGO and friends), so it is the
 * reading least likely to surprise. Worth knowing it is the aggressive one: a
 * bare `7` meant as days drops everything older than seven seconds.
 */
export function parseAge(value: string): number | null {
  const m = /^(\d+)([smhd])?$/.exec(value.trim());
  if (!m?.[1]) return null;
  return Number(m[1]) * (UNIT_MS[m[2] ?? 's'] ?? 1000);
}

/**
 * ROUTE_EVENTS_OLDER_THAN (#275): route events whose extracted timestamp is
 * older than the given age to nullQueue.
 *
 * Runs straight after timestamp extraction, which is where the spec places it,
 * so it tests the `_time` that extraction produced — not one a later
 * INGEST_EVAL or DEST_KEY = _time rewrites. "Older" is measured from `now`, the
 * run's single injected clock, so a test or a replay gets the same answer every
 * time.
 *
 * The drop is a queue write, the same one DEST_KEY = queue makes, rather than
 * removing the event: the spec says the event is *routed* to nullQueue, and
 * that is how every other nullQueue route is modelled here — the event stays in
 * the preview, shown as dropped, with the trace saying why. It follows that a
 * later index-time transform writing the queue can still override it, exactly
 * as it can override a TRANSFORMS- nullQueue route.
 *
 * An event with no `_time` cannot be judged and is left alone.
 */
export function routeEventsByAge(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics: ValidationDiagnostic[],
  now: number,
): SplunkEvent[] {
  const dir = directives.filter((d) => d.key === 'ROUTE_EVENTS_OLDER_THAN').at(-1);
  if (!dir) return events;
  const raw = dir.value.trim();
  // Empty is the default: the setting is off.
  if (raw === '') return events;

  const ageMs = parseAge(raw);
  if (ageMs === null) {
    diagnostics.push({
      level: 'warning',
      message:
        `ROUTE_EVENTS_OLDER_THAN = ${raw} is not a non-negative integer with an optional s, m, h or d ` +
        'suffix, so no events are routed by age.',
      file: 'props.conf',
      ...atDirective(dir),
      directiveKey: dir.key,
    });
    return events;
  }

  const cutoff = now - ageMs;
  return events.map((event) => {
    if (event._time === null || event._time.getTime() >= cutoff) return event;
    return {
      ...event,
      _meta: { ...event._meta, _queue: 'nullQueue' },
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'ROUTE_EVENTS_OLDER_THAN',
          phase: 'index-time' as const,
          description:
            `_time ${event._time.toISOString()} is older than ${raw} before ${new Date(now).toISOString()} ` +
            '— routed to nullQueue',
        },
      ],
    };
  });
}
