/**
 * Shapes a ProcessingResult for an LLM consumer: bounded event count, `_time`
 * as ISO-8601, and trace snapshots stripped unless asked for — a trace step's
 * before/after `_raw` snapshots dwarf everything else in the payload and the
 * agent can already see `_raw` on the event.
 *
 * Runs inside the worker. Everything in the result that grows with the
 * event count is cut to the returned events here, and the whole response is
 * held under `MAX_RESPONSE_CHARS`, so what crosses to the server's thread —
 * which has no heap limit — is bounded whatever the sample was.
 */
import type {
  ProcessingResult,
  ProcessingStep,
  SplunkEvent,
  ValidationDiagnostic,
} from '../../../src/engine/types';

export interface SerializeOptions {
  maxEvents: number;
  includeSnapshots: boolean;
}

/**
 * Largest simulate response, in characters of the pretty-printed JSON the
 * tool returns. Room for a single event of the full 1MB sample with its trace;
 * past that an agent cannot read the response anyway, and four concurrent
 * calls stay a few tens of megabytes on the server's thread.
 */
export const MAX_RESPONSE_CHARS = 2_000_000;

/** Diagnostics may take at most this share of the budget; events get the rest. */
const DIAGNOSTICS_SHARE = 0.5;

function serializeStep(step: ProcessingStep, includeSnapshots: boolean) {
  const { inputSnapshot, outputSnapshot, ...rest } = step;
  return includeSnapshots ? { ...rest, inputSnapshot, outputSnapshot } : rest;
}

function serializeEvent(event: SplunkEvent, includeSnapshots: boolean) {
  return {
    _raw: event._raw,
    _time: event._time ? event._time.toISOString() : null,
    metadata: event.metadata,
    fields: event.fields,
    indexedFields: event._meta,
    lineNumbers: event.lineNumbers,
    processingTrace: event.processingTrace.map((s) => serializeStep(s, includeSnapshots)),
  };
}

type SerializedEvent = ReturnType<typeof serializeEvent>;

export interface SerializedSimulation {
  eventCount: number;
  returnedEvents: number;
  truncationNote?: string;
  events: SerializedEvent[];
  /** The returned events' trace steps, in order — not every event's. */
  processingSteps: SerializedEvent['processingTrace'];
  diagnostics: ValidationDiagnostic[];
  /** Present only when diagnostics were cut to fit the response cap. */
  diagnosticCount?: number;
}

/** What `json()` in tools.ts will emit for `value`, measured the same way. */
const jsonChars = (value: unknown) => JSON.stringify(value, null, 2).length;

/**
 * Characters one array element adds to the response: its own pretty-printed
 * text, re-indented to depth 2 (four more spaces per line), plus `,\n`.
 */
function elementChars(value: unknown): number {
  const text = JSON.stringify(value, null, 2);
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  return text.length + 4 * lines + 2;
}

/** How many leading items fit in `budget`, given each one's cost. */
function fitting<T>(items: T[], cost: (item: T) => number, budget: number): number {
  let used = 0;
  let count = 0;
  for (const item of items) {
    used += cost(item);
    if (used > budget) break;
    count++;
  }
  return count;
}

export function serializeSimulation(
  result: ProcessingResult,
  diagnostics: ValidationDiagnostic[],
  options: SerializeOptions,
): SerializedSimulation {
  // Only the events that can be returned are serialized: a million-event
  // result never becomes a million serialized copies.
  const candidates = result.events
    .slice(0, options.maxEvents)
    .map((e) => serializeEvent(e, options.includeSnapshots));

  const keptDiagnostics = diagnostics.slice(
    0,
    fitting(diagnostics, elementChars, MAX_RESPONSE_CHARS * DIAGNOSTICS_SHARE),
  );

  const build = (events: SerializedEvent[]): SerializedSimulation => {
    const notes: string[] = [];
    if (events.length < result.eventCount) {
      notes.push(
        events.length < candidates.length
          ? `Only the first ${events.length} of ${result.eventCount} events are returned: the ` +
              `response is capped at ${MAX_RESPONSE_CHARS} characters. Use include_snapshots=false, ` +
              'a lower max_events or a smaller sample to see more of each event.'
          : `Only the first ${events.length} of ${result.eventCount} events are returned; ` +
              'raise max_events or use a smaller sample to see the rest.',
      );
      notes.push('processingSteps covers the returned events only.');
    }
    if (keptDiagnostics.length < diagnostics.length) {
      notes.push(
        `Only the first ${keptDiagnostics.length} of ${diagnostics.length} diagnostics are ` +
          'returned, to keep the response under its size cap.',
      );
    }
    return {
      eventCount: result.eventCount,
      returnedEvents: events.length,
      ...(notes.length > 0 ? { truncationNote: notes.join(' ') } : {}),
      events,
      processingSteps: events.flatMap((e) => e.processingTrace),
      diagnostics: keptDiagnostics,
      ...(keptDiagnostics.length < diagnostics.length
        ? { diagnosticCount: diagnostics.length }
        : {}),
    };
  };

  // Each event is paid for twice: once itself, once for its steps repeated in
  // processingSteps. The budget left after everything else is measured with
  // the longest truncation note in place, so adding it cannot tip the total.
  const budget = MAX_RESPONSE_CHARS - jsonChars(build([]));
  const cost = (e: SerializedEvent) =>
    elementChars(e) + e.processingTrace.reduce((n, s) => n + elementChars(s), 0);
  let count = fitting(candidates, cost, budget);
  let response = build(candidates.slice(0, count));
  // The per-element arithmetic is exact for JSON.stringify's layout; this is
  // the backstop should that ever drift.
  while (count > 0 && jsonChars(response) > MAX_RESPONSE_CHARS) {
    count--;
    response = build(candidates.slice(0, count));
  }
  return response;
}
