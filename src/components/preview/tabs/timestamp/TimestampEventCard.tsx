import type { TimeConfig, TimestampProbe } from '../../../../engine/timestampMatch';
import type { TimeSource } from '../../../../engine/types';
import { tint } from '../../../../utils/tint';
import { FALLBACK_LABEL, FORMAT_COLOR, LOOKAHEAD_COLOR, PREFIX_COLOR } from './data';
import { overlaySegments, type OverlaySegment } from './timestampLogic';

export function TimestampEventCard({
  raw,
  rewritten,
  globalIdx,
  config,
  probe,
  pending,
  resolvedTime,
  timeSource,
}: {
  raw: string;
  /** Whether `_raw` was rewritten after timestamping, so `raw` is not the final text. */
  rewritten: boolean;
  globalIdx: number;
  config: TimeConfig;
  probe: TimestampProbe | null;
  pending: boolean;
  resolvedTime: Date | null;
  timeSource: TimeSource | undefined;
}) {
  const result = probe?.match ?? null;
  const parsedTime = result?.parsedTimeMs != null ? new Date(result.parsedTimeMs) : null;
  const fallbackLabel = timeSource ? FALLBACK_LABEL[timeSource] : undefined;

  return (
    <div className="border border-[var(--color-border)] rounded bg-[var(--color-bg-secondary)]">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-tertiary)]">
        <span className="text-xs font-medium text-[var(--color-text-muted)]">
          Event #{globalIdx}
          {rewritten && (
            <span
              className="ml-2 font-normal italic"
              title="SEDCMD or an index-time transform rewrote _raw after its timestamp was read. Shown is the text timestamp extraction saw."
            >
              as read before _raw was rewritten
            </span>
          )}
        </span>
        <div className="flex items-center gap-2">
          {pending ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] font-medium">
              Matching…
            </span>
          ) : fallbackLabel ? (
            // The event still has a _time — it just did not come from this
            // event's text, so it is warned about rather than shown as a match.
            <>
              <span
                className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/10 text-[var(--color-warning)] font-medium"
                title="This _time was not read from the event text"
              >
                {fallbackLabel}
              </span>
              {resolvedTime && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)] font-medium font-mono">
                  {resolvedTime.toISOString()}
                </span>
              )}
            </>
          ) : parsedTime ? (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/10 text-[var(--color-success)] font-medium font-mono">
              {parsedTime.toISOString()}
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/10 text-[var(--color-error)] font-medium">
              {config.timeFormat ? 'No match' : 'No format'}
            </span>
          )}
        </div>
      </div>
      <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
        <TimestampOverlay raw={raw} probe={probe} config={config} />
      </pre>
    </div>
  );
}

function OverlaySpan({ segment: { kind, text, title } }: { segment: OverlaySegment }) {
  switch (kind) {
    case 'outside':
      return <span className="text-[var(--color-text-muted)]">{text}</span>;
    case 'prefix':
      return (
        <span style={{ backgroundColor: tint(PREFIX_COLOR, 19), borderBottom: `2px solid ${PREFIX_COLOR}` }} className="rounded-sm px-0.5" title={title}>
          {text}
        </span>
      );
    case 'window':
      return <span>{text}</span>;
    case 'gap':
      return <span className="text-[var(--color-text-primary)]">{text}</span>;
    case 'timestamp':
      return (
        <span style={{ backgroundColor: tint(FORMAT_COLOR, 21), borderBottom: `2px solid ${FORMAT_COLOR}` }} className="rounded-sm px-0.5" title={title}>
          {text}
        </span>
      );
    case 'boundary':
      return <span style={{ color: LOOKAHEAD_COLOR, fontWeight: 'bold' }}>{text}</span>;
  }
}

function TimestampOverlay({ raw, probe, config }: { raw: string; probe: TimestampProbe | null; config: TimeConfig }) {
  const segments = overlaySegments(raw, probe, config);
  if (!segments) return <span className="text-[var(--color-text-secondary)]">{raw}</span>;
  return <>{segments.map((segment) => <OverlaySpan key={segment.key} segment={segment} />)}</>;
}
