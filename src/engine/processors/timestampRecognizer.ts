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
import { parseTimestampDetailed, strftimeToRegex, type ParsedTimestamp, type ParseTimestampOptions } from '../../utils/strftime';
import { effectiveDirective } from '../utils/directiveValues';

// ---------------------------------------------------------------------------
// The format table
// ---------------------------------------------------------------------------

interface AutoFormat {
  /** The strftime format the stamp is parsed with, and the TIME_FORMAT that reads it. */
  format: string;
  regex: RegExp;
  /** Recognised only at the start of the region, after leading whitespace. */
  atStart: boolean;
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
 * ISO-style date-times over every fraction width from 9 digits down to 1, with
 * the zone attached or after a space. A fixed `.%3N` stopped at the third digit
 * of `.123456+05:00` and left the zone unread.
 */
const FRACTION_WIDTHS = [9, 8, 7, 6, 5, 4, 3, 2, 1];
function isoDateTimeFormats(separator: string): string[] {
  const base = `%Y-%m-%d${separator}%H:%M:%S`;
  const fractions = FRACTION_WIDTHS.map((w) => `${base}.%${w}N`);
  return [
    ...fractions.map((f) => `${f}%z`),
    ...fractions.map((f) => `${f} %z`),
    `${base}%z`,
    `${base} %z`,
    ...fractions,
    base,
  ];
}

/**
 * Formats recognised anywhere in the region, most specific first: where two
 * match at the same offset the earlier entry wins, so a stamp with a zone is
 * read with it and a date-time is not cut down to its date. A pragmatic subset
 * of Splunk's datetime.xml.
 *
 * The date-only and month-day forms are here because a line carrying one is a
 * dated line for BREAK_ONLY_BEFORE_DATE, and the date it carries is the one
 * extraction must then read -- not a line that breaks with nothing to place it.
 */
const ISO_FORMATS = [...isoDateTimeFormats('T'), ...isoDateTimeFormats(' ')];
const OTHER_FORMATS = [
  '%a, %d %b %Y %H:%M:%S %z', // RFC 2822
  '%a %b %e %H:%M:%S %Y',     // ctime
  '%d/%b/%Y:%H:%M:%S %z',     // Apache access log
  '%d %b %Y %H:%M:%S',
  '%b %e %H:%M:%S',           // syslog: no year, so the most recent one it can be
  '%Y/%m/%d %H:%M:%S',
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
  '%b %e',
];

/**
 * Epoch time, only at the start of the region: a bare number mid-line is as
 * likely an id, a byte count or a port. Only a plausible epoch counts -- ten
 * digits of seconds from 2001 to 2033 or thirteen of milliseconds, optionally
 * with a fraction, and not the prefix of a longer number -- so an 11- or
 * 12-digit order id is not a timestamp.
 */
const EPOCH_FORMATS: { format: string; pattern: string }[] = [
  ...FRACTION_WIDTHS.map((w) => ({ format: `%s.%${w}N`, pattern: `1\\d{9}\\.\\d{${w}}` })),
  { format: '%s%3N', pattern: '1\\d{12}' },
  { format: '%s', pattern: '1\\d{9}' },
];

const DATE_TOKENS = /%[Ymdey]$/;

/**
 * Boundary guards around a format, from its first and last directive: a number
 * must not be part of a longer number (`120260922-01-15`, `3/4/2026/7`), a
 * name must stand as a word (`Market 5` is not `Mar 5`), and a trailing zone
 * must not run on into a word (`10:00:00 Zookeeper` is not UTC).
 */
function guarded(format: string): string {
  const body = strftimeToRegex(format).source;
  const startsWithName = /^%[aAbB]/.test(format);
  const before = startsWithName ? '(?<![A-Za-z])' : '(?<!\\d)(?<!\\d[/-])';
  const after = format.endsWith('%z')
    ? '(?![A-Za-z0-9])'
    : DATE_TOKENS.test(format)
      ? '(?!\\d)(?![/-]\\d)'
      : '(?!\\d)';
  return `${before}(?:${body})${after}`;
}

// Case-sensitive: log writers capitalise month and weekday names, and prose
// does not -- `you may 12` is not a date.
function family(gate: string | null, entries: { format: string; pattern: string; atStart: boolean }[]): AutoFamily {
  return {
    // A gate the regex guard refuses only costs speed: the family is then always searched.
    gate: gate === null ? null : safeRegex(gate),
    formats: entries.flatMap(({ format, pattern, atStart }) => {
      const regex = safeRegex(pattern);
      return regex ? [{ format, regex, atStart }] : [];
    }),
  };
}

const anywhere = (format: string) => ({ format, pattern: guarded(format), atStart: false });

// In priority order, family by family.
const AUTO_FAMILIES: AutoFamily[] = [
  family('\\d-\\d{1,2}-\\d{1,2}(?:T|\\s+)\\d{1,2}:\\d{1,2}:\\d', ISO_FORMATS.map(anywhere)),
  family(null, OTHER_FORMATS.map(anywhere)),
  family(
    '^\\s*1\\d{9}',
    EPOCH_FORMATS.map(({ format, pattern }) => ({ format, pattern: `^\\s*${pattern}(?![\\d.])`, atStart: true })),
  ),
];

/** Every format automatic recognition reads, in priority order. */
export const AUTO_TIME_FORMATS: readonly string[] = AUTO_FAMILIES.flatMap((f) => f.formats.map((a) => a.format));

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
 * A format whose first match does not parse (`2026-13-45`) is passed over.
 */
export function recognizeTimestamp(
  region: string,
  options: ParseTimestampOptions = {},
): RecognizedTimestamp | null {
  // Every format needs a digit; most lines of a stack trace have none.
  if (!/\d/.test(region)) return null;
  let best: RecognizedTimestamp | null = null;
  for (const { gate, formats } of AUTO_FAMILIES) {
    if (gate !== null && !gate.test(region)) continue;
    for (const { format, regex, atStart } of formats) {
      const m = regex.exec(region);
      if (!m) continue;
      // The start-anchored forms admit leading whitespace; the stamp follows it.
      const text = atStart ? m[0].trimStart() : m[0];
      const start = m.index + (m[0].length - text.length);
      // Strictly earlier: an equal offset keeps the more specific format.
      if (best !== null && start >= best.start) continue;
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
