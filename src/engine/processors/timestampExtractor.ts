import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { validateRegex } from '../../utils/splunkRegex';
import {
  parseTimestampDetailed,
  parseTzAlias,
  type CalendarDate,
  type ParsedTimestamp,
} from '../../utils/strftime';
import { atDirective } from '../parser/provenance';
import { setField } from '../utils/fieldBag';
import { effectiveBool, effectiveDirective, effectiveValue } from '../utils/directiveValues';
import { createTimestampFinder, readTimestampLocation, type TimestampSearch } from './timestampRecognizer';

// Re-exported for the Timestamp tab's prober, which searches the way this does.
export { matchTimeFormat, resolveLookahead, timeFormatRegex, type TimeFormatMatch } from './timestampRecognizer';

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

type TraceStep = SplunkEvent['processingTrace'][number];

/**
 * DATETIME_CONFIG = CURRENT stamps every event with the time it was merged;
 * = NONE stops the extractor running at all and the event keeps its index
 * time. In a browser both land on the same instant — the moment of
 * simulation — so they are distinguished by their trace text rather than by
 * producing different values. Any other value names a datetime.xml file,
 * which is a file this tool has no access to; that case falls through to the
 * normal path and keeps its `ignored` diagnostic.
 */
function datetimeConfigStep(directives: ConfDirective[], now: Date): TraceStep | null {
  const datetimeConfig = effectiveDirective(directives, 'DATETIME_CONFIG')?.value.trim().toUpperCase();
  if (datetimeConfig !== 'CURRENT' && datetimeConfig !== 'NONE') return null;
  return {
    processor: 'timestampExtractor',
    phase: 'index-time',
    description:
      datetimeConfig === 'CURRENT'
        ? `DATETIME_CONFIG = CURRENT — _time set to the time of indexing (${now.toISOString()}), not read from the event`
        : `DATETIME_CONFIG = NONE — timestamp extraction disabled, _time is the time of indexing (${now.toISOString()})`,
    timeSource: datetimeConfig === 'CURRENT' ? 'datetime-config-current' : 'datetime-config-none',
  };
}

/**
 * `none` drops the sub-second part of `_time` along with the fields, so the
 * event is placed to the second -- the storage saving the setting exists for.
 */
function granular(extraMode: ExtraTimeFieldsMode, date: Date): Date {
  return extraMode === 'none' ? new Date(Math.floor(date.getTime() / 1000) * 1000) : date;
}

/**
 * An event whose `_time` did not come from its own text carries
 * `timestamp=none` and no date_* fields -- there is no written timestamp for
 * them to describe. Doc-derived, like `extraTimeFields`.
 */
function noTimestampFields(extraMode: ExtraTimeFieldsMode, fields: SplunkEvent['fields']): SplunkEvent['fields'] {
  if (extraMode !== 'all') return fields;
  const out = { ...fields };
  setField(out, 'timestamp', 'none');
  return out;
}

function noTimestampAdded(extraMode: ExtraTimeFieldsMode): { fieldsAdded?: string[] } {
  return extraMode === 'all' ? { fieldsAdded: ['timestamp'] } : {};
}

/**
 * TZ_ALIAS only ever rewrites a zone the event itself carried, so a table
 * with no %Z to act on is not an error — it is simply unused, and saying so
 * would fire on every stanza that sets it defensively. Only entries that are
 * not `abbreviation=zone` are reported.
 */
function warnInvalidTzAlias(
  tzAliasDir: ConfDirective | undefined,
  invalid: readonly string[],
  diagnostics?: ValidationDiagnostic[],
): void {
  if (!diagnostics || invalid.length === 0) return;
  diagnostics.push({
    level: 'warning',
    message:
      `TZ_ALIAS ${invalid.map((p) => `"${p}"`).join(', ')} is not in the form ` +
      '<abbreviation>=<timezone> and was skipped; the rest of the table still applies. ' +
      'Example: TZ_ALIAS = EST=GMT-5:00,CST=GMT-6:00',
    file: 'props.conf',
    ...atDirective(tzAliasDir),
    directiveKey: 'TZ_ALIAS',
  });
}

/**
 * Surface a warning (once per distinct value) when a %Z zone name or the TZ
 * directive can't be resolved to an offset and the event is silently treated
 * as UTC. Anchored to the TZ directive when present, else the TIME_FORMAT line.
 */
function unresolvedTzReporter(
  anchor: ConfDirective | undefined,
  diagnostics?: ValidationDiagnostic[],
): ((value: string) => void) | undefined {
  if (!diagnostics) return undefined;
  const reported = new Set<string>();
  return (value: string) => {
    if (reported.has(value)) return;
    reported.add(value);
    diagnostics.push({
      level: 'warning',
      message: `Timezone "${value}" could not be resolved to an offset and was treated as UTC. Use a numeric offset (e.g. -0500) or a supported abbreviation for an accurate _time.`,
      file: 'props.conf',
      ...atDirective(anchor),
      directiveKey: anchor?.key,
    });
  };
}

/**
 * A TIME_PREFIX that will not compile is treated as never matching: dropping
 * it would read a plausible `_time` from the wrong place, the one outcome
 * that hides the mistake.
 */
function warnBrokenPrefix(
  pattern: string | undefined,
  timePrefixDir: ConfDirective | undefined,
  diagnostics?: ValidationDiagnostic[],
): void {
  if (!diagnostics || pattern === undefined) return;
  const why = validateRegex(pattern) ?? 'invalid regex';
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

function notFound(search: Exclude<TimestampSearch, { found: true }>): string {
  switch (search.reason) {
    case 'prefix-broken': return 'TIME_PREFIX could not be compiled, so it never matches';
    case 'prefix-unmatched': return 'TIME_PREFIX did not match this event';
    case 'format-unmatched': return 'TIME_FORMAT did not match this event';
    case 'unparsable': return `Could not parse "${search.text}" with TIME_FORMAT`;
    case 'unrecognised': return 'No recognisable timestamp in this event';
  }
}

/** The props.conf sanity bounds a parsed timestamp must fall within. */
interface TimestampBounds {
  maxDaysAgo: number;
  maxDaysHence: number;
  maxDiffSecsAgo: number;
  maxDiffSecsHence: number;
}

/** Options the parser needs to re-read a TIME_FORMAT match. */
type ParseOptions = Pick<NonNullable<Parameters<typeof parseTimestampDetailed>[2]>, 'tz' | 'onUnresolvedTz' | 'tzAlias' | 'now'>;

interface BatchConfig {
  now: Date;
  extraMode: ExtraTimeFieldsMode;
  datelessFromSystem: boolean;
  bounds: TimestampBounds;
  parseOptions: ParseOptions;
  boundsAnchor: ConfDirective | undefined;
  diagnostics?: ValidationDiagnostic[];
}

/**
 * One pass of timestamp extraction over a batch of events.
 *
 * Splunk assigns an event with no parseable timestamp the `_time` of the
 * event before it, and only falls back to the time of ingest when there is no
 * previous event to inherit from. Returning null instead left whole events
 * unplaceable on a timeline — and any breaking config that can emit a
 * continuation event produces them, so this is not specific to one directive
 * (#163). The state below is carried across the batch, so a later event
 * inherits from the last event that actually parsed one.
 */
class TimestampBatch {
  private lastResolved: Date | null = null;
  /**
   * The wall-clock date of the last timestamp that parsed, which is where a
   * dateless timestamp takes its date from by default.
   */
  private lastWallDate: CalendarDate | null = null;
  /**
   * How many accepted timestamps each format produced, for the MAX_DIFF_SECS
   * exemption below. The explicit-TIME_FORMAT path records its one format, so
   * it is always the majority; auto-recognition records whichever pattern hit.
   */
  private readonly formatCounts = new Map<string, number>();
  private readonly reportedBounds = new Set<string>();

  private readonly now: Date;
  private readonly extraMode: ExtraTimeFieldsMode;
  private readonly datelessFromSystem: boolean;
  private readonly bounds: TimestampBounds;
  private readonly parseOptions: ParseOptions;
  /** Where an out-of-bounds warning points: TIME_FORMAT, else TZ. */
  private readonly boundsAnchor: ConfDirective | undefined;
  private readonly diagnostics: ValidationDiagnostic[] | undefined;

  constructor(config: BatchConfig) {
    this.now = config.now;
    this.extraMode = config.extraMode;
    this.datelessFromSystem = config.datelessFromSystem;
    this.bounds = config.bounds;
    this.parseOptions = config.parseOptions;
    this.boundsAnchor = config.boundsAnchor;
    this.diagnostics = config.diagnostics;
  }

  /**
   * Whether `format` is the one "the majority of timestamps from the source"
   * use. Approximated over the events accepted so far in this batch — the only
   * source history a simulation has — with a tie counted as a majority, so the
   * second event of a two-format file is not penalised for arriving second.
   */
  private isMajorityFormat(format: string): boolean {
    const mine = this.formatCounts.get(format) ?? 0;
    if (mine === 0) return false;
    for (const count of this.formatCounts.values()) if (count > mine) return false;
    return true;
  }

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
  private outOfBounds(date: Date, format: string): { rejection: string | null; note?: string } {
    const { maxDaysAgo, maxDaysHence, maxDiffSecsAgo, maxDiffSecsHence } = this.bounds;
    const fromNow = this.now.getTime() - date.getTime();
    if (fromNow > maxDaysAgo * DAY_MS) {
      return { rejection: `more than MAX_DAYS_AGO (${maxDaysAgo}) days in the past` };
    }
    if (-fromNow > maxDaysHence * DAY_MS) {
      return { rejection: `more than MAX_DAYS_HENCE (${maxDaysHence}) days in the future` };
    }
    if (!this.lastResolved) return { rejection: null };
    const fromPrevious = this.lastResolved.getTime() - date.getTime();
    const diff =
      fromPrevious > maxDiffSecsAgo * 1000
        ? `more than MAX_DIFF_SECS_AGO (${maxDiffSecsAgo}s) before the previous event`
        : -fromPrevious > maxDiffSecsHence * 1000
          ? `more than MAX_DIFF_SECS_HENCE (${maxDiffSecsHence}s) after the previous event`
          : null;
    if (diff === null) return { rejection: null };
    return this.isMajorityFormat(format)
      ? { rejection: null, note: `${diff}, kept because its format is the one most of this source's timestamps use` }
      : { rejection: `${diff}, in a format (${format}) most of this source's timestamps do not use` };
  }

  /**
   * The tail of the fallback chain: the previous event's `_time`, and failing
   * that the time of indexing. Splunk always places an event on the timeline —
   * leaving `_time` null is not one of the outcomes — so `reason` explains which
   * rule got us here and the trace records it as a fallback either way.
   */
  inherit(event: SplunkEvent, reason: string): SplunkEvent {
    const { now, lastResolved } = this;
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
      _time: granular(this.extraMode, step.date),
      fields: noTimestampFields(this.extraMode, event.fields),
      timestampText: event._raw,
      processingTrace: [
        ...event.processingTrace,
        {
          processor: 'timestampExtractor',
          phase: 'index-time' as const,
          description: step.description,
          timeSource: step.timeSource,
          ...noTimestampAdded(this.extraMode),
        },
      ],
    };
  }

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
  private supplyDate(
    parsed: ParsedTimestamp,
    reparse: (date: CalendarDate) => ParsedTimestamp | null,
  ): { parsed: ParsedTimestamp; how: string } | null {
    const { now, datelessFromSystem } = this;
    if (!datelessFromSystem && this.lastWallDate !== null) {
      const carried = reparse(this.lastWallDate);
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
  }

  /**
   * Reject a timestamp, warning once per distinct reason: a misconfigured
   * TIME_FORMAT can put every event in the batch out of bounds, and one warning
   * per event would bury everything else.
   */
  private reject(event: SplunkEvent, date: Date, rejection: string): SplunkEvent {
    if (this.diagnostics && !this.reportedBounds.has(rejection)) {
      this.reportedBounds.add(rejection);
      const anchor = this.boundsAnchor;
      this.diagnostics.push({
        level: 'warning',
        message: `Timestamp ${date.toISOString()} is ${rejection}, so it was not used. Check TIME_FORMAT, TZ, and the sanity bounds (MAX_DAYS_AGO, MAX_DAYS_HENCE, MAX_DIFF_SECS_AGO, MAX_DIFF_SECS_HENCE).`,
        file: 'props.conf',
        ...atDirective(anchor),
        ...(anchor?.key !== undefined ? { directiveKey: anchor.key } : {}),
      });
    }
    return this.inherit(event, `Timestamp ${date.toISOString()} rejected: ${rejection}`);
  }

  /** Accept a parsed timestamp, or reject it and fall back. */
  private accept(
    event: SplunkEvent,
    parsed: ParsedTimestamp,
    position: { start: number; end: number },
    source: 'TIME_FORMAT' | 'auto-recognition',
    format: string,
    label: string,
  ): SplunkEvent {
    const { date } = parsed;
    const { rejection, note } = this.outOfBounds(date, format);
    if (rejection !== null) return this.reject(event, date, rejection);

    this.lastResolved = date;
    this.lastWallDate = wallDate(parsed);
    this.formatCounts.set(format, (this.formatCounts.get(format) ?? 0) + 1);
    const extra = this.extraMode === 'all' ? extraTimeFields(parsed, position.start, position.end) : {};
    const fields = { ...event.fields };
    for (const [name, value] of Object.entries(extra)) setField(fields, name, value);
    const extraNames = Object.keys(extra);
    return {
      ...event,
      _time: granular(this.extraMode, date),
      fields,
      // What was read, for the Timestamp tab to probe once SEDCMD or an
      // index-time transform has rewritten `_raw` (#328).
      timestampText: event._raw,
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
  }

  /** Place one event from what the recogniser found in it. */
  place(event: SplunkEvent, search: TimestampSearch): SplunkEvent {
    if (!search.found) {
      // A match that will not parse is still a failure to read a timestamp, so
      // it inherits rather than leaving the event unplaced.
      return this.inherit(event, notFound(search));
    }
    const position = { start: search.start, end: search.end };

    if (search.source !== 'TIME_FORMAT') {
      return this.accept(
        event,
        search.parsed,
        position,
        'auto-recognition',
        search.format,
        `Auto-recognized timestamp (${search.format}): ${search.parsed.date.toISOString()}`,
      );
    }

    const format = search.format;
    let parsed: ParsedTimestamp | null = search.parsed;
    let dateless: string | undefined;
    if (!parsed.hasDate) {
      const reparse = (dateForDateless: CalendarDate) =>
        parseTimestampDetailed(search.text, format, { ...this.parseOptions, dateForDateless });
      const supplied = this.supplyDate(parsed, reparse);
      parsed = supplied?.parsed ?? null;
      dateless = supplied?.how;
    }
    if (!parsed) return this.inherit(event, `Could not parse "${search.text}" with TIME_FORMAT`);

    const label = `Extracted timestamp: ${parsed.date.toISOString()}`;
    return this.accept(
      event,
      parsed,
      position,
      'TIME_FORMAT',
      format,
      dateless !== undefined ? `${label} (no date in the timestamp: ${dateless})` : label,
    );
  }
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
  const timeFormatDir = effectiveDirective(directives, 'TIME_FORMAT');
  const tzDir = effectiveDirective(directives, 'TZ');
  const tzAliasDir = effectiveDirective(directives, 'TZ_ALIAS');
  const extraMode = resolveExtraTimeFields(effectiveDirective(directives, 'ADD_EXTRA_TIME_FIELDS')?.value);
  const datelessFromSystem = effectiveBool(directives, 'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', false);
  const bounds: TimestampBounds = {
    maxDaysAgo: numericDirective(directives, 'MAX_DAYS_AGO'),
    maxDaysHence: numericDirective(directives, 'MAX_DAYS_HENCE'),
    maxDiffSecsAgo: numericDirective(directives, 'MAX_DIFF_SECS_AGO'),
    maxDiffSecsHence: numericDirective(directives, 'MAX_DIFF_SECS_HENCE'),
  };

  const configStep = datetimeConfigStep(directives, now);
  if (configStep !== null) {
    return events.map((event) => ({
      ...event,
      _time: granular(extraMode, now),
      fields: noTimestampFields(extraMode, event.fields),
      processingTrace: [...event.processingTrace, { ...configStep, ...noTimestampAdded(extraMode) }],
    }));
  }

  const location = readTimestampLocation(directives);
  const tz = tzDir?.value.trim();
  const { aliases: tzAlias, invalid: invalidAliases } = parseTzAlias(tzAliasDir?.value ?? '');
  warnInvalidTzAlias(tzAliasDir, invalidAliases, diagnostics);
  const onUnresolvedTz = unresolvedTzReporter(tzDir ?? timeFormatDir, diagnostics);
  const parseOptions: ParseOptions = { tz, onUnresolvedTz, tzAlias, now };

  // Located by the shared recogniser, which line breaking also uses, so a
  // line that starts an event under BREAK_ONLY_BEFORE_DATE is read here too.
  const finder = createTimestampFinder(location, parseOptions);
  if (finder.prefixBroken) {
    warnBrokenPrefix(location.timePrefix, effectiveDirective(directives, 'TIME_PREFIX'), diagnostics);
  }

  const batch = new TimestampBatch({
    now, extraMode, datelessFromSystem, bounds, parseOptions, boundsAnchor: timeFormatDir ?? tzDir, diagnostics,
  });
  return events.map((event) => batch.place(event, finder.find(event._raw)));
}
