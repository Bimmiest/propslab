import { useMemo, useState } from 'react';
import { useAppStore } from '../../../store/useAppStore';
import { parseConf } from '../../../engine/parser/confParser';
import { matchStanzas, mergeDirectives } from '../../../engine/parser/stanzaMatcher';
import { resolveLookahead } from '../../../engine/processors/timestampExtractor';
import { useTimestampMatch } from '../../../hooks/useTimestampMatch';
import type { TimeConfig, TimestampProbe } from '../../../engine/timestampMatch';
import type { EventMetadata, SplunkEvent, TimeSource } from '../../../engine/types';
import type { EnrichedEvent } from '../PreviewPanel';

interface TimestampTabProps {
  items: EnrichedEvent[];
  currentPage: number;
  eventsPerPage: number;
}

// Theme-aware highlight colours (no hard-coded hex — see design system in CLAUDE.md).
const PREFIX_COLOR = 'var(--color-info)';
const FORMAT_COLOR = 'var(--color-success)';
const LOOKAHEAD_COLOR = 'var(--color-error)';
/** A translucent tint of a CSS-variable colour for highlight backgrounds. */
const tint = (color: string, pct: number) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

/** Human-readable descriptions for strftime directives (used by the format breakdown) */
const DIRECTIVE_DESCRIPTIONS: Record<string, string> = {
  '%Y': '4-digit year',
  '%y': '2-digit year',
  '%m': 'Month (01–12)',
  '%d': 'Day (01–31)',
  '%e': 'Day (space-padded)',
  '%H': 'Hour 24h (00–23)',
  '%I': 'Hour 12h (01–12)',
  '%M': 'Minute (00–59)',
  '%S': 'Second (00–59)',
  '%p': 'AM/PM',
  '%b': 'Month abbr (Jan)',
  '%B': 'Month full (January)',
  '%a': 'Weekday abbr (Mon)',
  '%A': 'Weekday full (Monday)',
  '%Z': 'Timezone name',
  '%z': 'Timezone offset',
  '%s': 'Epoch seconds',
  '%3N': 'Milliseconds',
  '%6N': 'Microseconds',
  '%9N': 'Nanoseconds',
  '%T': 'Time (%H:%M:%S)',
  '%F': 'Date (%Y-%m-%d)',
};

/** Full strptime reference dictionary grouped by category */
interface StrptimeDirective {
  directive: string;
  description: string;
  example: string;
}

interface StrptimeCategory {
  name: string;
  directives: StrptimeDirective[];
}

const STRPTIME_REFERENCE: StrptimeCategory[] = [
  {
    name: 'Year',
    directives: [
      { directive: '%Y', description: '4-digit year', example: '2024' },
      { directive: '%y', description: '2-digit year (00–99)', example: '24' },
      { directive: '%C', description: 'Century (year / 100)', example: '20' },
      { directive: '%G', description: 'ISO 8601 week-based year', example: '2024' },
      { directive: '%g', description: 'ISO 8601 2-digit week-based year', example: '24' },
    ],
  },
  {
    name: 'Month',
    directives: [
      { directive: '%m', description: 'Month as zero-padded number', example: '01–12' },
      { directive: '%b', description: 'Abbreviated month name', example: 'Jan, Feb' },
      { directive: '%B', description: 'Full month name', example: 'January' },
      { directive: '%h', description: 'Same as %b', example: 'Jan' },
    ],
  },
  {
    name: 'Day',
    directives: [
      { directive: '%d', description: 'Day of month, zero-padded', example: '01–31' },
      { directive: '%e', description: 'Day of month, space-padded', example: ' 1–31' },
      { directive: '%j', description: 'Day of year', example: '001–366' },
      { directive: '%u', description: 'ISO weekday (1=Mon, 7=Sun)', example: '1–7' },
      { directive: '%w', description: 'Weekday (0=Sun, 6=Sat)', example: '0–6' },
      { directive: '%a', description: 'Abbreviated weekday name', example: 'Mon, Tue' },
      { directive: '%A', description: 'Full weekday name', example: 'Monday' },
    ],
  },
  {
    name: 'Hour',
    directives: [
      { directive: '%H', description: '24-hour, zero-padded', example: '00–23' },
      { directive: '%I', description: '12-hour, zero-padded', example: '01–12' },
      { directive: '%k', description: '24-hour, space-padded', example: ' 0–23' },
      { directive: '%l', description: '12-hour, space-padded', example: ' 1–12' },
      { directive: '%p', description: 'AM or PM', example: 'AM, PM' },
      { directive: '%P', description: 'am or pm (lowercase)', example: 'am, pm' },
    ],
  },
  {
    name: 'Minute / Second',
    directives: [
      { directive: '%M', description: 'Minute (00–59)', example: '00–59' },
      { directive: '%S', description: 'Second (00–60)', example: '00–60' },
      { directive: '%f', description: 'Microseconds (6 digits)', example: '000000' },
      { directive: '%3N', description: 'Milliseconds (3 digits)', example: '123' },
      { directive: '%6N', description: 'Microseconds (6 digits)', example: '123456' },
      { directive: '%9N', description: 'Nanoseconds (9 digits)', example: '123456789' },
      { directive: '%s', description: 'Unix epoch seconds', example: '1706745600' },
      { directive: '%Q', description: 'Unix epoch milliseconds', example: '1706745600000' },
    ],
  },
  {
    name: 'Timezone',
    directives: [
      { directive: '%Z', description: 'Timezone abbreviation', example: 'UTC, EST' },
      { directive: '%z', description: 'UTC offset (+HHMM)', example: '+0000, -0500' },
      { directive: '%:z', description: 'UTC offset (+HH:MM)', example: '+00:00' },
      { directive: '%::z', description: 'UTC offset (+HH:MM:SS)', example: '+00:00:00' },
    ],
  },
  {
    name: 'Composite',
    directives: [
      { directive: '%F', description: 'ISO date (%Y-%m-%d)', example: '2024-01-31' },
      { directive: '%T', description: 'ISO time (%H:%M:%S)', example: '14:30:00' },
      { directive: '%R', description: 'Time (%H:%M)', example: '14:30' },
      { directive: '%c', description: 'Locale date and time', example: 'Mon Jan 31 14:30:00 2024' },
      { directive: '%x', description: 'Locale date', example: '01/31/2024' },
      { directive: '%X', description: 'Locale time', example: '14:30:00' },
      { directive: '%D', description: 'Date (%m/%d/%y)', example: '01/31/24' },
      { directive: '%r', description: '12-hour time (%I:%M:%S %p)', example: '02:30:00 PM' },
    ],
  },
  {
    name: 'Other',
    directives: [
      { directive: '%n', description: 'Newline character', example: '\\n' },
      { directive: '%t', description: 'Tab character', example: '\\t' },
      { directive: '%%', description: 'Literal % character', example: '%' },
      { directive: '%V', description: 'ISO 8601 week number', example: '01–53' },
      { directive: '%U', description: 'Week number (Sun start)', example: '00–53' },
      { directive: '%W', description: 'Week number (Mon start)', example: '00–53' },
    ],
  },
];

// TimeConfig / TimestampMatch / the probe itself now live in
// `engine/timestampMatch`, so the worker and this tab share one definition.

// Resolve the time directives the ENGINE would actually apply for the current
// metadata — using the same parse → stanza-match → merge path as the pipeline —
// rather than flat-scanning every line. A flat scan would surface a TIME_FORMAT
// from a stanza that never matched this event's sourcetype/host/source.
function parseTimeConfig(propsConf: string, metadata: EventMetadata): TimeConfig {
  const directives = mergeDirectives(matchStanzas(parseConf(propsConf, 'props.conf').stanzas, metadata));
  const get = (key: string) => directives.find((d) => d.key === key)?.value.trim();
  return {
    timePrefix: get('TIME_PREFIX') ?? null,
    timeFormat: get('TIME_FORMAT') ?? null,
    // Shared with the engine so 0 / -1 (no limit) draw the window it scans.
    maxLookahead: resolveLookahead(get('MAX_TIMESTAMP_LOOKAHEAD')),
    tz: get('TZ') ?? null,
  };
}

/** Extract strftime directives from a format string */
function extractDirectives(format: string): { directive: string; description: string }[] {
  const result: { directive: string; description: string }[] = [];
  let i = 0;
  while (i < format.length) {
    if (format[i] === '%') {
      // Try 3-char directives first (%3N, %6N, %9N)
      const three = format.slice(i, i + 3);
      if (DIRECTIVE_DESCRIPTIONS[three]) {
        result.push({ directive: three, description: DIRECTIVE_DESCRIPTIONS[three] });
        i += 3;
        continue;
      }
      const two = format.slice(i, i + 2);
      if (DIRECTIVE_DESCRIPTIONS[two]) {
        result.push({ directive: two, description: DIRECTIVE_DESCRIPTIONS[two] });
        i += 2;
        continue;
      }
      i += 1;
    } else {
      i += 1;
    }
  }
  return result;
}

export function TimestampTab({ items, currentPage, eventsPerPage }: TimestampTabProps) {
  const propsConf = useAppStore((s) => s.propsConf);
  const metadata = useAppStore((s) => s.metadata);
  const [refOpen, setRefOpen] = useState(false);
  const [refSearch, setRefSearch] = useState('');

  const config = useMemo(() => parseTimeConfig(propsConf, metadata), [propsConf, metadata]);

  // Probing runs in a terminatable worker (#117): TIME_PREFIX is a user regex,
  // and executing it during render had nothing to interrupt it. Memoised so the
  // hook re-probes when the events or the config change, not on every render.
  const raws = useMemo(() => items.map((item) => item.event._raw), [items]);
  const { status, probes } = useTimestampMatch(raws, config);

  const directives = useMemo(
    () => config.timeFormat ? extractDirectives(config.timeFormat) : [],
    [config.timeFormat]
  );

  const filteredRef = useMemo(() => {
    if (!refSearch) return STRPTIME_REFERENCE;
    const lower = refSearch.toLowerCase();
    return STRPTIME_REFERENCE.map((cat) => ({
      ...cat,
      directives: cat.directives.filter(
        (d) => d.directive.toLowerCase().includes(lower) || d.description.toLowerCase().includes(lower) || d.example.toLowerCase().includes(lower)
      ),
    })).filter((cat) => cat.directives.length > 0);
  }, [refSearch]);

  return (
    <div className="flex flex-col h-full">
      {/* Config summary */}
      <div className="flex-shrink-0 px-3 py-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <ConfigValue label="TIME_PREFIX" value={config.timePrefix} color={PREFIX_COLOR} />
          <ConfigValue label="TIME_FORMAT" value={config.timeFormat} color={FORMAT_COLOR} />
          <ConfigValue label="MAX_TIMESTAMP_LOOKAHEAD" value={Number.isFinite(config.maxLookahead) ? config.maxLookahead.toString() : 'no limit'} color={LOOKAHEAD_COLOR} />
          {config.tz && <ConfigValue label="TZ" value={config.tz} />}
        </div>
        {directives.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-1.5">
            {directives.map((d, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]">
                <code className="px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)] text-[var(--color-success)] font-mono">{d.directive}</code>
                {d.description}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* STRPTIME Reference */}
      <div className="flex-shrink-0 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <button
          onClick={() => setRefOpen(!refOpen)}
          className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-[var(--color-bg-tertiary)] transition-colors cursor-pointer text-left"
        >
          <svg
            className="w-3 h-3 transition-transform flex-shrink-0"
            style={{ color: 'var(--color-text-muted)', transform: refOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-xs font-medium text-[var(--color-text-muted)]">STRPTIME Reference</span>
        </button>
        {refOpen && (
          <div className="px-3 pb-2">
            <div className="relative mb-2">
              <svg
                className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 pointer-events-none"
                style={{ color: 'var(--color-text-muted)' }}
                fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <input
                type="text"
                aria-label="Search strptime directives"
                placeholder="Search directives..."
                value={refSearch}
                onChange={(e) => setRefSearch(e.target.value)}
                className="w-full max-w-xs pl-6 pr-2 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] focus:outline-none focus:border-[var(--color-accent)]"
              />
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
                    <th className="pb-1 pr-3 font-medium w-16">Directive</th>
                    <th className="pb-1 pr-3 font-medium">Description</th>
                    <th className="pb-1 font-medium w-32">Example</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRef.map((cat) => (
                    <StrptimeCategoryRows key={cat.name} category={cat} activeDirectives={directives.map((d) => d.directive)} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* Legend */}
      <div className="flex-shrink-0 px-3 py-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
        <div className="flex items-center gap-4 text-[10px]">
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(PREFIX_COLOR, 25), borderBottom: `2px solid ${PREFIX_COLOR}` }} />
            <span className="text-[var(--color-text-muted)]">TIME_PREFIX match</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-3 h-2 rounded-sm" style={{ backgroundColor: tint(FORMAT_COLOR, 25), borderBottom: `2px solid ${FORMAT_COLOR}` }} />
            <span className="text-[var(--color-text-muted)]">TIME_FORMAT match</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[11px] font-bold leading-none" style={{ color: LOOKAHEAD_COLOR }}>]</span>
            <span className="text-[var(--color-text-muted)]">Lookahead boundary</span>
          </span>
        </div>
      </div>

      {/* Events */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {!config.timeFormat ? (
          <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)] text-sm">
            No TIME_FORMAT configured in props.conf
          </div>
        ) : status === 'timeout' ? (
          // The refusal path the old synchronous version could never reach: it
          // had no way to notice, so the tab simply stopped responding.
          <div className="flex flex-col items-center justify-center gap-1 py-12 text-center">
            <span className="text-sm font-medium text-[var(--color-error)]">
              Timestamp matching timed out
            </span>
            <span className="text-xs text-[var(--color-text-muted)] max-w-md">
              TIME_PREFIX took too long to match. The usual cause is a regular expression
              that backtracks catastrophically — nested or overlapping quantifiers such as{' '}
              <code className="font-mono">(a|a)*</code>.
            </span>
          </div>
        ) : (
          items.map((item, idx) => {
            const globalIdx = (currentPage - 1) * eventsPerPage + idx + 1;
            return (
              <TimestampEventCard
                key={idx}
                raw={item.event._raw}
                globalIdx={globalIdx}
                config={config}
                probe={probes[idx] ?? null}
                pending={status === 'pending'}
                resolvedTime={item.event._time}
                timeSource={resolvedTimeSource(item.event)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}

function ConfigValue({ label, value, color }: { label: string; value: string | null; color?: string }) {
  return (
    <span className="text-[var(--color-text-muted)]">
      {label}={' '}
      {value ? (
        <code className="font-mono font-medium px-1 py-0.5 rounded bg-[var(--color-bg-tertiary)]" style={{ color }}>
          {value}
        </code>
      ) : (
        <span className="italic opacity-60">not set</span>
      )}
    </span>
  );
}

/** How the pipeline actually resolved this event's `_time` (#85). */
function resolvedTimeSource(event: SplunkEvent): TimeSource | undefined {
  return event.processingTrace
    .filter((step) => step.processor === 'timestampExtractor')
    .at(-1)?.timeSource;
}

/**
 * What each fallback rule should say when it, rather than the event text,
 * supplied `_time`. A timestamp that came from the clock or the event before it
 * is indistinguishable from a parsed one in the output, which is the whole
 * reason for badging it.
 */
const FALLBACK_LABEL: Partial<Record<TimeSource, string>> = {
  'previous-event': 'From previous event',
  'current-time': 'From index time',
  'datetime-config-current': 'DATETIME_CONFIG = CURRENT',
  'datetime-config-none': 'DATETIME_CONFIG = NONE',
};

function TimestampEventCard({
  raw,
  globalIdx,
  config,
  probe,
  pending,
  resolvedTime,
  timeSource,
}: {
  raw: string;
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
                className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] font-medium"
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
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-success)]/20 text-[var(--color-success)] font-medium font-mono">
              {parsedTime.toISOString()}
            </span>
          ) : (
            <span className="text-xs px-1.5 py-0.5 rounded bg-[var(--color-error)]/20 text-[var(--color-error)] font-medium">
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

function TimestampOverlay({ raw, probe, config }: { raw: string; probe: TimestampProbe | null; config: TimeConfig }) {
  const result = probe?.match ?? null;
  if (!result) {
    // No match — show the full lookahead window if the prefix matched, otherwise
    // plain text. The prefix span comes back on the probe rather than being
    // re-derived here: re-running the user's TIME_PREFIX during render is the
    // whole bug (#117), and this branch is exactly where it used to happen.
    const prefix = probe?.prefix;
    {
      if (prefix) {
        const pStart = prefix.start;
        const pEnd = prefix.end;
        const laEnd = prefix.lookaheadEnd;
        const segments: React.ReactNode[] = [];
        if (pStart > 0) {
          segments.push(<span key="pre" className="text-[var(--color-text-primary)] opacity-40">{raw.substring(0, pStart)}</span>);
        }
        segments.push(
          <span key="prefix" style={{ backgroundColor: tint(PREFIX_COLOR, 19), borderBottom: `2px solid ${PREFIX_COLOR}` }} className="rounded-sm px-0.5">
            {raw.substring(pStart, pEnd)}
          </span>
        );
        segments.push(
          <span key="la">
            {raw.substring(pEnd, laEnd)}
          </span>
        );
        segments.push(
          <span key="la-marker" style={{ color: LOOKAHEAD_COLOR, fontWeight: 'bold' }}>]</span>
        );
        if (laEnd < raw.length) {
          segments.push(<span key="post" className="text-[var(--color-text-primary)] opacity-40">{raw.substring(laEnd)}</span>);
        }
        return <>{segments}</>;
      }
    }
    return <span className="text-[var(--color-text-primary)] opacity-60">{raw}</span>;
  }

  const segments: React.ReactNode[] = [];
  let cursor = 0;

  // Before prefix
  if (result.prefixStart > cursor) {
    segments.push(
      <span key="pre-prefix" className="text-[var(--color-text-primary)] opacity-40">
        {raw.substring(cursor, result.prefixStart)}
      </span>
    );
    cursor = result.prefixStart;
  }

  // Prefix region (only if TIME_PREFIX was configured and matched something)
  if (config.timePrefix && result.prefixEnd > result.prefixStart) {
    segments.push(
      <span
        key="prefix"
        style={{ backgroundColor: tint(PREFIX_COLOR, 19), borderBottom: `2px solid ${PREFIX_COLOR}` }}
        className="rounded-sm px-0.5"
        title={`TIME_PREFIX: ${config.timePrefix}`}
      >
        {raw.substring(cursor, result.prefixEnd)}
      </span>
    );
    cursor = result.prefixEnd;
  }

  // Between prefix end and timestamp start (within lookahead)
  if (result.tsStart > cursor) {
    segments.push(
      <span key="pre-ts" className="text-[var(--color-text-primary)]">
        {raw.substring(cursor, result.tsStart)}
      </span>
    );
    cursor = result.tsStart;
  }

  // Timestamp match
  segments.push(
    <span
      key="ts"
      style={{ backgroundColor: tint(FORMAT_COLOR, 21), borderBottom: `2px solid ${FORMAT_COLOR}` }}
      className="rounded-sm px-0.5"
      title={`TIME_FORMAT: ${config.timeFormat}\nParsed: ${result.parsedTimeMs != null ? new Date(result.parsedTimeMs).toISOString() : 'failed'}`}
    >
      {raw.substring(cursor, result.tsEnd)}
    </span>
  );
  cursor = result.tsEnd;

  // Rest of lookahead window after timestamp
  if (result.lookaheadEnd > cursor) {
    segments.push(
      <span key="post-ts-la">
        {raw.substring(cursor, result.lookaheadEnd)}
      </span>,
      <span key="la-marker" style={{ color: LOOKAHEAD_COLOR, fontWeight: 'bold' }}>]</span>
    );
    cursor = result.lookaheadEnd;
  }

  // After lookahead
  if (cursor < raw.length) {
    segments.push(
      <span key="post" className="text-[var(--color-text-primary)] opacity-40">
        {raw.substring(cursor)}
      </span>
    );
  }

  return <>{segments}</>;
}

function StrptimeCategoryRows({ category, activeDirectives }: { category: StrptimeCategory; activeDirectives: string[] }) {
  return (
    <>
      <tr>
        <td colSpan={3} className="pt-2 pb-0.5 text-[10px] font-medium text-[var(--color-accent)] uppercase tracking-wider">
          {category.name}
        </td>
      </tr>
      {category.directives.map((d) => {
        const isActive = activeDirectives.includes(d.directive);
        return (
          <tr
            key={d.directive}
            className="hover:bg-[var(--color-bg-tertiary)] transition-colors"
            style={isActive ? { backgroundColor: 'var(--color-accent-muted, rgba(59,130,246,0.1))' } : undefined}
          >
            <td className="py-0.5 pr-3">
              <code
                className="font-mono px-1 py-0.5 rounded text-[11px]"
                style={{
                  color: isActive ? 'var(--color-success)' : 'var(--color-text-primary)',
                  backgroundColor: isActive ? 'var(--color-success-bg, rgba(34,197,94,0.15))' : 'var(--color-bg-tertiary)',
                }}
              >
                {d.directive}
              </code>
            </td>
            <td className="py-0.5 pr-3 text-[var(--color-text-secondary)]">{d.description}</td>
            <td className="py-0.5 text-[var(--color-text-muted)] font-mono text-[11px]">{d.example}</td>
          </tr>
        );
      })}
    </>
  );
}
