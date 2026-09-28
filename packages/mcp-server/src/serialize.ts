/**
 * Shapes a ProcessingResult for an LLM consumer: bounded event count, `_time`
 * as ISO-8601, and trace snapshots stripped unless asked for — a trace step's
 * before/after `_raw` snapshots dwarf everything else in the payload and the
 * agent can already see `_raw` on the event.
 *
 * Runs inside the worker. Everything in the result that grows with the
 * event count is cut to the returned events here, and the whole response is
 * held under `MAX_PAYLOAD_BYTES` (responseBudget.ts), so what crosses to the
 * server's thread — which has no heap limit — is bounded whatever the sample
 * was.
 */
import type {
  ProcessingResult,
  ProcessingStep,
  SplunkEvent,
  ValidationDiagnostic,
} from '../../../src/engine/types';
import { indexedFields } from '../../../src/engine/utils/metadataFields';
import {
  elementBytes,
  fitting,
  MAX_PAYLOAD_BYTES,
  MAX_RESPONSE_BYTES,
  responseBytes,
} from './responseBudget';

export interface SerializeOptions {
  maxEvents: number;
  includeSnapshots: boolean;
}

/** Diagnostics may take at most this share of the budget; events get the rest. */
const DIAGNOSTICS_SHARE = 0.5;

function serializeStep(step: ProcessingStep, includeSnapshots: boolean) {
  const { inputSnapshot, outputSnapshot, ...rest } = step;
  return includeSnapshots ? { ...rest, inputSnapshot, outputSnapshot } : rest;
}

function serializeEvent(event: SplunkEvent, includeSnapshots: boolean) {
  return {
    _raw: event._raw,
    // The engine never sets an Invalid Date (epochTime.ts), but toISOString()
    // throws on one, which would fail the whole call over one field.
    _time: event._time && !Number.isNaN(event._time.getTime()) ? event._time.toISOString() : null,
    metadata: event.metadata,
    fields: event.fields,
    indexedFields: indexedFields(event._meta),
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
    fitting(diagnostics, elementBytes, MAX_PAYLOAD_BYTES * DIAGNOSTICS_SHARE),
  );

  const build = (events: SerializedEvent[]): SerializedSimulation => {
    const notes: string[] = [];
    if (events.length < result.eventCount) {
      notes.push(
        events.length < candidates.length
          ? `Only the first ${events.length} of ${result.eventCount} events are returned: the ` +
              `response is capped at ${MAX_RESPONSE_BYTES} bytes. Use include_snapshots=false, ` +
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
  const budget = MAX_PAYLOAD_BYTES - responseBytes(build([]));
  const cost = (e: SerializedEvent) =>
    elementBytes(e) + e.processingTrace.reduce((n, s) => n + elementBytes(s), 0);
  let count = fitting(candidates, cost, budget);
  let response = build(candidates.slice(0, count));
  // The per-element arithmetic is exact for compact JSON; this is the
  // backstop should that ever drift.
  while (count > 0 && responseBytes(response) > MAX_PAYLOAD_BYTES) {
    count--;
    response = build(candidates.slice(0, count));
  }
  return response;
}
