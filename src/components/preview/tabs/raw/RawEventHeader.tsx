// ---------------------------------------------------------------------------
// RawEventHeader.tsx
// A Raw tab event's header line — its number, time, size, source lines and
// status badges — and the label of its show-more toggle.
// ---------------------------------------------------------------------------

import type { ViewEvent } from '../../../../utils/viewResult';

export function ExpandLabel({ expanded }: { expanded: boolean }) {
  return expanded ? (
    <>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M5 15l7-7 7 7" />
      </svg>
      Show less
    </>
  ) : (
    <>
      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
      Show full event
    </>
  );
}

export function EventRowHeader({
  event,
  globalIdx,
  isDropped,
  hasMetadataChanges,
}: {
  event: ViewEvent;
  globalIdx: number;
  isDropped: boolean;
  hasMetadataChanges: boolean;
}) {
  const lineCount = event._raw.split('\n').length;
  const charCount = event._raw.length;

  const truncation = event.processingTrace.find((t) => t.truncation)?.truncation;

  return (
    <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">Event #{globalIdx}</span>
        {event._time && (
          <span className="text-xs text-[var(--color-accent)] font-mono">{event._time.toISOString()}</span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-[var(--color-text-muted)] font-mono">
          {lineCount} line{lineCount !== 1 ? 's' : ''} &middot; {charCount.toLocaleString()} char
          {charCount !== 1 ? 's' : ''}
        </span>
        <span className="text-xs text-[var(--color-text-muted)]">
          Lines {event.lineNumbers.start}–{event.lineNumbers.end}
        </span>
        {truncation && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium"
            title={`Truncated ${truncation.lines} ${truncation.lines === 1 ? 'line' : 'lines'} to ${truncation.limitBytes} bytes each (${truncation.isDefault ? 'TRUNCATE default' : `TRUNCATE=${truncation.limitBytes}`})`}
          >
            Truncated{truncation.isDefault ? ' (default)' : ''}
          </span>
        )}
        {/*
          A CLONE_SOURCETYPE copy is byte-identical to its original, so
          without saying where it came from a duplicated event reads as a
          line-breaking bug rather than the routing rule working.
        */}
        {event.clonedFrom !== undefined && (
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-info)]/10 text-[var(--color-info)] font-medium"
            title={`Emitted by CLONE_SOURCETYPE from an event with sourcetype "${event.clonedFrom}"`}
          >
            Cloned from {event.clonedFrom}
          </span>
        )}
        {hasMetadataChanges && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium">
            Metadata modified
          </span>
        )}
        {isDropped ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/10 text-[var(--color-error)] font-medium">
            Dropped
          </span>
        ) : event._meta._queue ? (
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium">
            Routed ({event._meta._queue})
          </span>
        ) : null}
      </div>
    </div>
  );
}
