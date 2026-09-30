// ---------------------------------------------------------------------------
// RawEventMetadata.tsx
// A Raw tab event's metadata: what the run's input set, and each key a
// transform rewrote, with the transform that wrote it.
// ---------------------------------------------------------------------------

import type { EventMetadata } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';
import { Icon } from '../../../ui/Icon';
import { DEST_KEY_LABELS, type MetadataChange } from './metadataChanges';

function MetadataField({ label, value, original }: { label: string; value: string; original: string | undefined }) {
  const changed = original !== undefined && value !== original && value !== '';
  return (
    <span className="text-[var(--color-text-muted)]">
      {label}=
      <span className={changed ? 'text-[var(--color-warning)] font-semibold' : 'text-[var(--color-text-secondary)]'}>
        {value || '—'}
      </span>
    </span>
  );
}

export function MetadataDetails({
  event,
  originalMetadata,
  metadataChanges,
}: {
  event: ViewEvent;
  originalMetadata: EventMetadata | undefined;
  metadataChanges: MetadataChange[];
}) {
  return (
    <>
      <div className="px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs font-mono">
          <MetadataField label="index" value={event.metadata.index} original={originalMetadata?.index} />
          <MetadataField label="host" value={event.metadata.host} original={originalMetadata?.host} />
          <MetadataField label="source" value={event.metadata.source} original={originalMetadata?.source} />
          <MetadataField label="sourcetype" value={event.metadata.sourcetype} original={originalMetadata?.sourcetype} />
        </div>
      </div>

      {metadataChanges.length > 0 && (
        <div className="px-3 py-1.5 border-t border-[var(--color-border)] bg-[var(--color-warning)]/5">
          <div className="space-y-1">
            {metadataChanges.map((change) => (
              <div key={change.field} className="flex items-center gap-2 text-xs">
                <span className="font-mono font-medium text-[var(--color-warning)]">
                  {DEST_KEY_LABELS[change.field]}
                </span>
                <span className="font-mono text-[var(--color-text-muted)] line-through">{change.from}</span>
                <Icon name="arrow-right" className="w-3 h-3 text-[var(--color-text-muted)] flex-shrink-0" />
                <span className="font-mono font-semibold text-[var(--color-warning)]">{change.to}</span>
                {change.transform && (
                  <span className="text-[var(--color-text-muted)]">
                    via <span className="font-mono text-[var(--color-accent)]">[{change.transform}]</span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
