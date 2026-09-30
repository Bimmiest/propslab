/**
 * The one timestamp recogniser. Line breaking (BREAK_ONLY_BEFORE_DATE),
 * timestamp extraction and the scaffold all call it, so a line that starts an
 * event is a line whose `_time` is read from it, and a TIME_FORMAT the scaffold
 * suggests is the format extraction would have recognised.
 *
 * Two layers:
 *  - `recognizeTimestamp` is automatic recognition over a region of text: a
 *    table of strftime formats, searched positionally.
 *  - `createTimestampFinder` applies a stanza's TIME_PREFIX, TIME_FORMAT and
 *    MAX_TIMESTAMP_LOOKAHEAD around it, the way Splunk locates a timestamp.
 */

import type { ConfDirective } from '../types';
import { safeRegex } from '../../utils/splunkRegex';
import {
  KNOWN_ZONE_ABBREVIATIONS,
  parseTimestampDetailed,
  strftimeToRegex,
  type ParsedTimestamp,
  type ParseTimestampOptions,
} from '../../utils/strftime';
import { effectiveDirective } from '../utils/directiveValues';

// ---------------------------------------------------------------------------
// The format table
// ---------------------------------------------------------------------------

interface AutoFormat {
  /** The strftime format the stamp is parsed with, and the TIME_FORMAT that reads it. */
  format: string;
  regex: RegExp;
  /** A cheap test the region must pass before `regex` is worth running. */
  hint?: RegExp;
  /** The format reads a zone name, which must be written in capitals. */
  zoneName: boolean;
  /** What may not follow the match, because it would be part of the stamp. */
  notFollowedBy?: RegExp;
}

/**
 * Formats that share a cheap gate: a region the gate does not match cannot
 * match any of them, so the family is skipped. Line breaking runs this on every
 * line, and most lines of a multi-line event carry no timestamp at all.
 */
interface AutoFamily {
  gate: RegExp | null;
  formats: AutoFormat[];
}

/**
 * Zone names recognition reads with `%Z`: the abbreviations the parser knows,
 * and GMT/UTC with an offset (`GMT+05:30`). Only these, and only in capitals: a
 * bare `%Z` reads any word, so `10:00:00 Zookeeper` or French `est` would be a
 * zone.
 */
const ZONE_NAME = `(?:(?:GMT|UTC)[+-]\\d{1,2}(?::?\\d{2})?|${KNOWN_ZONE_ABBREVIATIONS.join('|')})`;
const ZONE_END = '(?![A-Za-z0-9+-])';
/** Case-sensitive, unlike the format regexes, which read month names in any case. */
const ZONE_IN_STAMP = new RegExp(`\\s${ZONE_NAME}${ZONE_END}`);
const ZONE_AFTER = new RegExp(`^\\s+${ZONE_NAME}${ZONE_END}`);
const AMPM_AFTER = /^\s*[AaPp][Mm](?![A-Za-z])/;
const ZONE_OR_AMPM_AFTER = new RegExp(`${ZONE_AFTER.source}|${AMPM_AFTER.source}`);

const HINT_COMMA_FRACTION = /\d,\d/;
const HINT_AMPM = /\d\s*[AaPp][Mm]/;
const HINT_ZONE_NAME = new RegExp(`\\s${ZONE_NAME}`);

/**
 * ISO-style date-times over every fraction width from 9 digits down to 1, `.`
 * or log4j's `,` before it, with the zone attached, after a space, or named;
 * with a space before the time, also on a 12-hour clock. A fixed `.%3N`
 * stopped at the third digit of `.123456+05:00` and left the zone unread.
 */
const FRACTION_WIDTHS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
function isoDateTimeFormats(separator: string): string[] {
  const base = `%Y-%m-%d${separator}%H:%M:%S`;
  const times = [...['.', ','].flatMap((mark) => FRACTION_WIDTHS.map((w) => `${base}${mark}%${w}N`)), base];
  const twelveHour = separator === ' ' ? times.map((t) => `${t.replace('%H', '%I')} %p`) : [];
  return [
    ...times.map((t) => `${t}%z`),
    ...times.map((t) => `${t} %z`),
    ...times.map((t) => `${t} %Z`),
    ...twelveHour.map((t) => `${t} %Z`),
    ...twelveHour,
    ...times,
  ];
}

/**
 * Formats recognised anywhere in the region, most specific first: where two
 * match at the same offset the earlier entry wins, so a stamp with a zone is
 * read with it and a date-time is not cut down to its date. A pragmatic subset
 * of Splunk's datetime.xml.
 *
 * The date-only forms are here because a line carrying one is a dated line
 * for BREAK_ONLY_BEFORE_DATE, and the date it carries is the one extraction
 * must then read -- not a line that breaks with nothing to place it.
 *
 * Month and weekday names match in any case, as datetime.xml's do: Oracle,
 * IBM and mainframe sources write `15-JAN-2026` and `JAN 15 10:00:00`. So a
 * name-led form must carry a year or a time to count. A bare month and day
 * (`%b %e`) is not in the table: case-insensitive, it reads prose such as
 * `you may 12` or `in March 3 times` as a date.
 */
const ISO_FORMATS = [...isoDateTimeFormats('T'), ...isoDateTimeFormats(' ')];
const OTHER_FORMATS = [
  '%a, %d %b %Y %H:%M:%S %z', // RFC 2822
  '%a %b %e %H:%M:%S %Z %Y', // date(1): ctime with the zone before the year
  '%a %b %e %H:%M:%S %Y', // ctime
  '%d/%b/%Y:%H:%M:%S %z', // Apache access log
  '%d/%b/%Y:%H:%M:%S',
  '%d %b %Y %I:%M:%S %p',
  '%d %b %Y %H:%M:%S',
  '%d-%b-%Y %H:%M:%S', // Oracle
  '%b %e %H:%M:%S', // syslog: no year, so the most recent one it can be
  '%Y/%m/%d %I:%M:%S %p',
  '%Y/%m/%d %H:%M:%S',
  '%m/%d/%Y %I:%M:%S %p %Z',
  '%m/%d/%Y %I:%M:%S %p',
  '%m/%d/%Y %H:%M:%S',
  '%Y-%m-%d',
  '%Y/%m/%d',
  '%m/%d/%Y',
  '%m-%d-%Y',
  '%m/%d/%y',
  '%m-%d-%y',
  '%d/%b/%Y',
  '%d-%b-%Y',
  '%d %b %Y',
];

/**
 * Epoch time. Only a plausible epoch counts -- ten digits of seconds from 2001
 * to 2033 or thirteen of milliseconds, optionally with a fraction, and not part
 * of a longer number -- so an 11- or 12-digit order id is not a timestamp.
 */
const EPOCH_FORMATS: { format: string; pattern: string }[] = [
  ...FRACTION_WIDTHS.map((w) => ({ format: `%s.%${w}N`, pattern: `1\\d{9}\\.\\d{${w}}` })),
  { format: '%s%3N', pattern: '1\\d{12}' },
  { format: '%s', pattern: '1\\d{9}' },
];

/**
 * An epoch starts the region or follows one of the delimiters datetime.xml
 * allows before its UTC epoch: whitespace, `#`, `,`, `"`, `=`, `(`, `[`, `|`
 * or `{`. So `time=1768471200` and `[1768471200]` are read, while a number
 * glued to other text (`id-1768471200`, `v1768471200`) is not.
 */
const EPOCH_BEFORE = '(?:^|(?<=[\\s#,"=(\\[|{]))';
const EPOCH_AFTER = '(?!\\d)(?!\\.\\d)';

const DATE_TOKENS = /%[Ymdey]$/;
const TIME_TOKENS = /%(?:S|\dN)$/;
/** strftime's own `%Z` pattern, which recognition narrows to {@link ZONE_NAME}. */
const ANY_ZONE_NAME = strftimeToRegex('%Z').source;

/**
 * Boundary guards around a format, from its first and last directive: a number
 * must not be part of a longer number (`120260922-01-15`, `3/4/2026/7`), a
 * name must stand as a word (`Market 5` is not `Mar 5`), and a trailing zone
 * must not run on into a word (`10:00:00 Zookeeper` is not UTC).
 */
function guarded(format: string): string {
  const body = strftimeToRegex(format).source.replace(ANY_ZONE_NAME, `(${ZONE_NAME})`);
  const startsWithName = /^%[aAbB]/.test(format);
  const before = startsWithName ? '(?<![A-Za-z])' : '(?<!\\d)(?<!\\d[/-])';
  const after = format.endsWith('%z')
    ? '(?![A-Za-z0-9])'
    : format.endsWith('%Z')
      ? ZONE_END
      : DATE_TOKENS.test(format)
        ? '(?!\\d)(?![/-]\\d)'
        : '(?!\\d)';
  return `${before}(?:${body})${after}`;
}

/**
 * A stamp ending in its time (or its AM/PM) must not be followed by the rest
 * of itself: `10:00:00 PM` read as 10:00, or `10:00:00 PST` as UTC, is a
 * confident wrong instant. When no fuller format reads it, nothing is read at
 * that offset rather than a truncation.
 */
function followGuard(format: string): RegExp | undefined {
  if (format.endsWith('%p')) return ZONE_AFTER;
  return TIME_TOKENS.test(format) ? ZONE_OR_AMPM_AFTER : undefined;
}

/** Hints for the rarer variants, so a plain ISO line does not run all of them. */
function hintFor(format: string): RegExp | undefined {
  if (format.includes('%Z')) return HINT_ZONE_NAME;
  if (format.includes('%p')) return HINT_AMPM;
  return format.includes(',%') ? HINT_COMMA_FRACTION : undefined;
}

/**
 * The table's patterns are JavaScript regexes, not PCRE2 ones, on purpose. They
 * are the engine's own, generated from strftime formats in a few fixed shapes
 * (like the stanza wildcards), not anything a user wrote, so there is no PCRE
 * meaning to be faithful to: they model datetime.xml, not a conf regex. They
 * are also built when this module loads, which in a worker is before the page
 * has handed it the PCRE2 module, and they run on every line of every event,
 * where V8's regex engine is the faster of the two.
 */
function family(gate: string | null, entries: { format: string; pattern: string }[]): AutoFamily {
  return {
    gate: gate === null ? null : new RegExp(gate),
    // Case-insensitive, like strftimeToRegex and datetime.xml.
    formats: entries.map(({ format, pattern }) => ({
      format,
      regex: new RegExp(pattern, 'i'),
      hint: hintFor(format),
      zoneName: format.includes('%Z'),
      notFollowedBy: followGuard(format),
    })),
  };
}

const anywhere = (format: string) => ({ format, pattern: guarded(format) });

// In priority order, family by family.
const AUTO_FAMILIES: AutoFamily[] = [
  family('\\d-\\d{1,2}-\\d{1,2}(?:T|\\s+)\\d{1,2}:\\d{1,2}:\\d', ISO_FORMATS.map(anywhere)),
  family(null, OTHER_FORMATS.map(anywhere)),
  family(
    '1\\d{9}',
    EPOCH_FORMATS.map(({ format, pattern }) => ({ format, pattern: `${EPOCH_BEFORE}${pattern}${EPOCH_AFTER}` })),
  ),
];

/** Every format automatic recognition reads, in priority order. */
export const AUTO_TIME_FORMATS: readonly string[] = AUTO_FAMILIES.flatMap((f) => f.formats.map((a) => a.format));

/** Whether a match is the whole stamp: its zone name in capitals, and none of it left unread. */
function wholeStamp(auto: AutoFormat, region: string, text: string, end: number): boolean {
  if (auto.zoneName && !ZONE_IN_STAMP.test(text)) return false;
  return !auto.notFollowedBy?.test(region.slice(end));
}

/** A timestamp found in a piece of text. Offsets are into that text, end exclusive. */
export interface RecognizedTimestamp {
  format: string;
  start: number;
  end: number;
  text: string;
  parsed: ParsedTimestamp;
}

/**
 * Automatic recognition over `region`. Recognition is positional: the earliest
 * timestamp wins, and a tie goes to the more specific format -- so a date deep
 * in the message does not beat the one at the front just by being more exact.
 * A format whose first match does not parse (`2026-13-45`), or would leave
 * part of the stamp unread (see `followGuard`), is passed over.
 */
export function recognizeTimestamp(region: string, options: ParseTimestampOptions = {}): RecognizedTimestamp | null {
  // Every format needs a digit; most lines of a stack trace have none.
  if (!/\d/.test(region)) return null;
  let best: RecognizedTimestamp | null = null;
  // A hint is shared by dozens of formats; test it once per region.
  const hints = new Map<RegExp, boolean>();
  const hinted = (hint: RegExp): boolean => {
    let passes = hints.get(hint);
    if (passes === undefined) {
      passes = hint.test(region);
      hints.set(hint, passes);
    }
    return passes;
  };
  for (const { gate, formats } of AUTO_FAMILIES) {
    if (gate !== null && !gate.test(region)) continue;
    for (const auto of formats) {
      const { format, regex, hint } = auto;
      if (hint && !hinted(hint)) continue;
      const m = regex.exec(region);
      if (!m) continue;
      const text = m[0];
      const start = m.index;
      // Strictly earlier: an equal offset keeps the more specific format.
      if (best !== null && start >= best.start) continue;
      if (!wholeStamp(auto, region, text, start + text.length)) continue;
      const parsed = parseTimestampDetailed(text, format, options);
      if (!parsed || isNaN(parsed.date.getTime())) continue;
      best = { format, start, end: start + text.length, text, parsed };
      // Nothing can start earlier than the region itself.
      if (start === 0) return best;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// TIME_PREFIX, TIME_FORMAT and the lookahead window
// ---------------------------------------------------------------------------

/**
 * MAX_TIMESTAMP_LOOKAHEAD as a character count. props.conf.spec: the default is
 * 128, and "a value of 0 or -1 disables the length constraint" -- `Infinity`,
 * which `Math.min` against the text length turns into "the rest of it".
 */
export function resolveLookahead(value: string | undefined): number {
  if (value === undefined) return 128;
  const parsed = parseInt(value.trim(), 10);
  if (parsed === 0 || parsed === -1) return Infinity;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 128;
}

/**
 * The regex a TIME_FORMAT is searched for with.
 *
 * With TIME_PREFIX set, props.conf.spec requires the format to start reading
 * immediately after the prefix, so the regex is anchored to the region start,
 * allowing only the leading whitespace strptime skips. Without one it scans the
 * lookahead window. An unanchored scan after a prefix would accept a mid-line
 * date and mask a broken TIME_PREFIX.
 */
export function timeFormatRegex(timeFormat: string, anchored: boolean): RegExp {
  const formatRegex = strftimeToRegex(timeFormat);
  return anchored ? new RegExp(`^\\s*(?:${formatRegex.source})`, formatRegex.flags) : formatRegex;
}

/** Where a TIME_FORMAT matched, and the text to parse. */
export interface TimeFormatMatch {
  /** The matched text, as handed to the parser; may carry leading whitespace. */
  text: string;
  /** Offset of the timestamp itself, after any leading whitespace. */
  start: number;
  /** End offset, exclusive. */
  end: number;
}

/** Search `raw[searchStart, searchEnd)` with a regex from `timeFormatRegex`. */
export function matchTimeFormat(
  raw: string,
  searchStart: number,
  searchEnd: number,
  formatRegex: RegExp,
): TimeFormatMatch | null {
  const formatMatch = formatRegex.exec(raw.substring(searchStart, searchEnd));
  if (!formatMatch) return null;
  const text = formatMatch[0];
  const matchStart = searchStart + formatMatch.index;
  return {
    text,
    start: matchStart + (text.length - text.trimStart().length),
    end: matchStart + text.length,
  };
}

/** The stanza settings that decide where a timestamp is looked for. */
export interface TimestampLocation {
  /** TIME_PREFIX, trimmed; undefined when unset or empty. */
  timePrefix?: string;
  /** TIME_FORMAT, trimmed; undefined when unset or empty. */
  timeFormat?: string;
  /** MAX_TIMESTAMP_LOOKAHEAD, resolved. */
  lookahead: number;
}

/**
 * Read the location settings from a stanza. An empty TIME_PREFIX or
 * TIME_FORMAT is unset, as an empty value is for every other setting: the empty
 * regex would match at offset 0 and anchor the search to the event start.
 */
export function readTimestampLocation(directives: ConfDirective[]): TimestampLocation {
  return {
    timePrefix: effectiveDirective(directives, 'TIME_PREFIX')?.value.trim() || undefined,
    timeFormat: effectiveDirective(directives, 'TIME_FORMAT')?.value.trim() || undefined,
    lookahead: resolveLookahead(effectiveDirective(directives, 'MAX_TIMESTAMP_LOOKAHEAD')?.value),
  };
}

export type TimestampSearch =
  | {
      found: true;
      source: 'TIME_FORMAT' | 'auto-recognition';
      format: string;
      /** Offsets into the searched text, end exclusive. */
      start: number;
      end: number;
      /** What was parsed; for TIME_FORMAT it may carry leading whitespace. */
      text: string;
      parsed: ParsedTimestamp;
    }
  | { found: false; reason: 'prefix-broken' | 'prefix-unmatched' | 'format-unmatched' | 'unrecognised' }
  /** TIME_FORMAT matched `text`, which would not parse. */
  | { found: false; reason: 'unparsable'; text: string };

export interface TimestampFinder {
  find(raw: string): TimestampSearch;
  /** True when TIME_PREFIX is set and will not compile: nothing is ever found. */
  prefixBroken: boolean;
}

/**
 * Compile a stanza's location settings once, for a batch of events or lines.
 *
 * TIME_PREFIX, when set, must match; the search window is the lookahead after
 * it. A prefix that will not compile never matches -- dropping it would read a
 * plausible timestamp from the wrong place, the outcome that hides the mistake.
 * In the window, TIME_FORMAT when set, otherwise automatic recognition.
 */
export function createTimestampFinder(
  location: TimestampLocation,
  options: ParseTimestampOptions = {},
): TimestampFinder {
  const { timePrefix, timeFormat, lookahead } = location;
  const prefixRegex = timePrefix !== undefined ? safeRegex(timePrefix) : null;
  const prefixBroken = timePrefix !== undefined && prefixRegex === null;
  const formatRegex = timeFormat !== undefined ? timeFormatRegex(timeFormat, prefixRegex !== null) : null;

  const find = (raw: string): TimestampSearch => {
    if (prefixBroken) return { found: false, reason: 'prefix-broken' };
    let searchStart = 0;
    if (prefixRegex) {
      const m = prefixRegex.exec(raw);
      if (!m) return { found: false, reason: 'prefix-unmatched' };
      searchStart = m.index + m[0].length;
    }
    const searchEnd = Math.min(searchStart + lookahead, raw.length);

    if (timeFormat !== undefined && formatRegex !== null) {
      const match = matchTimeFormat(raw, searchStart, searchEnd, formatRegex);
      if (!match) return { found: false, reason: 'format-unmatched' };
      const parsed = parseTimestampDetailed(match.text, timeFormat, options);
      if (!parsed) return { found: false, reason: 'unparsable', text: match.text };
      return { found: true, source: 'TIME_FORMAT', format: timeFormat, ...match, parsed };
    }

    const auto = recognizeTimestamp(raw.substring(searchStart, searchEnd), options);
    if (!auto) return { found: false, reason: 'unrecognised' };
    return {
      found: true,
      source: 'auto-recognition',
      format: auto.format,
      start: searchStart + auto.start,
      end: searchStart + auto.end,
      text: auto.text,
      parsed: auto.parsed,
    };
  };

  return { find, prefixBroken };
}
