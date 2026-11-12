import { memo } from 'react';
import { tint } from '../../../../utils/tint';
import { EventCardHeader, EventNumber } from '../shared/EventCardHeader';
import { FORMAT_COLOR, LOOKAHEAD_COLOR, PREFIX_COLOR } from './data';
import type { OverlaySegment } from './timestampLogic';

/** What the card's header says of the event's `_time`. */
export type TimeBadge =
  | { kind: 'pending' }
  /** Read from the event text; `format` when it is not the one the tab names. */
  | { kind: 'read'; time: Date; format?: string }
  /** Not read from the event text: `label` says why, and `time` is where it came from instead. */
  | { kind: 'fallback'; label: string; time: Date | null }
  | { kind: 'none'; label: string };

// Memoised: the tab re-renders with its parent, and a page holds up to 50 cards (#565).
export const TimestampEventCard = memo(function TimestampEventCard({
  raw,
  rewritten,
  globalIdx,
  segments,
  badge,
}: {
  raw: string;
  /** Whether `_raw` was rewritten after timestamping, so `raw` is not the final text. */
  rewritten: boolean;
  globalIdx: number;
  /** How the overlay draws `raw`, or null to draw it plain. */
  segments: OverlaySegment[] | null;
  badge: TimeBadge;
}) {
  // A fallback is set apart by its edge as well as its badge: its _time looks
  // like a read one in the output.
  const fallback = badge.kind === 'fallback';
  return (
    <div
      className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]"
      style={fallback ? { borderLeft: '3px solid var(--color-warning)' } : undefined}
      data-time-badge={badge.kind}
    >
      <EventCardHeader split>
        <EventNumber globalIdx={globalIdx}>
          {rewritten && (
            <span
              className="ml-2 font-normal italic"
              title="SEDCMD or an index-time transform rewrote _raw after its timestamp was read. Shown is the text timestamp extraction saw."
            >
              as read before _raw was rewritten
            </span>
          )}
        </EventNumber>
        <div className="flex items-center gap-2">
          <Badge badge={badge} />
        </div>
      </EventCardHeader>
      <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
        {segments ? (
          segments.map((segment) => <OverlaySpan key={segment.key} segment={segment} />)
        ) : (
          <span className={fallback ? 'text-[var(--color-text-muted)]' : 'text-[var(--color-text-secondary)]'}>
            {raw}
          </span>
        )}
      </pre>
    </div>
  );
});

function Badge({ badge }: { badge: TimeBadge }) {
  switch (badge.kind) {
    case 'pending':
      return (
        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] font-medium">
          Matching…
        </span>
      );
    case 'fallback':
      return (
        <>
          <span
            className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium"
            title="This _time was not read from the event text"
          >
            {badge.label}
          </span>
          {badge.time && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] font-medium font-mono">
              {badge.time.toISOString()}
            </span>
          )}
        </>
      );
    case 'read':
      return (
        <>
          {badge.format !== undefined && (
            <code className="text-xs px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] font-mono">
              {badge.format}
            </code>
          )}
          <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium font-mono">
            {badge.time.toISOString()}
          </span>
        </>
      );
    case 'none':
      return (
        <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/10 text-[var(--color-error)] font-medium">
          {badge.label}
        </span>
      );
  }
}

function OverlaySpan({ segment: { kind, text, title } }: { segment: OverlaySegment }) {
  switch (kind) {
    case 'outside':
      return <span className="text-[var(--color-text-muted)]">{text}</span>;
    case 'prefix':
      return (
        <span
          style={{ backgroundColor: tint(PREFIX_COLOR, 19), borderBottom: `2px solid ${PREFIX_COLOR}` }}
          className="rounded-sm px-0.5"
          title={title}
        >
          {text}
        </span>
      );
    case 'window':
      return <span>{text}</span>;
    case 'gap':
      return <span className="text-[var(--color-text-primary)]">{text}</span>;
    case 'timestamp':
      return (
        <span
          style={{ backgroundColor: tint(FORMAT_COLOR, 21), borderBottom: `2px solid ${FORMAT_COLOR}` }}
          className="rounded-sm px-0.5"
          title={title}
        >
          {text}
        </span>
      );
    case 'boundary':
      return <span style={{ color: LOOKAHEAD_COLOR, fontWeight: 'bold' }}>{text}</span>;
  }
}
