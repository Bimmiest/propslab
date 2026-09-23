import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { safeRegex } from '../../utils/splunkRegex';
import { parseTimestamp, parseTzAlias, strftimeToRegex } from '../../utils/strftime';
import { atDirective } from '../parser/provenance';

/**
 * Priority-ordered formats for automatic timestamp recognition when no
 * TIME_FORMAT is configured. A pragmatic subset of Splunk's datetime.xml —
 * ordered most-specific first so an ISO 8601 timestamp with a zone offset is
 * preferred over a variant without one (and over a bare date).
 */
export const AUTO_TIME_FORMATS = [
  '%Y-%m-%dT%H:%M:%S.%3N%z',
  '%Y-%m-%dT%H:%M:%S%z',
  '%Y-%m-%dT%H:%M:%S.%3N',
  '%Y-%m-%dT%H:%M:%S',
  '%Y-%m-%d %H:%M:%S.%3N',
  '%Y-%m-%d %H:%M:%S',
  '%d/%b/%Y:%H:%M:%S %z', // Apache access log
  '%b %e %H:%M:%S',        // syslog (no year → current year, space-padded day)
  '%m/%d/%Y %H:%M:%S',
  '%Y/%m/%d %H:%M:%S',
  '%m/%d/%Y',
  '%Y-%m-%d',
];

// Compile the recognition regexes once. They are non-global, so `.exec` is
// stateless across events and calls.
const AUTO_PATTERNS = AUTO_TIME_FORMATS.map((fmt) => ({ fmt, regex: strftimeToRegex(fmt) }));

/**
 * Try to find a timestamp in `region` using the auto-recognition patterns, then
 * a leading-epoch fallback. Returns the parsed date plus the format that matched.
 *
 * Splunk's datetime recognition is positional, so candidates are scored by match
 * position (earliest wins) and then by format specificity (the priority order of
 * AUTO_TIME_FORMATS). This prevents a more-specific format that matches deep in a
 * message body from beating the intended timestamp at the front of the region.
 */
function autoRecognize(
  region: string,
  tz?: string,
  onUnresolvedTz?: (tz: string) => void,
  tzAlias?: ReadonlyMap<string, string>,
  now?: Date,
): { date: Date; format: string } | null {
  let best: { index: number; priority: number; date: Date; format: string } | null = null;
  for (const [priority, { fmt, regex }] of AUTO_PATTERNS.entries()) {
    const m = regex.exec(region);
    if (!m) continue;
    const date = parseTimestamp(m[0], fmt, tz, onUnresolvedTz, tzAlias, now);
    if (!date || isNaN(date.getTime())) continue;
    // Earliest match wins; a tie is broken by the more specific (lower-priority-
    // index) format.
    if (best === null || m.index < best.index) {
      best = { index: m.index, priority, date, format: fmt };
    }
  }
  if (best) return { date: best.date, format: best.format };
  // Epoch seconds (10 digits) or milliseconds (13) at the very start of the region.
  // Anchored to avoid mistaking arbitrary long numbers elsewhere for a timestamp.
  const epoch = /^\s*(\d{13}|\d{10})(?![0-9])/.exec(region);
  if (epoch) {
    const digits = epoch[1] ?? '';
    const ms = digits.length >= 13 ? Number(digits) : Number(digits) * 1000;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) return { date, format: 'epoch' };
  }
  return null;
}

/**
 * props.conf.spec defaults for the timestamp sanity bounds. A timestamp outside
 * these is not trusted: Splunk keeps the event and falls back down the chain
 * rather than placing it years away from its neighbours.
 */
const BOUND_DEFAULTS = {
  MAX_DAYS_AGO: 2000,
  MAX_DAYS_HENCE: 2,
  MAX_DIFF_SECS_AGO: 3600,
  MAX_DIFF_SECS_HENCE: 604800,
} as const;

const DAY_MS = 86_400_000;

function numericDirective(
  directives: ConfDirective[],
  key: keyof typeof BOUND_DEFAULTS,
): number {
  const raw = directives.find((d) => d.key === key)?.value.trim();
  if (raw === undefined) return BOUND_DEFAULTS[key];
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BOUND_DEFAULTS[key];
}

export function extractTimestamps(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  /**
   * The moment that stands in for index time: the MAX_DAYS_AGO/HENCE bounds are
   * measured from it, a yearless format takes its year, and the fallback tail of
   * the chain lands on it. `runPipeline` passes `PipelineOptions.now` so a
   * recorded fixture keeps being judged against the day it was captured (#293).
   */
  now: Date = new Date(),
): SplunkEvent[] {
  const timePrefixDir = directives.find((d) => d.key === 'TIME_PREFIX');
  const timeFormatDir = directives.find((d) => d.key === 'TIME_FORMAT');
  const maxLookaheadDir = directives.find((d) => d.key === 'MAX_TIMESTAMP_LOOKAHEAD');
  const tzDir = directives.find((d) => d.key === 'TZ');
  const tzAliasDir = directives.find((d) => d.key === 'TZ_ALIAS');
  const datetimeConfigDir = directives.find((d) => d.key === 'DATETIME_CONFIG');

  // DATETIME_CONFIG = CURRENT stamps every event with the time it was merged;
  // = NONE stops the extractor running at all and the event keeps its index
  // time. In a browser both land on the same instant — the moment of
  // simulation — so they are distinguished by their trace text rather than by
  // producing different values. Any other value names a datetime.xml file,
  // which is a file this tool has no access to; that case falls through to the
  // normal path and keeps its `ignored` diagnostic.
  const datetimeConfig = datetimeConfigDir?.value.trim().toUpperCase();
  if (datetimeConfig === 'CURRENT' || datetimeConfig === 'NONE') {
    const timeSource = datetimeConfig === 'CURRENT' ? 'datetime-config-current' : 'datetime-config-none';
    const description =
      datetimeConfig === 'CURRENT'
        ? `DATETIME_CONFIG = CURRENT — _time set to the time of indexing (${now.toISOString()}), not read from the event`
        : `DATETIME_CONFIG = NONE — timestamp extraction disabled, _time is the time of indexing (${now.toISOString()})`;

    return events.map((event) => ({
      ...event,
      _time: now,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description,
          timeSource,
        },
      ],
    }));
  }

  const maxDaysAgo = numericDirective(directives, 'MAX_DAYS_AGO');
  const maxDaysHence = numericDirective(directives, 'MAX_DAYS_HENCE');
  const maxDiffSecsAgo = numericDirective(directives, 'MAX_DIFF_SECS_AGO');
  const maxDiffSecsHence = numericDirective(directives, 'MAX_DIFF_SECS_HENCE');

  const timeFormat = timeFormatDir?.value.trim();
  // props.conf.spec default for MAX_TIMESTAMP_LOOKAHEAD is 128 characters.
  const parsedLookahead = maxLookaheadDir ? parseInt(maxLookaheadDir.value.trim(), 10) : 128;
  const maxLookahead = Number.isFinite(parsedLookahead) && parsedLookahead > 0 ? parsedLookahead : 128;
  const tz = tzDir?.value.trim();

  // TZ_ALIAS only ever rewrites a zone the event itself carried, so a table
  // with no %Z to act on is not an error — it is simply unused, and saying so
  // would fire on every stanza that sets it defensively.
  const { aliases: tzAlias, invalid: invalidAliases } = parseTzAlias(tzAliasDir?.value ?? '');
  if (diagnostics && invalidAliases.length > 0) {
    diagnostics.push({
      level: 'warning',
      message:
        `TZ_ALIAS ${invalidAliases.map((p) => `"${p}"`).join(', ')} is not in the form ` +
        '<abbreviation>=<timezone> and was skipped; the rest of the table still applies. ' +
        'Example: TZ_ALIAS = EST=GMT-5:00,CST=GMT-6:00',
      file: 'props.conf',
      ...atDirective(tzAliasDir),
      directiveKey: 'TZ_ALIAS',
    });
  }

  // Surface a warning (once per distinct value) when a %Z zone name or the TZ
  // directive can't be resolved to an offset and the event is silently treated
  // as UTC. Anchored to the TZ directive when present, else the TIME_FORMAT line.
  const reportedTz = new Set<string>();
  const onUnresolvedTz = diagnostics
    ? (value: string) => {
        if (reportedTz.has(value)) return;
        reportedTz.add(value);
        const anchor = tzDir ?? timeFormatDir;
        diagnostics.push({
          level: 'warning',
          message: `Timezone "${value}" could not be resolved to an offset and was treated as UTC. Use a numeric offset (e.g. -0500) or a supported abbreviation for an accurate _time.`,
          file: 'props.conf',
          ...atDirective(anchor),
          directiveKey: anchor?.key,
        });
      }
    : undefined;

  const timePrefixRegex = timePrefixDir ? safeRegex(timePrefixDir.value.trim()) : null;
  const formatRegex = timeFormat ? strftimeToRegex(timeFormat) : null;
  // When TIME_PREFIX is set, props.conf.spec requires the TIME_FORMAT to start
  // reading immediately after the prefix — "the TIME_PREFIX regex must match up
  // to and including the character before the TIME_FORMAT date". An unanchored
  // scan would instead accept the format at ANY offset in the lookahead window,
  // masking a broken TIME_PREFIX (a mid-line date gets extracted as _time even
  // though production strptime would fail at the prefix). Anchor to the region
  // start (allowing only leading whitespace, which strptime skips).
  const formatRegexAnchored =
    timeFormat && formatRegex && timePrefixRegex
      ? new RegExp(`^\\s*(?:${formatRegex.source})`, formatRegex.flags)
      : null;

  // Splunk assigns an event with no parseable timestamp the `_time` of the
  // event before it, and only falls back to the time of ingest when there is no
  // previous event to inherit from. Returning null instead left whole events
  // unplaceable on a timeline — and any breaking config that can emit a
  // continuation event produces them, so this is not specific to one directive
  // (#163). Carried across the batch, so a later event inherits from the last
  // event that actually parsed one.
  let lastResolved: Date | null = null;

  /**
   * Why a parsed timestamp was rejected, or null when it is within bounds.
   *
   * The AGO/HENCE pair is measured against the clock; the DIFF_SECS pair against
   * the previous event, which is what makes them catch a single bad line in an
   * otherwise coherent file rather than a whole misconfigured source.
   */
  const outOfBounds = (date: Date): string | null => {
    const fromNow = now.getTime() - date.getTime();
    if (fromNow > maxDaysAgo * DAY_MS) {
      return `more than MAX_DAYS_AGO (${maxDaysAgo}) days in the past`;
    }
    if (-fromNow > maxDaysHence * DAY_MS) {
      return `more than MAX_DAYS_HENCE (${maxDaysHence}) days in the future`;
    }
    if (lastResolved) {
      const fromPrevious = lastResolved.getTime() - date.getTime();
      if (fromPrevious > maxDiffSecsAgo * 1000) {
        return `more than MAX_DIFF_SECS_AGO (${maxDiffSecsAgo}s) before the previous event`;
      }
      if (-fromPrevious > maxDiffSecsHence * 1000) {
        return `more than MAX_DIFF_SECS_HENCE (${maxDiffSecsHence}s) after the previous event`;
      }
    }
    return null;
  };

  const reportedBounds = new Set<string>();

  /**
   * The tail of the fallback chain: the previous event's `_time`, and failing
   * that the time of indexing. Splunk always places an event on the timeline —
   * leaving `_time` null is not one of the outcomes — so `reason` explains which
   * rule got us here and the trace records it as a fallback either way.
   */
  const inherit = (event: SplunkEvent, reason: string): SplunkEvent => {
    const step =
      lastResolved !== null
        ? {
            date: lastResolved,
            timeSource: 'previous-event' as const,
            description: `${reason} — inherited ${lastResolved.toISOString()} from the previous event`,
          }
        : {
            date: now,
            timeSource: 'current-time' as const,
            description: `${reason}, and no previous event to inherit from — fell back to the time of indexing (${now.toISOString()})`,
          };

    return {
      ...event,
      _time: step.date,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description: step.description,
          timeSource: step.timeSource,
        },
      ],
    };
  };

  /**
   * Accept a parsed timestamp, or reject it and fall back. Rejection warns once
   * per distinct reason: a misconfigured TIME_FORMAT can put every event in the
   * batch out of bounds, and one warning per event would bury everything else.
   */
  const accept = (event: SplunkEvent, date: Date, source: 'TIME_FORMAT' | 'auto-recognition', label: string) => {
    const rejection = outOfBounds(date);
    if (rejection !== null) {
      if (diagnostics && !reportedBounds.has(rejection)) {
        reportedBounds.add(rejection);
        const anchor = timeFormatDir ?? tzDir;
        diagnostics.push({
          level: 'warning',
          message: `Timestamp ${date.toISOString()} is ${rejection}, so it was not used. Check TIME_FORMAT, TZ, and the sanity bounds (MAX_DAYS_AGO, MAX_DAYS_HENCE, MAX_DIFF_SECS_AGO, MAX_DIFF_SECS_HENCE).`,
          file: 'props.conf',
          ...atDirective(anchor),
          ...(anchor?.key !== undefined ? { directiveKey: anchor.key } : {}),
        });
      }
      return inherit(event, `Timestamp ${date.toISOString()} rejected: ${rejection}`);
    }

    lastResolved = date;
    return {
      ...event,
      _time: date,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description: label,
          timeSource: source,
        },
      ],
    };
  };

  return events.map((event) => {
    const raw = event._raw;
    let searchStart = 0;

    if (timePrefixRegex) {
      const match = timePrefixRegex.exec(raw);
      if (match) {
        searchStart = match.index + match[0].length;
      } else {
        return inherit(event, 'TIME_PREFIX did not match this event');
      }
    }

    const searchEnd = Math.min(searchStart + maxLookahead, raw.length);
    const searchRegion = raw.substring(searchStart, searchEnd);

    // Explicit TIME_FORMAT path.
    if (timeFormat && formatRegex) {
      // With TIME_PREFIX configured, require the format right after the prefix;
      // otherwise (no prefix) scan the lookahead window from the start.
      const activeRegex = formatRegexAnchored ?? formatRegex;
      const formatMatch = activeRegex.exec(searchRegion);
      if (!formatMatch) return inherit(event, 'TIME_FORMAT did not match this event');

      const timestampStr = formatMatch[0];
      const parsedTime = parseTimestamp(timestampStr, timeFormat, tz, onUnresolvedTz, tzAlias, now);
      // A match that will not parse is still a failure to read a timestamp, so
      // it inherits rather than leaving the event unplaced.
      if (!parsedTime) return inherit(event, `Could not parse "${timestampStr}" with TIME_FORMAT`);

      return accept(event, parsedTime, 'TIME_FORMAT', `Extracted timestamp: ${parsedTime.toISOString()}`);
    }

    // No TIME_FORMAT → automatic timestamp recognition (datetime.xml-style).
    const auto = autoRecognize(searchRegion, tz, onUnresolvedTz, tzAlias, now);
    if (!auto) return inherit(event, 'No recognisable timestamp in this event');

    return accept(
      event,
      auto.date,
      'auto-recognition',
      `Auto-recognized timestamp (${auto.format}): ${auto.date.toISOString()}`,
    );
  });
}
