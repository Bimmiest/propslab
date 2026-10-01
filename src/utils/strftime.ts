/**
 * Convert Splunk TIME_FORMAT (strftime) strings to parse timestamps from raw text.
 *
 * Supports the most common strftime directives used in Splunk props.conf
 * TIME_FORMAT definitions.
 */

import { escapeRegex } from './splunkRegex';

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const MONTH_NAMES_FULL = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

const MONTH_NAMES_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const WEEKDAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

const WEEKDAY_NAMES_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** The name at `index` of a table indexed by a valid Date's month or weekday. */
function nameAt(names: readonly string[], index: number): string {
  return names.slice(index, index + 1).join('');
}

const MONTH_NAME_REGEX = `(${[...MONTH_NAMES_FULL, ...MONTH_NAMES_ABBR].join('|')})`;
const WEEKDAY_NAME_REGEX = `(${[...WEEKDAY_NAMES_FULL, ...WEEKDAY_NAMES_ABBR].join('|')})`;

// ---------------------------------------------------------------------------
// Directive metadata: maps a strftime token to its regex fragment and a
// symbolic capture-group name.
// ---------------------------------------------------------------------------

/** The symbolic names a directive's capture group can take (the `capture:` of each directive). */
type CaptureName =
  | 'ampm'
  | 'day'
  | 'dayOfYear'
  | 'epoch'
  | 'hour12'
  | 'hour24'
  | 'microseconds'
  | 'microsecondsFull'
  | 'milliseconds'
  | 'minute'
  | 'month'
  | 'monthName'
  | 'nanoseconds'
  | 'second'
  | 'subseconds'
  | 'tzName'
  | 'tzOffset'
  | 'weekdayName'
  | 'year2'
  | 'year4';

/** The text each capture read from a timestamp; a capture the format lacks is absent. */
type CaptureBag = Partial<Record<CaptureName, string>>;

interface DirectiveMeta {
  /** Regex fragment (no surrounding parentheses -- they are added by the builder). */
  regex: string;
  /** Symbolic capture name used during timestamp assembly. */
  capture: CaptureName;
  /**
   * The directive rendered for a Date, in local time: what `regex` reads back.
   * Kept beside the regex so parsing and formatting cannot drift apart.
   * See docs/adr/0003-one-strftime-directive-table.md.
   */
  format: (date: Date) => string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const spacePad = (n: number) => String(n).padStart(2, ' ');
const hour12 = (date: Date) => (date.getHours() % 12 === 0 ? 12 : date.getHours() % 12);

/**
 * The first `width` digits of the fractional second. A Date holds milliseconds,
 * so the digits past the third are always zero.
 */
const fraction = (width: number) => (date: Date) => pad(date.getMilliseconds(), 3).padEnd(width, '0').slice(0, width);

function buildDirectiveMap(): Record<string, DirectiveMeta> {
  return {
    '%Y': { regex: '(\\d{4})', capture: 'year4', format: (d) => String(d.getFullYear()) },
    '%y': { regex: '(\\d{2})', capture: 'year2', format: (d) => pad(d.getFullYear() % 100) },
    // POSIX/glibc strptime (which Splunk uses) accepts 1-2 digits for these
    // numeric fields, so unpadded values like `1/5/2024 3:04:05` still parse.
    '%m': { regex: '(\\d{1,2})', capture: 'month', format: (d) => pad(d.getMonth() + 1) },
    '%d': { regex: '(\\d{1,2})', capture: 'day', format: (d) => pad(d.getDate()) },
    '%e': { regex: '(\\s?\\d{1,2})', capture: 'day', format: (d) => spacePad(d.getDate()) },
    '%H': { regex: '(\\d{1,2})', capture: 'hour24', format: (d) => pad(d.getHours()) },
    '%I': { regex: '(\\d{1,2})', capture: 'hour12', format: (d) => pad(hour12(d)) },
    '%M': { regex: '(\\d{1,2})', capture: 'minute', format: (d) => pad(d.getMinutes()) },
    '%S': { regex: '(\\d{1,2})', capture: 'second', format: (d) => pad(d.getSeconds()) },
    '%p': { regex: '([AaPp][Mm])', capture: 'ampm', format: (d) => (d.getHours() < 12 ? 'AM' : 'PM') },
    // POSIX strptime treats %b/%B (and %a/%A) as synonyms: each accepts the
    // full or the abbreviated name, so `%b` reads `September` and `%B` reads
    // `Sep`. Full names are listed first so the longer spelling is consumed.
    // getMonth() is 0-11 and getDay() 0-6 for any valid Date, and
    // formatStrftime rejects an invalid one up front, so `nameAt` always finds one.
    '%b': { regex: MONTH_NAME_REGEX, capture: 'monthName', format: (d) => nameAt(MONTH_NAMES_ABBR, d.getMonth()) },
    '%B': { regex: MONTH_NAME_REGEX, capture: 'monthName', format: (d) => nameAt(MONTH_NAMES_FULL, d.getMonth()) },
    '%a': { regex: WEEKDAY_NAME_REGEX, capture: 'weekdayName', format: (d) => nameAt(WEEKDAY_NAMES_ABBR, d.getDay()) },
    '%A': { regex: WEEKDAY_NAME_REGEX, capture: 'weekdayName', format: (d) => nameAt(WEEKDAY_NAMES_FULL, d.getDay()) },
    // A trailing `:MM` belongs to a GMT-relative name (`GMT+05:30`); a colon
    // alone does not, so `PST: msg` still reads PST.
    '%Z': { regex: '([A-Za-z][A-Za-z0-9_/+-]*(?::\\d{2})?)', capture: 'tzName', format: timeZoneAbbreviation },
    // ISO-8601 'Z' (Zulu/UTC), ±HH:MM / ±HHMM, and ±HH-only offsets.
    '%z': { regex: '(Z|[+-]\\d{2}:?\\d{2}|[+-]\\d{2})', capture: 'tzOffset', format: (d) => formatUtcOffset(d, '') },
    // Splunk "enhanced strptime" offsets with explicit colons.
    '%:z': { regex: '(Z|[+-]\\d{2}:\\d{2})', capture: 'tzOffset', format: (d) => formatUtcOffset(d, ':') },
    // getTimezoneOffset() is in whole minutes, so the seconds are always zero.
    '%::z': {
      regex: '(Z|[+-]\\d{2}:\\d{2}:\\d{2})',
      capture: 'tzOffset',
      format: (d) => `${formatUtcOffset(d, ':')}:00`,
    },
    '%s': { regex: '(\\d{10,13})', capture: 'epoch', format: (d) => String(Math.floor(d.getTime() / 1000)) },
    '%3N': { regex: '(\\d{3})', capture: 'milliseconds', format: fraction(3) },
    '%6N': { regex: '(\\d{6})', capture: 'microseconds', format: fraction(6) },
    '%9N': { regex: '(\\d{9})', capture: 'nanoseconds', format: fraction(9) },
    // The width is Splunk's digit count, so the other widths read the same
    // way: automatic recognition needs them for fractions such as .NET's
    // seven-digit ticks, whose zone would otherwise be lost.
    ...Object.fromEntries(
      [1, 2, 4, 5, 7, 8].map((w) => [`%${w}N`, { regex: `(\\d{${w}})`, capture: 'subseconds', format: fraction(w) }]),
    ),
    // Bare %N is Splunk shorthand for %9N (nanoseconds).
    '%N': { regex: '(\\d{9})', capture: 'nanoseconds', format: fraction(9) },
    // %Q family: subsecond digits, bare %Q == %3Q (milliseconds).
    '%Q': { regex: '(\\d{3})', capture: 'milliseconds', format: fraction(3) },
    '%3Q': { regex: '(\\d{3})', capture: 'milliseconds', format: fraction(3) },
    '%6Q': { regex: '(\\d{6})', capture: 'microseconds', format: fraction(6) },
    '%9Q': { regex: '(\\d{9})', capture: 'nanoseconds', format: fraction(9) },
    // Additional specifiers
    '%f': { regex: '(\\d{1,6})', capture: 'microsecondsFull', format: fraction(6) },
    '%j': { regex: '(\\d{3})', capture: 'dayOfYear', format: (d) => pad(dayOfYear(d), 3) },
    // Space-padded 24h and 12h, sharing %H's and %I's captures.
    '%k': { regex: '(\\s?\\d{1,2})', capture: 'hour24', format: (d) => spacePad(d.getHours()) },
    '%l': { regex: '(\\s?\\d{1,2})', capture: 'hour12', format: (d) => spacePad(hour12(d)) },
    // %% and the composites %T and %F are handled before the table is consulted.
  };
}

const DIRECTIVE_MAP = buildDirectiveMap();

// ---------------------------------------------------------------------------
// Expand composite directives so the main loop only deals with atomic ones.
// ---------------------------------------------------------------------------
function expandComposites(format: string): string {
  // Walk the string so a `%%` escape consumes both percent signs before we
  // look for a composite: `%%T` must stay a literal `%T`, not expand the inner
  // `%T` into `%%H:%M:%S`.
  let result = '';
  let i = 0;
  while (i < format.length) {
    if (format[i] === '%') {
      const two = format.slice(i, i + 2);
      if (two === '%%') {
        result += '%%';
        i += 2;
        continue;
      }
      if (two === '%T') {
        result += '%H:%M:%S';
        i += 2;
        continue;
      }
      if (two === '%F') {
        result += '%Y-%m-%d';
        i += 2;
        continue;
      }
      result += format.charAt(i);
      i += 1;
      continue;
    }
    result += format.charAt(i);
    i += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal: tokenise a strftime format string into an ordered list of
// { directive, capture } pairs plus build the combined regex.
// ---------------------------------------------------------------------------

interface TokenisedFormat {
  regex: RegExp;
  captures: CaptureName[];
}

/**
 * A string-keyed cache of at most `limit` entries, least recently used evicted
 * first. See docs/adr/0004-bounded-time-format-cache.md.
 */
class BoundedLru<V> {
  private readonly map = new Map<string, V>();
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get size(): number {
    return this.map.size;
  }

  /** The cached value, or `compute(key)` cached. */
  getOrCompute(key: string, compute: (key: string) => V): V {
    if (this.map.has(key)) {
      const hit = this.map.get(key) as V;
      // Re-inserted so the Map's order is least-recently-used first.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    const value = compute(key);
    if (this.map.size >= this.limit) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
    this.map.set(key, value);
    return value;
  }
}

/**
 * Tokenised formats, keyed on the format string. Auto-recognition parses each
 * candidate format once per event, so the same few formats recur constantly.
 * Bounded, so formats typed in the editor or sent by an MCP client do not
 * accumulate.
 */
const TOKENISE_CACHE_LIMIT = 256;
const tokeniseCache = new BoundedLru<TokenisedFormat>(TOKENISE_CACHE_LIMIT);

function tokenise(format: string): TokenisedFormat {
  return tokeniseCache.getOrCompute(format, tokeniseUncached);
}

/** How many tokenised formats the cache holds; for the cache-bound test. */
export function cachedFormatCount(): number {
  return tokeniseCache.size;
}

/**
 * The table directive starting at `format[i]`, trying the longest first so
 * `%::z` wins over `%:z` and `%3N`/`%3Q` over a bare `%`. Parsing, formatting
 * and the linter all walk a format with this, so they agree on its tokens.
 */
function directiveAt(format: string, i: number): { spec: string; meta: DirectiveMeta } | null {
  for (const length of [4, 3, 2]) {
    const spec = format.slice(i, i + length);
    const meta = DIRECTIVE_MAP[spec];
    if (meta) return { spec, meta };
  }
  return null;
}

function tokeniseUncached(format: string): TokenisedFormat {
  const expanded = expandComposites(format);
  const captures: CaptureName[] = [];
  let regexStr = '';
  let i = 0;

  while (i < expanded.length) {
    if (expanded[i] === '%') {
      const directive = directiveAt(expanded, i);
      if (directive) {
        regexStr += directive.meta.regex;
        captures.push(directive.meta.capture);
        i += directive.spec.length;
        continue;
      }

      // %% = literal percent sign (no capture group)
      if (expanded.slice(i, i + 2) === '%%') {
        regexStr += '%';
        i += 2;
        continue;
      }

      // Unknown directive -- treat the percent as literal
      regexStr += escapeRegex(expanded.charAt(i));
      i += 1;
    } else {
      // Literal character -- allow flexible whitespace matching when the
      // format contains a space (Splunk is lenient).
      if (expanded.charAt(i) === ' ') {
        regexStr += '\\s+';
      } else {
        regexStr += escapeRegex(expanded.charAt(i));
      }
      i += 1;
    }
  }

  return { regex: new RegExp(regexStr, 'i'), captures };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert a strftime format string to a regular expression that will match
 * timestamps produced by that format.
 *
 * The returned regex is **not** anchored so it can be used with
 * `String.prototype.match` to find timestamps embedded in larger strings.
 */
export function strftimeToRegex(format: string): RegExp {
  return tokenise(format).regex;
}

/**
 * Well-known timezone offsets (in minutes from UTC).
 *
 * Only a small subset is included; extend as needed.
 */
const TZ_OFFSETS: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  IST: 330,
  CET: 60,
  CEST: 120,
  JST: 540,
  AEST: 600,
  AEDT: 660,
  NZST: 720,
  NZDT: 780,
};

/**
 * tzdata zone names that read like abbreviations. As a stanza's `TZ` (a zoneinfo
 * name) they are zones, and CET, EET, WET and MET observe DST; only as an
 * event's `%Z` is CET the fixed standard-time abbreviation of the table above.
 * Kept to names tzdata itself defines: ICU also accepts legacy aliases such as
 * `PST`, which zoneinfo has no zone for.
 */
const TZDATA_ABBREVIATION_ZONES: ReadonlySet<string> = new Set([
  'CET',
  'EET',
  'WET',
  'MET',
  'EST',
  'MST',
  'HST',
  'UTC',
  'GMT',
]);

/** The zone abbreviations `%Z` resolves without TZ_ALIAS, for recognition to look for. */
export const KNOWN_ZONE_ABBREVIATIONS: readonly string[] = Object.keys(TZ_OFFSETS);

/**
 * Formatters for IANA zone names, cached because constructing one is expensive
 * and a batch of events shares a single `TZ`. A name the runtime rejects caches
 * as `null` so it is not retried per event. Bounded, because the names come
 * from the data too (`%Z` captures, TZ_ALIAS targets).
 */
const ZONE_CACHE_LIMIT = 64;
const ianaFormatters = new BoundedLru<Intl.DateTimeFormat | null>(ZONE_CACHE_LIMIT);

/** How many zone names the formatter cache holds; for the cache-bound test. */
export function cachedZoneCount(): number {
  return ianaFormatters.size;
}

function ianaFormatter(tz: string): Intl.DateTimeFormat | null {
  return ianaFormatters.getOrCompute(tz, buildIanaFormatter);
}

function buildIanaFormatter(tz: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour12: false,
      era: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    // RangeError for a name this runtime does not know.
    return null;
  }
}

/**
 * `Date.UTC`, without its mapping of years 0-99 onto 1900-1999: `%Y` reading
 * `0050` means the year 50.
 */
function utcMs(year: number, month: number, day: number, hour: number, minute: number, second: number, ms = 0): number {
  const d = new Date(Date.UTC(2000, month, day, hour, minute, second, ms));
  d.setUTCFullYear(year, month, day);
  return d.getTime();
}

/**
 * The offset, in minutes east of UTC, that a zone was actually at a given
 * instant — which is the whole reason a zone name cannot be reduced to a fixed
 * number. Read by formatting the instant *into* the zone and asking how far the
 * resulting wall clock is from the UTC one.
 */
function ianaOffsetAt(formatter: Intl.DateTimeFormat, atMs: number): number {
  // The wall clock is read to the second, so the instant is compared at one.
  const wholeSecond = Math.floor(atMs / 1000) * 1000;
  const parts = formatter.formatToParts(new Date(wholeSecond));
  const num = (type: string) => Number(parts.find((p) => p.type === type)?.value);

  let year = num('year');
  // `era` is requested so a BC year is not silently read as AD — Splunk data
  // will never contain one, but a wrong answer is worse than a rejected one.
  if (parts.find((p) => p.type === 'era')?.value.startsWith('B')) year = 1 - year;

  // Some ICU versions render midnight as hour 24 under hour12: false.
  const hour = num('hour') === 24 ? 0 : num('hour');

  const asUtc = utcMs(year, num('month') - 1, num('day'), hour, num('minute'), num('second'));
  return (asUtc - wholeSecond) / 60_000;
}

/**
 * Turn a wall-clock reading in a named zone into an epoch instant.
 *
 * `wallAsUtcMs` is the timestamp's components assembled as though they were
 * UTC. The zone's offsets a day either side bracket any transition near that
 * wall clock (no offset exceeds 14 hours), and each is a candidate: it holds
 * when the zone really is at that offset at the instant it gives.
 *
 * A wall clock inside a spring-forward gap does not exist, and one inside a
 * fall-back overlap happens twice; this resolves the former forward, by the
 * offset before the gap (02:30 in New York's gap is 03:30 EDT), and the latter
 * to the first occurrence, which is what most strptime implementations do and
 * what a user comparing against a real indexer will usually see. Both depend
 * only on the offsets, not on which side of UTC the zone is.
 * See docs/adr/0006-time-zone-resolution.md.
 */
function ianaWallClockToEpoch(formatter: Intl.DateTimeFormat, wallAsUtcMs: number): number {
  const before = ianaOffsetAt(formatter, wallAsUtcMs - 86_400_000);
  const after = ianaOffsetAt(formatter, wallAsUtcMs + 86_400_000);
  const instantAt = (offset: number) => wallAsUtcMs - Math.round(offset * 60_000);
  // The larger offset gives the earlier instant, so it is tried first.
  for (const offset of before >= after ? [before, after] : [after, before]) {
    if (ianaOffsetAt(formatter, instantAt(offset)) === offset) return instantAt(offset);
  }
  return instantAt(before);
}

/**
 * Resolve a timezone specification to an offset in minutes from UTC.
 *
 * Accepts:
 *  - Named abbreviations recognised by the internal table (e.g. "PST").
 *  - Numeric offsets in the form "+HHMM" or "-HHMM" (with optional colon).
 *
 * Returns `null` when the value cannot be resolved. An IANA name such as
 * "Europe/London" resolves through `ianaWallClockToEpoch` instead, because its
 * offset depends on the instant and so cannot be answered here.
 */
function resolveTzOffsetMinutes(tz: string): number | null {
  const upper = tz.toUpperCase();
  // ISO-8601 "Z" (Zulu) designates UTC.
  if (upper === 'Z') return 0;
  const known = TZ_OFFSETS[upper];
  if (known !== undefined) {
    return known;
  }

  // GMT-relative form, as props.conf.spec writes TZ_ALIAS targets
  // (`EST=GMT-5:00`). The hour may be one digit here, unlike the %z branch
  // below. The sign is plain arithmetic, not POSIX's inverted one, so `GMT-5`
  // is UTC-5. See docs/adr/0006-time-zone-resolution.md.
  const gmtRelative = /^(?:GMT|UTC)([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(upper);
  if (gmtRelative) {
    const sign = gmtRelative[1] === '+' ? 1 : -1;
    return sign * (parseInt(gmtRelative[2] ?? '0', 10) * 60 + (gmtRelative[3] ? parseInt(gmtRelative[3], 10) : 0));
  }

  // Try parsing as +HHMM / -HH:MM / +HH:MM:SS / +HH (minutes and seconds
  // optional, colons optional) — covers %z, %:z and %::z outputs.
  const m = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?$/.exec(tz);
  if (m) {
    const sign = m[1] === '+' ? 1 : -1;
    const minutes =
      parseInt(m[2] ?? '0', 10) * 60 + (m[3] ? parseInt(m[3], 10) : 0) + (m[4] ? parseInt(m[4], 10) / 60 : 0);
    return sign * minutes;
  }

  return null;
}

/**
 * Convert captured subsecond digits into whole milliseconds.
 *
 * Handles %3N/%6N/%9N and the %Q family (which share the milliseconds/
 * microseconds/nanoseconds captures), the other %<n>N widths, and %f.
 * Returns 0 when none are present.
 */
function computeSubMilliseconds(bag: CaptureBag): number {
  if (bag.milliseconds) {
    return parseInt(bag.milliseconds, 10);
  }
  if (bag.subseconds) {
    // A decimal fraction of any width: its first three digits are the ms.
    return parseInt(bag.subseconds.padEnd(3, '0').slice(0, 3), 10);
  }
  if (bag.microseconds) {
    return Math.floor(parseInt(bag.microseconds, 10) / 1000);
  }
  if (bag.microsecondsFull) {
    // %f: 1-6 digit microseconds — pad to 6 digits then convert to ms.
    const padded = bag.microsecondsFull.padEnd(6, '0');
    return Math.floor(parseInt(padded, 10) / 1000);
  }
  if (bag.nanoseconds) {
    return Math.floor(parseInt(bag.nanoseconds, 10) / 1_000_000);
  }
  return 0;
}

/**
 * Parse a `TZ_ALIAS` value into the remapping table `parseTimestamp` consumes.
 *
 * The value is a comma-separated list of `<abbreviation>=<timezone>` pairs, per
 * props.conf.spec: `TZ_ALIAS = EST=GMT-5:00,METT=GMT+1:00`. Keys are upper-cased
 * because the zone written in an event is not reliably cased, and the target is
 * kept verbatim so it can be anything `resolveTzOffsetMinutes` or the IANA
 * formatter accepts — an offset, another abbreviation, or `America/New_York`.
 *
 * A pair that is not in that form is returned in `invalid` rather than dropped,
 * so the caller can say so. A pair whose *target* does not resolve is not
 * reported here: that failure already has a mechanism in the unresolved-zone
 * warning, and two diagnostics for one mistake is worse than one.
 */
export function parseTzAlias(value: string): {
  aliases: ReadonlyMap<string, string>;
  invalid: readonly string[];
} {
  const aliases = new Map<string, string>();
  const invalid: string[] = [];

  for (const pair of value.split(',')) {
    const text = pair.trim();
    if (!text) continue;
    // Split on the first `=` only: the target may itself contain one in
    // principle, and the abbreviation never does.
    const eq = text.indexOf('=');
    const from = eq === -1 ? '' : text.slice(0, eq).trim();
    const to = eq === -1 ? '' : text.slice(eq + 1).trim();
    if (!from || !to) {
      invalid.push(text);
      continue;
    }
    aliases.set(from.toUpperCase(), to);
  }

  return { aliases, invalid };
}

/**
 * Parse a timestamp string using a Splunk strftime format.
 *
 * @param text   - The raw text (or substring) to search for the timestamp.
 * @param format - A strftime format string (e.g. `%Y-%m-%dT%H:%M:%S.%3N`).
 * @param tz     - Optional fallback timezone name or offset used when the
 *                 format itself does not contain %Z / %z.  Defaults to UTC.
 * @param onUnresolvedTz - Called with the offending value when a named zone
 *                 (%Z or the `tz` fallback) can't be resolved and is treated as
 *                 UTC, so callers can surface a diagnostic instead of silent drift.
 * @param tzAlias - `TZ_ALIAS` remapping table from {@link parseTzAlias}, applied
 *                 to a zone read out of the event (%Z) before it is resolved.
 * @param now    - The current moment, which supplies the year for a format
 *                 that has none (syslog's `%b %e %H:%M:%S`): its UTC year, or
 *                 the one before when that would put the stamp in the future.
 *                 Injectable so a yearless timestamp parses the same way next
 *                 year as today.
 * @returns A `Date` object if parsing succeeded, or `null` otherwise.
 */
export function parseTimestamp(
  text: string,
  format: string,
  tz?: string,
  onUnresolvedTz?: (tz: string) => void,
  tzAlias?: ReadonlyMap<string, string>,
  now: Date = new Date(),
): Date | null {
  return parseTimestampDetailed(text, format, { tz, onUnresolvedTz, tzAlias, now })?.date ?? null;
}

/** A calendar date, month 0-indexed as `Date` has it. */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/**
 * What {@link parseTimestampDetailed} read, beyond the instant.
 *
 * The index-time `date_*` fields describe the timestamp as it was written -- the
 * wall clock in the event's own zone -- which cannot be recovered from a `Date`
 * once the zone has been folded into it. And a dateless timestamp needs its
 * date supplied from elsewhere, which the caller can only do if it is told the
 * date was missing rather than handed a silent 1 January.
 */
export interface ParsedTimestamp {
  date: Date;
  /** The components as written, expressed as a UTC epoch (`Date.UTC(...)`). */
  wallAsUtcMs: number;
  /**
   * Minutes east of UTC the wall clock was read in, or null when no zone was
   * known (neither in the event nor from `tz`) and it was read as UTC.
   */
  offsetMinutes: number | null;
  /** False when the format carried no date component at all, only a time. */
  hasDate: boolean;
}

export interface ParseTimestampOptions {
  tz?: string;
  onUnresolvedTz?: (tz: string) => void;
  tzAlias?: ReadonlyMap<string, string>;
  now?: Date;
  /**
   * The date to use when the format has none (see `hasDate`). Without it such a
   * timestamp lands on 1 January of `now`'s year.
   */
  dateForDateless?: CalendarDate;
}

/**
 * {@link parseTimestamp}, returning the wall clock and zone it read as well as
 * the instant. `parseTimestamp` is this with everything but `date` discarded.
 */
export function parseTimestampDetailed(
  text: string,
  format: string,
  options: ParseTimestampOptions = {},
): ParsedTimestamp | null {
  const { now = new Date() } = options;
  // The UTC year, not the host's: `now` is injected so a run is reproducible,
  // and the local year differs from it around New Year in every zone but UTC.
  const thisYear = now.getUTCFullYear();
  const { captures } = tokenise(format);
  const yearless = !captures.some((c) => YEAR_CAPTURES.has(c)) && captures.some((c) => DATE_CAPTURES.has(c));
  const current = assembleTimestamp(text, format, options, thisYear);
  if (!yearless) return current;

  // A date written without a year is the most recent one it can be (the syslog
  // convention). A stamp slightly ahead of the clock
  // (skew) stays in this year. See
  // docs/adr/0005-yearless-timestamps-take-the-most-recent-year.md.
  const latest = now.getTime() + YEARLESS_FUTURE_TOLERANCE_MS;
  const fits = (p: ParsedTimestamp | null): p is ParsedTimestamp => p !== null && p.date.getTime() <= latest;
  if (fits(current)) {
    // A zone east of UTC is already in next year's 1 January while UTC is
    // still in this year's 31 December: the stamp's own year is then ahead.
    if (now.getTime() - current.date.getTime() < YEARLESS_NEXT_YEAR_CHECK_MS) return current;
    const next = assembleTimestamp(text, format, options, thisYear + 1);
    return fits(next) ? next : current;
  }
  // Earlier years, as far back as a 29 February can be (2096 before 2104).
  for (let year = thisYear - 1; year >= thisYear - 8; year--) {
    const earlier = assembleTimestamp(text, format, options, year);
    if (fits(earlier)) return earlier;
  }
  return null;
}

/**
 * A yearless stamp read this far or more behind `now` might be next year's in
 * its own zone: UTC offsets reach 14 hours, so next year starts at most that
 * long before UTC's, and a stamp read a year back from there is ~364 days old.
 */
const YEARLESS_NEXT_YEAR_CHECK_MS = 360 * 86_400_000;

/** Captures that name a year, or an instant outright. */
const YEAR_CAPTURES: ReadonlySet<string> = new Set(['year4', 'year2', 'epoch']);
/** Captures that place a timestamp on a calendar day, year aside. */
const DATE_CAPTURES: ReadonlySet<string> = new Set(['month', 'monthName', 'day', 'dayOfYear']);

/**
 * How far into the future a yearless timestamp may fall and still be read in
 * the current year: the MAX_DAYS_HENCE default, beyond which the extractor
 * would reject it as too far ahead anyway.
 */
const YEARLESS_FUTURE_TOLERANCE_MS = 2 * 86_400_000;

/**
 * The components a format captured from `text`, by capture name, or null
 * when the format does not match.
 */
function captureBag(text: string, format: string): CaptureBag | null {
  const { regex, captures } = tokenise(format);
  const match = text.match(regex);
  if (!match) {
    return null;
  }
  const bag: CaptureBag = {};
  for (const [i, captureName] of captures.entries()) {
    const value = match[i + 1];
    if (value !== undefined) {
      bag[captureName] = value.trim();
    }
  }
  return bag;
}

function isLeap(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthLengths(year: number): number[] {
  return [31, isLeap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
}

function resolveYear(bag: CaptureBag, supplied: CalendarDate | undefined, yearForYearless: number): number {
  if (supplied) return supplied.year;
  if (bag.year4) return parseInt(bag.year4, 10);
  if (bag.year2) {
    const y2 = parseInt(bag.year2, 10);
    // POSIX %y pivot: 69-99 → 1969-1999, 00-68 → 2000-2068.
    return y2 >= 69 ? 1900 + y2 : 2000 + y2;
  }
  // No year in the format: the caller decides which (see parseTimestampDetailed).
  return yearForYearless;
}

/** The 0-indexed month. */
function resolveMonth(bag: CaptureBag, supplied: CalendarDate | undefined): number {
  if (supplied) return supplied.month;
  if (bag.month) return parseInt(bag.month, 10) - 1;
  if (bag.monthName) {
    // Full or abbreviated: every full name starts with its abbreviation.
    const abbr = bag.monthName.slice(0, 3).toLowerCase();
    const month = MONTH_NAMES_ABBR.findIndex((m) => m.toLowerCase() === abbr);
    return month === -1 ? 0 : month;
  }
  return 0;
}

/** The month (0-indexed) and day of the month. */
function resolveMonthDay(
  bag: CaptureBag,
  year: number,
  supplied: CalendarDate | undefined,
): { month: number; day: number } {
  // %j: day-of-year (001-366) — convert to month+day when no month/day present
  if (bag.dayOfYear && !bag.day && !bag.month) {
    const maxDoy = isLeap(year) ? 366 : 365;
    const doy = Math.max(1, Math.min(parseInt(bag.dayOfYear, 10), maxDoy));
    let rem = doy;
    let m = 0;
    for (const monthLength of monthLengths(year)) {
      if (rem <= monthLength) break;
      rem -= monthLength;
      m++;
    }
    return { month: m, day: rem };
  }
  return {
    month: resolveMonth(bag, supplied),
    day: supplied ? supplied.day : bag.day ? parseInt(bag.day, 10) : 1,
  };
}

function resolveHour(bag: CaptureBag): number {
  if (bag.hour24) return parseInt(bag.hour24, 10);
  if (!bag.hour12) return 0;
  const hour = parseInt(bag.hour12, 10);
  const isPM = bag.ampm && /pm/i.test(bag.ampm);
  const isAM = bag.ampm && /am/i.test(bag.ampm);
  if (isPM && hour !== 12) return hour + 12;
  if (isAM && hour === 12) return 0;
  return hour;
}

/**
 * Reject out-of-range components rather than letting Date.UTC silently roll
 * over (e.g. %m=13 → the next January, %d=32 → the next month, %H=25 → the
 * next day). Splunk treats an out-of-range field as a parse failure.
 */
function componentsInRange(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
): boolean {
  return !(
    month < 0 ||
    month > 11 ||
    day < 1 ||
    day > (monthLengths(year)[month] ?? 0) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 60 // allow a leap second
  );
}

/**
 * Place a wall-clock reading in its zone.
 *
 * The components read as though they were UTC; `wallAsUtcMs` is that reading.
 * Every branch below is a question about how far the real instant is from it.
 */
function resolveZone(
  bag: CaptureBag,
  wallAsUtcMs: number,
  hasDate: boolean,
  options: ParseTimestampOptions,
): ParsedTimestamp {
  const { tz, onUnresolvedTz, tzAlias } = options;
  // A zone written in the event (%Z) beats the stanza's TZ, and an explicit
  // numeric offset (%z) beats both — it needs no resolution at all.
  // TZ_ALIAS rewrites only the zone read out of the event, never the stanza's
  // TZ. See docs/adr/0006-time-zone-resolution.md.
  const aliased = bag.tzName === undefined ? undefined : tzAlias?.get(bag.tzName.toUpperCase());
  const zoneName = aliased ?? bag.tzName ?? tz;

  const zoned = (offsetMinutes: number): ParsedTimestamp => ({
    date: new Date(wallAsUtcMs - offsetMinutes * 60_000),
    wallAsUtcMs,
    offsetMinutes,
    hasDate,
  });

  if (bag.tzOffset) {
    // %z only ever matches Z or a numeric offset, so this always resolves.
    return zoned(resolveTzOffsetMinutes(bag.tzOffset) ?? 0);
  }

  if (zoneName) {
    // An IANA name's offset depends on the date -- which is exactly why the
    // abbreviation table cannot answer it. Take the instant as resolved rather
    // than rebuilding it from a rounded offset: a historical zone can sit a few
    // seconds off a whole minute.
    const inZone = (formatter: Intl.DateTimeFormat): ParsedTimestamp => {
      const epoch = ianaWallClockToEpoch(formatter, wallAsUtcMs);
      return { date: new Date(epoch), wallAsUtcMs, offsetMinutes: Math.round((wallAsUtcMs - epoch) / 60_000), hasDate };
    };

    // The stanza's TZ is a zoneinfo name first: `TZ = CET` is the zone, with
    // its summer time, not the abbreviation.
    const stanzaZone =
      bag.tzName === undefined && TZDATA_ABBREVIATION_ZONES.has(zoneName.toUpperCase())
        ? ianaFormatter(zoneName)
        : null;
    if (stanzaZone) return inZone(stanzaZone);

    // A fixed offset or a known abbreviation is a constant, so answer directly.
    const fixed = resolveTzOffsetMinutes(zoneName);
    if (fixed !== null) return zoned(fixed);

    const formatter = ianaFormatter(zoneName);
    if (formatter) return inZone(formatter);

    // Genuinely unresolvable: a typo, or a zone this runtime has no data for.
    // When an alias was applied, name both halves: the abbreviation the event
    // carried and the target that failed.
    onUnresolvedTz?.(aliased === undefined ? zoneName : `${bag.tzName} (TZ_ALIAS → ${aliased})`);
  }

  // No timezone info at all -- assume UTC.
  return { date: new Date(wallAsUtcMs), wallAsUtcMs, offsetMinutes: null, hasDate };
}

/**
 * The body of {@link parseTimestampDetailed}, with the year a yearless format
 * takes passed in.
 */
function assembleTimestamp(
  text: string,
  format: string,
  options: ParseTimestampOptions,
  yearForYearless: number,
): ParsedTimestamp | null {
  const bag = captureBag(text, format);
  if (!bag) {
    return null;
  }

  // Subsecond digits captured by %3N/%6N/%9N, the %Q family, or %f, converted
  // to whole milliseconds. Shared by the epoch and calendar paths.
  const subMilliseconds = computeSubMilliseconds(bag);

  if (bag.epoch) {
    const epochNum = parseInt(bag.epoch, 10);
    // If the value is 13 digits it is already milliseconds; a captured
    // subsecond field would be below ms resolution, so leave it as-is.
    // Seconds since epoch: fold in any subseconds from e.g. `%s%3N`/`%s%3Q`.
    const ms = bag.epoch.length >= 13 ? epochNum : epochNum * 1000 + subMilliseconds;
    // An epoch is an absolute instant, so its wall clock is UTC by definition.
    return { date: new Date(ms), wallAsUtcMs: ms, offsetMinutes: 0, hasDate: true };
  }

  // A weekday alone (%a) does not name a date, so it does not count.
  const hasDate = [bag.year4, bag.year2, bag.month, bag.monthName, bag.day, bag.dayOfYear].some((v) => v !== undefined);
  const suppliedDate = hasDate ? undefined : options.dateForDateless;

  const year = resolveYear(bag, suppliedDate, yearForYearless);
  const { month, day } = resolveMonthDay(bag, year, suppliedDate);
  const hour = resolveHour(bag);
  const minute = bag.minute ? parseInt(bag.minute, 10) : 0;
  const second = bag.second ? parseInt(bag.second, 10) : 0;
  if (!componentsInRange(year, month, day, hour, minute, second)) {
    return null;
  }

  const wallAsUtcMs = utcMs(year, month, day, hour, minute, second, subMilliseconds);
  return resolveZone(bag, wallAsUtcMs, hasDate, options);
}

// ---------------------------------------------------------------------------
// Formatting (the inverse of the parsing above), shared by eval strftime() and
// the editor's TIME_FORMAT preview. See docs/adr/0003-one-strftime-directive-table.md.
// ---------------------------------------------------------------------------
/**
 * Format a Date with a Splunk strftime string. Uses the browser's local timezone
 * (a documented browser-tool divergence — real Splunk uses the configured/indexer
 * TZ). Renders every specifier the parser reads, from the same table; anything
 * else is left as literal text, which unsupportedSpecifiers flags.
 */
export function formatStrftime(date: Date, format: string): string {
  // An epoch outside the Date range yields an Invalid Date, whose accessors all
  // return NaN — %F would render "NaN-NaN-NaN", and the %b/%B/%a/%A name lookups
  // would index their table with NaN. Reject it deliberately, so the error names
  // the function that caused it — and so every accessor past this point is
  // known to be in its documented range.
  if (Number.isNaN(date.getTime())) {
    throw new Error('strftime(): timestamp is out of range');
  }

  const expanded = expandComposites(format);
  let out = '';
  let i = 0;
  while (i < expanded.length) {
    if (expanded[i] === '%') {
      const directive = directiveAt(expanded, i);
      if (directive) {
        out += directive.meta.format(date);
        i += directive.spec.length;
        continue;
      }
      if (expanded.slice(i, i + 2) === '%%') {
        out += '%';
        i += 2;
        continue;
      }
    }
    out += expanded.charAt(i);
    i += 1;
  }
  return out;
}

/**
 * `%j` — the local day of the year, 1-366. Counted between calendar dates
 * rather than local midnights, whose difference is not a whole number of days
 * when a DST change falls between them.
 */
function dayOfYear(date: Date): number {
  const year = date.getFullYear();
  const days = utcMs(year, date.getMonth(), date.getDate(), 0, 0, 0) - utcMs(year, 0, 1, 0, 0, 0);
  return days / 86_400_000 + 1;
}

/**
 * `%z` — the local UTC offset as `+hhmm` / `-hhmm`, or with `separator`
 * between the hours and minutes for `%:z`.
 */
function formatUtcOffset(date: Date, separator: string): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(abs / 60))}${separator}${pad(abs % 60)}`;
}

/** `%Z` — the local zone's short name, falling back to the numeric offset. */
function timeZoneAbbreviation(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? formatUtcOffset(date, '');
}

/**
 * strftime specifiers this simulator understands, derived from the parsing
 * table above rather than restated — a specifier added to one and forgotten in
 * the other would make the editor confidently flag a working format.
 */
export function supportedSpecifiers(): Set<string> {
  // Expanded before lookup rather than carried in the table, plus the escape.
  return new Set([...Object.keys(DIRECTIVE_MAP), '%T', '%F', '%%']);
}

/** A specifier in a TIME_FORMAT, where it sits, and whether this simulator implements it. */
export interface FormatSpecifier {
  specifier: string;
  index: number;
  supported: boolean;
}

/**
 * Every specifier in a TIME_FORMAT, in order, tokenised as parsing and
 * formatting read it: table directives longest first, and the composites %T
 * and %F and the %% escape whole. The Timestamp tab's breakdown reads a format
 * with this, so it names the same tokens the parser does.
 */
export function formatSpecifiers(format: string): FormatSpecifier[] {
  const found: FormatSpecifier[] = [];

  let i = 0;
  while (i < format.length) {
    if (format[i] !== '%') {
      i += 1;
      continue;
    }

    const directive = directiveAt(format, i);
    if (directive) {
      found.push({ specifier: directive.spec, index: i, supported: true });
      i += directive.spec.length;
      continue;
    }

    const two = format.slice(i, i + 2);
    if (two === '%%' || two === '%T' || two === '%F') {
      found.push({ specifier: two, index: i, supported: true });
      i += 2;
      continue;
    }
    if (two.length < 2) {
      found.push({ specifier: '%', index: i, supported: false });
      break;
    }
    // An unknown width, e.g. %0N, is reported whole rather than as `%0`.
    const specifier = /^%\dN/.exec(format.slice(i, i + 3))?.[0] ?? two;
    found.push({ specifier, index: i, supported: false });
    i += specifier.length;
  }

  return found;
}

/**
 * Specifiers in a TIME_FORMAT that this simulator does not implement, with the
 * offset each sits at. A `%` followed by nothing recognisable is reported too:
 * `%Y-%m-%d %H:%i` is a real mistake (`%i` is MySQL, not strftime) and silently
 * matching the literal `i` is how it survives to production.
 */
export function unsupportedSpecifiers(format: string): { specifier: string; index: number }[] {
  return formatSpecifiers(format)
    .filter((s) => !s.supported)
    .map(({ specifier, index }) => ({ specifier, index }));
}
