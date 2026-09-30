// ---------------------------------------------------------------------------
// enrichEvents.ts
// Each event of a run with what the Preview tab shows and filters on beside
// it: the input lines it came from, and whether the pipeline changed its text
// or metadata or dropped it.
// ---------------------------------------------------------------------------

import type { EventMetadata } from '../../engine/types';
import type { ViewEvent } from '../../utils/viewResult';

// trimEnd, not /\s+$/: the regex backtracks quadratically over a long inner
// run of whitespace, and this runs on the main thread for every event.
const normalise = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();

export interface EnrichedEvent {
  event: ViewEvent;
  /** `_raw` lower-cased once, for the search filter. */
  searchText: string;
  originalRaw: string;
  hasChanges: boolean;
  hasMetadataChanges: boolean;
  isDropped: boolean;
}

function hasMetadataDiff(eventMeta: EventMetadata, originalMeta: EventMetadata): boolean {
  return (
    (eventMeta.index !== originalMeta.index && eventMeta.index !== '') ||
    (eventMeta.host !== originalMeta.host && eventMeta.host !== '') ||
    (eventMeta.source !== originalMeta.source && eventMeta.source !== '') ||
    (eventMeta.sourcetype !== originalMeta.sourcetype && eventMeta.sourcetype !== '')
  );
}

/** Enrich events with original raw + change/drop status. */
export function enrichEvents(
  events: ViewEvent[],
  originalRaw: string,
  originalMetadata: EventMetadata | undefined,
): EnrichedEvent[] {
  const origLines = originalRaw.split('\n');
  return events.map((event): EnrichedEvent => {
    const startIdx = Math.max(0, event.lineNumbers.start - 1);
    const endIdx = event.lineNumbers.end;
    const origSlice = origLines.slice(startIdx, endIdx).join('\n');
    return {
      event,
      searchText: event._raw.toLowerCase(),
      originalRaw: origSlice,
      hasChanges: normalise(origSlice) !== normalise(event._raw),
      hasMetadataChanges: originalMetadata !== undefined && hasMetadataDiff(event.metadata, originalMetadata),
      isDropped: event._meta._queue === 'nullQueue',
    };
  });
}
