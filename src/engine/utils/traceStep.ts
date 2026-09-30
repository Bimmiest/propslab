import type { EventMetadata, ProcessingStep, SplunkEvent } from '../types';
import { changeWindow } from './changeWindow';

const METADATA_KEYS: (keyof EventMetadata)[] = ['index', 'host', 'source', 'sourcetype'];

/**
 * Append `step` to the trace of `event` — the event as the step left it — and,
 * when the step rewrote `_raw`, record the rewrite the way every such step must.
 *
 * DEST_KEY = _raw and INGEST_EVAL's `_raw=` are the same operation reached two
 * ways, and field attribution (`attributeRawMutations`) only sees a rewrite
 * that left a `rawMutations` entry pointing at its step. Both come through
 * here, so each names the fields its rewrite destroyed and neither can drift
 * from the other.
 *
 * `rawBefore` is `_raw` as the step found it. An unchanged `_raw` records
 * nothing: a rewrite to the same text destroyed nothing.
 */
export function appendTraceStep(event: SplunkEvent, step: ProcessingStep, rawBefore: string): SplunkEvent {
  const traceIndex = event.processingTrace.length;
  if (event._raw === rawBefore) {
    return { ...event, processingTrace: [...event.processingTrace, step] };
  }
  return {
    ...event,
    processingTrace: [...event.processingTrace, { ...step, ...changeWindow(rawBefore, event._raw) }],
    rawMutations: [...(event.rawMutations ?? []), { traceIndex, rawBefore, rawAfter: event._raw }],
  };
}

/**
 * The metadata keys whose value differs between `before` and `after`, old → new,
 * in a fixed order. Empty when nothing changed.
 */
export function metadataChanges(
  before: EventMetadata,
  after: EventMetadata,
): NonNullable<ProcessingStep['metadataChanges']> {
  return METADATA_KEYS.filter((key) => before[key] !== after[key]).map((key) => ({
    key,
    from: before[key],
    to: after[key],
  }));
}
