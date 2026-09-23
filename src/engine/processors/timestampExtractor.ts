import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { safeRegex, validateRegex } from '../../utils/splunkRegex';
import {
  parseTimestampDetailed,
  parseTzAlias,
  strftimeToRegex,
  type CalendarDate,
  type ParsedTimestamp,
} from '../../utils/strftime';
import { atDirective } from '../parser/provenance';
import { setField } from '../utils/fieldBag';
import { effectiveBool, effectiveDirective, effectiveValue } from '../utils/directiveValues';

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
): { parsed: ParsedTimestamp; format: string; index: number; length: number } | null {
  let best: { index: number; length: number; parsed: ParsedTimestamp; format: string } | null = null;
  for (const { fmt, regex } of AUTO_PATTERNS) {
    const m = regex.exec(region);
    if (!m) continue;
    const parsed = parseTimestampDetailed(m[0], fmt, { tz, onUnresolvedTz, tzAlias, now });
    if (!parsed || isNaN(parsed.date.getTime())) continue;
    // Earliest match wins; a tie is broken by the more specific format, which
    // is the one iterated first -- hence the strict `<`.
    if (best === null || m.index < best.index) {
      best = { index: m.index, length: m[0].length, parsed, format: fmt };
    }
  }
  if (best) return best;
  // Epoch seconds (10 digits) or milliseconds (13) at the very start of the region.
  // Anchored to avoid mistaking arbitrary long numbers elsewhere for a timestamp.
  const epoch = /^\s*(\d{13}|\d{10})(?![0-9])/.exec(region);
  if (epoch) {
    const digits = epoch[1] ?? '';
    const ms = digits.length >= 13 ? Number(digits) : Number(digits) * 1000;
    const date = new Date(ms);
    if (!isNaN(date.getTime())) {
      return {
        parsed: { date, wallAsUtcMs: ms, offsetMinutes: 0, hasDate: true },
        format: 'epoch',
        index: epoch[0].length - digits.length,
        length: digits.length,
      };
    }
  }
  return null;
}

/**
 * ADD_EXTRA_TIME_FIELDS, per the registry's reading of props.conf.spec 10.4.3:
 * `all` (or true, the default) keeps the index-time timestamp fields and the
 * sub-second part of `_time`; `subseconds` drops the fields and keeps the
 * sub-seconds; `none` (or false) drops both. A value outside the enumeration
 * is left at the default -- the linter already flags it, and silently
 * stripping fields for a typo would be the more surprising reading.
 */
export type ExtraTimeFieldsMode = 'all' | 'subseconds' | 'none';

export function resolveExtraTimeFields(value: string | undefined): ExtraTimeFieldsMode {
  const v = value?.trim().toLowerCase();
  if (v === 'none' || v === 'false') return 'none';
  if (v === 'subseconds') return 'subseconds';
  return 'all';
}

/** Every field ADD_EXTRA_TIME_FIELDS governs, in the order they are written. */
export const EXTRA_TIME_FIELD_NAMES = [
  'date_hour',
  'date_mday',
  'date_minute',
  'date_month',
  'date_second',
  'date_wday',
  'date_year',
  'date_zone',
  'timeendpos',
  'timestartpos',
  'timestamp',
] as const;

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * The index-time timestamp fields for a timestamp read out of `_raw`.
 *
 * Doc-derived, not captured: the fidelity capture excluded every one of these
 * (`manifest.json`, `excludedFields`), so no fixture pins them. They follow
 * Splunk's documented default-field conventions:
 *  - the date_* values describe the timestamp as written in the event -- its own
 *    wall clock, not `_time` converted to some other zone -- which is why they
 *    are read from `wallAsUtcMs` with the UTC accessors;
 *  - numbers are unpadded, and month and weekday are lower-case full names;
 *  - date_zone is the offset from UTC in minutes, or `local` when neither the
 *    event nor TZ named a zone (the engine then reads the stamp as UTC, which
 *    is this tool's stand-in for the indexer's local zone);
 *  - timestartpos / timeendpos are the character offsets of the timestamp in
 *    `_raw`, end exclusive.
 * `timestamp` is not written here: in the documented convention it carries
 * `none` for an event whose `_time` was not read from its text, so a found
 * timestamp leaves it absent.
 */
export function extraTimeFields(parsed: ParsedTimestamp, start: number, end: number): Record<string, string> {
  const wall = new Date(parsed.wallAsUtcMs);
  return {
    date_hour: String(wall.getUTCHours()),
    date_mday: String(wall.getUTCDate()),
    date_minute: String(wall.getUTCMinutes()),
    date_month: MONTH_NAMES[wall.getUTCMonth()] ?? '',
    date_second: String(wall.getUTCSeconds()),
    date_wday: WEEKDAY_NAMES[wall.getUTCDay()] ?? '',
    date_year: String(wall.getUTCFullYear()),
    date_zone: parsed.offsetMinutes === null ? 'local' : String(parsed.offsetMinutes),
    timeendpos: String(end),
    timestartpos: String(start),
  };
}

/** The wall-clock calendar date a parsed timestamp was written on. */
function wallDate(parsed: ParsedTimestamp): CalendarDate {
  const wall = new Date(parsed.wallAsUtcMs);
  return { year: wall.getUTCFullYear(), month: wall.getUTCMonth(), day: wall.getUTCDate() };
}

/** How far ahead of the clock a dateless stamp may be and still be today. */
const DATELESS_TODAY_WINDOW_MS = 3 * 3_600_000;

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
  const raw = effectiveValue(directives, key);
  if (raw === undefined) return BOUND_DEFAULTS[key];
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : BOUND_DEFAULTS[key];
}

/**
 * MAX_TIMESTAMP_LOOKAHEAD as a character count. props.conf.spec: the default is
 * 128, and "a value of 0 or -1 disables the length constraint". Those two used
 * to fall through to 128 along with genuinely unusable values, so a config that
 * turned the limit off to reach a deep timestamp still missed it (#286). An
 * unlimited window is `Infinity`, which `Math.min` against the event length
 * turns back into "the rest of the event".
 */
export function resolveLookahead(value: string | undefined): number {
  if (value === undefined) return 128;
  const parsed = parseInt(value.trim(), 10);
  if (parsed === 0 || parsed === -1) return Infinity;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 128;
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
  const timePrefixDir = effectiveDirective(directives, 'TIME_PREFIX');
  const timeFormatDir = effectiveDirective(directives, 'TIME_FORMAT');
  const maxLookaheadDir = effectiveDirective(directives, 'MAX_TIMESTAMP_LOOKAHEAD');
  const tzDir = effectiveDirective(directives, 'TZ');
  const tzAliasDir = effectiveDirective(directives, 'TZ_ALIAS');
  const datetimeConfigDir = effectiveDirective(directives, 'DATETIME_CONFIG');
  const extraMode = resolveExtraTimeFields(effectiveDirective(directives, 'ADD_EXTRA_TIME_FIELDS')?.value);
  const datelessFromSystem = effectiveBool(directives, 'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', false);

  // `none` drops the sub-second part of `_time` along with the fields, so the
  // event is placed to the second -- the storage saving the setting exists for.
  const granular = (date: Date): Date =>
    extraMode === 'none' ? new Date(Math.floor(date.getTime() / 1000) * 1000) : date;

  // An event whose `_time` did not come from its own text carries
  // `timestamp=none` and no date_* fields -- there is no written timestamp for
  // them to describe. Doc-derived, like `extraTimeFields`.
  const noTimestampFields = (fields: SplunkEvent['fields']): SplunkEvent['fields'] => {
    if (extraMode !== 'all') return fields;
    const out = { ...fields };
    setField(out, 'timestamp', 'none');
    return out;
  };
  const noTimestampAdded = extraMode === 'all' ? { fieldsAdded: ['timestamp'] } : {};

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
      _time: granular(now),
      fields: noTimestampFields(event.fields),
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description,
          timeSource,
          ...noTimestampAdded,
        },
      ],
    }));
  }

  const maxDaysAgo = numericDirective(directives, 'MAX_DAYS_AGO');
  const maxDaysHence = numericDirective(directives, 'MAX_DAYS_HENCE');
  const maxDiffSecsAgo = numericDirective(directives, 'MAX_DIFF_SECS_AGO');
  const maxDiffSecsHence = numericDirective(directives, 'MAX_DIFF_SECS_HENCE');

  const timeFormat = timeFormatDir?.value.trim();
  const maxLookahead = resolveLookahead(maxLookaheadDir?.value);
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
  // A TIME_PREFIX that will not compile used to be dropped, and the scan began
  // at offset 0 — so a broken prefix could still produce a plausible `_time`
  // read from the wrong place, which is the one outcome that hides the mistake.
  // It is treated as a prefix that never matches instead: every event takes the
  // ordinary no-timestamp fallback, and the error says why (#286).
  const timePrefixBroken = timePrefixDir !== undefined && timePrefixRegex === null;
  if (timePrefixBroken && diagnostics) {
    const pattern = timePrefixDir.value.trim();
    const why = validateRegex(pattern) ?? 'rejected as ReDoS-prone';
    diagnostics.push({
      level: 'error',
      message:
        `TIME_PREFIX (${pattern}) could not be compiled: ${why}. It was treated as never matching, ` +
        'so no event had its timestamp read — each fell back to the previous event or the time of indexing.',
      file: 'props.conf',
      ...atDirective(timePrefixDir),
      directiveKey: 'TIME_PREFIX',
    });
  }
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
   * The wall-clock date of the last timestamp that parsed, which is where a
   * dateless timestamp takes its date from by default.
   */
  let lastWallDate: CalendarDate | null = null;

  /**
   * How many accepted timestamps each format produced, for the MAX_DIFF_SECS
   * exemption below. The explicit-TIME_FORMAT path records its one format, so
   * it is always the majority; auto-recognition records whichever pattern hit.
   */
  const formatCounts = new Map<string, number>();

  /**
   * Whether `format` is the one "the majority of timestamps from the source"
   * use. Approximated over the events accepted so far in this batch — the only
   * source history a simulation has — with a tie counted as a majority, so the
   * second event of a two-format file is not penalised for arriving second.
   */
  const isMajorityFormat = (format: string): boolean => {
    const mine = formatCounts.get(format) ?? 0;
    if (mine === 0) return false;
    for (const count of formatCounts.values()) if (count > mine) return false;
    return true;
  };

  /**
   * Why a parsed timestamp was rejected, or null when it is accepted.
   *
   * The AGO/HENCE pair is measured against the clock and is absolute. The
   * DIFF_SECS pair is measured against the previous event, and props.conf.spec
   * does not make it a hard limit: an event beyond it is accepted "only if it
   * has the same exact time format as the majority of timestamps from the
   * source". Rejecting outright broke the commonest case it was never meant to
   * catch — logs pasted newest-first, where every step is backwards and every
   * timestamp is in the same TIME_FORMAT (#286). What the bound is for is a
   * stray date of some other shape in the message body, and that is what the
   * format test still catches.
   */
  const outOfBounds = (date: Date, format: string): { rejection: string | null; note?: string } => {
    const fromNow = now.getTime() - date.getTime();
    if (fromNow > maxDaysAgo * DAY_MS) {
      return { rejection: `more than MAX_DAYS_AGO (${maxDaysAgo}) days in the past` };
    }
    if (-fromNow > maxDaysHence * DAY_MS) {
      return { rejection: `more than MAX_DAYS_HENCE (${maxDaysHence}) days in the future` };
    }
    if (lastResolved) {
      const fromPrevious = lastResolved.getTime() - date.getTime();
      const diff =
        fromPrevious > maxDiffSecsAgo * 1000
          ? `more than MAX_DIFF_SECS_AGO (${maxDiffSecsAgo}s) before the previous event`
          : -fromPrevious > maxDiffSecsHence * 1000
            ? `more than MAX_DIFF_SECS_HENCE (${maxDiffSecsHence}s) after the previous event`
            : null;
      if (diff !== null) {
        return isMajorityFormat(format)
          ? { rejection: null, note: `${diff}, kept because its format is the one most of this source's timestamps use` }
          : { rejection: `${diff}, in a format (${format}) most of this source's timestamps do not use` };
      }
    }
    return { rejection: null };
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
      _time: granular(step.date),
      fields: noTimestampFields(event.fields),
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description: step.description,
          timeSource: step.timeSource,
          ...noTimestampAdded,
        },
      ],
    };
  };

  /**
   * Give a timestamp that has a time and no date its date, per
   * DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME (props.conf.spec 10.4.3, as the
   * registry describes it -- doc-derived, no capture covers a dateless stamp).
   *
   * False, the default, carries the date forward from the last timestamp that
   * parsed. True reads it off the clock: today in the stamp's own zone, unless
   * that puts the stamp three hours or more ahead of now, in which case it was
   * written yesterday -- a log line from 23:30 read at 00:10 is last night's.
   *
   * With no earlier timestamp to carry from, the default path uses the clock
   * rule too. The spec does not say what happens then; the clock is the only
   * other date the indexer has, and 1 January -- what a dateless stamp used to
   * get here -- is certainly not it.
   */
  const supplyDate = (
    parsed: ParsedTimestamp,
    reparse: (date: CalendarDate) => ParsedTimestamp | null,
  ): { parsed: ParsedTimestamp; how: string } | null => {
    if (!datelessFromSystem && lastWallDate !== null) {
      const carried = reparse(lastWallDate);
      return carried && { parsed: carried, how: 'date carried from the previous timestamp' };
    }
    const offsetMs = (parsed.offsetMinutes ?? 0) * 60_000;
    const today = new Date(now.getTime() + offsetMs);
    const candidate = (back: number): CalendarDate => {
      const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - back));
      return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
    };
    const onToday = reparse(candidate(0));
    if (!onToday) return null;
    const source = datelessFromSystem ? 'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME' : 'no previous timestamp';
    if (onToday.date.getTime() - now.getTime() < DATELESS_TODAY_WINDOW_MS) {
      return { parsed: onToday, how: `date taken from the clock (${source})` };
    }
    const yesterday = reparse(candidate(1));
    return yesterday && {
      parsed: yesterday,
      how: `date taken from the clock as yesterday, being 3h or more ahead of it (${source})`,
    };
  };

  /**
   * Accept a parsed timestamp, or reject it and fall back. Rejection warns once
   * per distinct reason: a misconfigured TIME_FORMAT can put every event in the
   * batch out of bounds, and one warning per event would bury everything else.
   */
  const accept = (
    event: SplunkEvent,
    parsed: ParsedTimestamp,
    position: { start: number; end: number },
    source: 'TIME_FORMAT' | 'auto-recognition',
    format: string,
    label: string,
  ) => {
    const { date } = parsed;
    const { rejection, note } = outOfBounds(date, format);
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
    lastWallDate = wallDate(parsed);
    formatCounts.set(format, (formatCounts.get(format) ?? 0) + 1);
    const extra = extraMode === 'all' ? extraTimeFields(parsed, position.start, position.end) : {};
    const fields = { ...event.fields };
    for (const [name, value] of Object.entries(extra)) setField(fields, name, value);
    const extraNames = Object.keys(extra);
    return {
      ...event,
      _time: granular(date),
      fields,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description: note !== undefined ? `${label} (${note})` : label,
          timeSource: source,
          ...(extraNames.length > 0 ? { fieldsAdded: extraNames } : {}),
        },
      ],
    };
  };

  return events.map((event) => {
    const raw = event._raw;
    let searchStart = 0;

    if (timePrefixBroken) return inherit(event, 'TIME_PREFIX could not be compiled, so it never matches');
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
      const parseWith = (dateForDateless?: CalendarDate) =>
        parseTimestampDetailed(timestampStr, timeFormat, { tz, onUnresolvedTz, tzAlias, now, dateForDateless });
      let parsed = parseWith();
      let dateless: string | undefined;
      if (parsed && !parsed.hasDate) {
        const supplied = supplyDate(parsed, parseWith);
        parsed = supplied?.parsed ?? null;
        dateless = supplied?.how;
      }
      // A match that will not parse is still a failure to read a timestamp, so
      // it inherits rather than leaving the event unplaced.
      if (!parsed) return inherit(event, `Could not parse "${timestampStr}" with TIME_FORMAT`);

      // The anchored form lets leading whitespace into the match; the
      // timestamp itself starts after it.
      const start = searchStart + formatMatch.index + (timestampStr.length - timestampStr.trimStart().length);
      const end = searchStart + formatMatch.index + timestampStr.length;
      const label = `Extracted timestamp: ${parsed.date.toISOString()}`;
      return accept(
        event,
        parsed,
        { start, end },
        'TIME_FORMAT',
        timeFormat,
        dateless !== undefined ? `${label} (no date in the timestamp: ${dateless})` : label,
      );
    }

    // No TIME_FORMAT → automatic timestamp recognition (datetime.xml-style).
    const auto = autoRecognize(searchRegion, tz, onUnresolvedTz, tzAlias, now);
    if (!auto) return inherit(event, 'No recognisable timestamp in this event');

    return accept(
      event,
      auto.parsed,
      { start: searchStart + auto.index, end: searchStart + auto.index + auto.length },
      'auto-recognition',
      auto.format,
      `Auto-recognized timestamp (${auto.format}): ${auto.parsed.date.toISOString()}`,
    );
  });
}
