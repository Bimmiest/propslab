// ---------------------------------------------------------------------------
// metadataChanges.ts
// Which of an event's metadata keys the run rewrote, and by which transform.
// ---------------------------------------------------------------------------

import type { EventMetadata } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';

/** Map from metadata key to the DEST_KEY name used in transforms.conf */
export const DEST_KEY_LABELS: Record<keyof EventMetadata, string> = {
  index: '_MetaData:Index',
  host: '_MetaData:Host',
  source: '_MetaData:Source',
  sourcetype: '_MetaData:Sourcetype',
};

export interface MetadataChange {
  field: keyof EventMetadata;
  from: string;
  to: string;
  transform: string | null;
}

export function getMetadataChanges(event: ViewEvent, original: EventMetadata | undefined): MetadataChange[] {
  const changes: MetadataChange[] = [];
  if (!original) return changes;
  for (const key of Object.keys(DEST_KEY_LABELS) as (keyof EventMetadata)[]) {
    if (event.metadata[key] !== original[key] && event.metadata[key] !== '') {
      // The step that last set this key, which wrote the value shown.
      const step = [...event.processingTrace]
        .reverse()
        .find((s) => s.metadataChanges?.some((change) => change.key === key) ?? false);
      const transform = step ? (step.processor.split(':').pop() ?? null) : null;
      changes.push({ field: key, from: original[key] || '(default)', to: event.metadata[key], transform });
    }
  }
  return changes;
}
