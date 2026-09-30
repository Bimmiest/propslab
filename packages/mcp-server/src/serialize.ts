/**
 * Shapes a ProcessingResult for an LLM consumer: bounded event count, `_time`
 * as ISO-8601, and trace snapshots stripped unless asked for — a trace step's
 * before/after `_raw` snapshots dwarf everything else in the payload and the
 * agent can already see `_raw` on the event.
 *
 * Each event carries what the engine decided about it beyond its fields: why
 * a directive that applied to it did nothing (`noOps`), which sourcetype a
 * CLONE_SOURCETYPE copy was cloned from (`clonedFrom`), and, when asked for,
 * the capture spans of positional EXTRACTs (`fieldOffsets`).
 *
 * Runs inside the worker. Everything in the result that grows with the
 * event count is cut to the returned events here, and the whole response is
 * held under `MAX_PAYLOAD_BYTES` (responseBudget.ts), so what crosses to the
 * server's thread — which has no heap limit — is bounded whatever the sample
 * was.
 *
 * `outputSchemas.ts` describes the same shape to clients, and is checked
 * against these types at compile time, so the two cannot drift apart.
 */
import type {
  DirectiveNoOp,
  EventMetadata,
  ProcessingResult,
  ProcessingStep,
  SplunkEvent,
  ValidationDiagnostic,
} from '../../../src/engine/types';
import { describeNoOp } from '../../../src/engine/noOpExplainer';
import { indexedFields } from '../../../src/engine/utils/metadataFields';
import { elementBytes, fitting, MAX_PAYLOAD_BYTES, MAX_RESPONSE_BYTES, responseBytes } from './responseBudget';

export interface SerializeOptions {
  maxEvents: number;
  includeSnapshots: boolean;
  /** Emit each event's `fieldOffsets` (the `capture_offsets` input). Off by default. */
  includeOffsets?: boolean;
}

/** Diagnostics may take at most this share of the budget; events get the rest. */
const DIAGNOSTICS_SHARE = 0.5;

/** A directive that did nothing to an event: the engine's record, plus its one-line reading. */
export interface SerializedNoOp extends DirectiveNoOp {
  description: string;
}

export interface SerializedEvent {
  _raw: string;
  /** ISO-8601, or null when no timestamp was assigned. */
  _time: string | null;
  metadata: EventMetadata;
  fields: Record<string, string | string[]>;
  indexedFields: Record<string, string | string[]>;
  lineNumbers: { start: number; end: number };
  processingTrace: ProcessingStep[];
  /** With `capture_offsets` only: `[start, end)` spans in `_raw` of positionally extracted fields. */
  fieldOffsets?: Record<string, [number, number][]>;
  /** Directives that applied to this event and changed nothing, each with why. */
  noOps?: SerializedNoOp[];
  /** CLONE_SOURCETYPE copies only: the sourcetype the original carried. */
  clonedFrom?: string;
}

export interface SerializedSimulation {
  eventCount: number;
  returnedEvents: number;
  truncationNote?: string;
  events: SerializedEvent[];
  diagnostics: ValidationDiagnostic[];
  /** Present only when diagnostics were cut to fit the response cap. */
  diagnosticCount?: number;
}

function serializeStep(step: ProcessingStep, includeSnapshots: boolean): ProcessingStep {
  const { inputSnapshot, outputSnapshot, ...rest } = step;
  return includeSnapshots ? { ...rest, inputSnapshot, outputSnapshot } : rest;
}

function serializeEvent(event: SplunkEvent, options: SerializeOptions): SerializedEvent {
  const { fieldOffsets, noOps, clonedFrom } = event;
  return {
    _raw: event._raw,
    // The engine never sets an Invalid Date (epochTime.ts), but toISOString()
    // throws on one, which would fail the whole call over one field.
    _time: event._time && !Number.isNaN(event._time.getTime()) ? event._time.toISOString() : null,
    metadata: event.metadata,
    fields: event.fields,
    indexedFields: indexedFields(event._meta),
    lineNumbers: event.lineNumbers,
    processingTrace: event.processingTrace.map((s) => serializeStep(s, options.includeSnapshots)),
    ...(options.includeOffsets === true && fieldOffsets !== undefined ? { fieldOffsets } : {}),
    ...(noOps !== undefined && noOps.length > 0
      ? { noOps: noOps.map((n) => ({ ...n, description: describeNoOp(n.reason) })) }
      : {}),
    ...(clonedFrom !== undefined ? { clonedFrom } : {}),
  };
}

export function serializeSimulation(
  result: ProcessingResult,
  diagnostics: ValidationDiagnostic[],
  options: SerializeOptions,
): SerializedSimulation {
  // Only the events that can be returned are serialized: a million-event
  // result never becomes a million serialized copies.
  const candidates = result.events.slice(0, options.maxEvents).map((e) => serializeEvent(e, options));

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
      diagnostics: keptDiagnostics,
      ...(keptDiagnostics.length < diagnostics.length ? { diagnosticCount: diagnostics.length } : {}),
    };
  };

  // The budget left after everything else is measured with the longest
  // truncation note in place, so adding it cannot tip the total.
  const budget = MAX_PAYLOAD_BYTES - responseBytes(build([]));
  let count = fitting(candidates, elementBytes, budget);
  let response = build(candidates.slice(0, count));
  // The per-element arithmetic is exact for compact JSON; this is the
  // backstop should that ever drift.
  while (count > 0 && responseBytes(response) > MAX_PAYLOAD_BYTES) {
    count--;
    response = build(candidates.slice(0, count));
  }
  return response;
}
