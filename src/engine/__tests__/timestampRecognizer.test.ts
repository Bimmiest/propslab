import { describe, it, expect } from 'vitest';
import { AUTO_TIME_FORMATS, recognizeTimestamp } from '../processors/timestampRecognizer';
import { extractTimestamps } from '../processors/timestampExtractor';
import { breakLines } from '../processors/lineBreaker';
import { detectTimestamp } from '../scaffold/analyzers/timestamp';
import type { ConfDirective, EventMetadata, SplunkEvent } from '../types';

// Doc- and convention-derived, not captured: the Splunk 10.4.0 fixtures only
// pin ISO 8601 with a Z zone, at the start of a line. What these tests pin is
// that the three consumers of the recogniser -- line breaking, extraction and
// the scaffold -- give the same answer for a line, whatever that answer is.

const NOW = new Date('2026-01-20T00:00:00.000Z');
const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function dir(key: string, value: string): ConfDirective {
  return { key, value, line: 1, directiveType: key };
}

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: META,
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

/** What extraction read from `line`: the source, format and instant, or null. */
function extracted(line: string, directives: ConfDirective[] = []) {
  const e = extractTimestamps([event(line)], directives, undefined, NOW)[0]!;
  const step = e.processingTrace.at(-1)!;
  if (step.timeSource !== 'auto-recognition' && step.timeSource !== 'TIME_FORMAT') return null;
  const format = /^Auto-recognized timestamp \((.*)\): /.exec(step.description)?.[1];
  return { source: step.timeSource, format, iso: e._time!.toISOString() };
}

/** Whether BREAK_ONLY_BEFORE_DATE starts an event at `line`. */
function startsEvent(line: string, directives: ConfDirective[] = []): boolean {
  return breakLines(`no date here\n${line}`, directives, META).length === 2;
}

interface Case {
  line: string;
  /** The format recognised, or null when the line carries no timestamp. */
  format: string | null;
  iso?: string;
}

const CORPUS: Case[] = [
  { line: '2026-01-15T10:00:00Z msg', format: '%Y-%m-%dT%H:%M:%S%z', iso: '2026-01-15T10:00:00.000Z' },
  { line: '2026-01-15T10:00:00.123456+05:00 msg', format: '%Y-%m-%dT%H:%M:%S.%6N%z', iso: '2026-01-15T05:00:00.123Z' },
  { line: '2026-01-15 10:00:00 +0500 msg', format: '%Y-%m-%d %H:%M:%S %z', iso: '2026-01-15T05:00:00.000Z' },
  { line: '2026-01-15 10:00:00 Zookeeper started', format: '%Y-%m-%d %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: '[2026-01-15 10:00:00] a', format: '%Y-%m-%d %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: '<34>Jan 15 10:00:01 host a', format: '%b %e %H:%M:%S', iso: '2026-01-15T10:00:01.000Z' },
  { line: '10.0.0.1 - - [15/Jan/2026:10:00:00 +0100] "GET /"', format: '%d/%b/%Y:%H:%M:%S %z', iso: '2026-01-15T09:00:00.000Z' },
  { line: 'Thu Jan 15 10:00:00 2026 started', format: '%a %b %e %H:%M:%S %Y', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'Thu, 15 Jan 2026 10:00:00 +0100 mail', format: '%a, %d %b %Y %H:%M:%S %z', iso: '2026-01-15T09:00:00.000Z' },
  { line: '15 Jan 2026 10:00:00 x', format: '%d %b %Y %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: '2026/01/15 10:00:00 x', format: '%Y/%m/%d %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: '01/15/2026 10:00:00 x', format: '%m/%d/%Y %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'build 2026-01-15 ok', format: '%Y-%m-%d', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'date 2026/01/15 ok', format: '%Y/%m/%d', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'on 1/15/2026 ok', format: '%m/%d/%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'on 01-15-2026 ok', format: '%m-%d-%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'on 1/15/26 ok', format: '%m/%d/%y', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'due 15/Jan/2026', format: '%d/%b/%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'due 15-Jan-2026', format: '%d-%b-%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: 'due 15 Jan 2026', format: '%d %b %Y', iso: '2026-01-15T00:00:00.000Z' },
  // Month and weekday names in any case, as datetime.xml matches them
  // (doc-derived): Oracle, IBM and mainframe sources write them in capitals.
  { line: '15-JAN-2026 10:00:00 ORA-00600', format: '%d-%b-%Y %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'JAN 15 10:00:00 SYSLOG', format: '%b %e %H:%M:%S', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'THU JAN 15 10:00:00 2026 IPL', format: '%a %b %e %H:%M:%S %Y', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'due 15-jan-2026', format: '%d-%b-%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: '1768471200 a', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: '  1768471200 indented', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: '1768471200123 b', format: '%s%3N', iso: '2026-01-15T10:00:00.123Z' },
  { line: '1768471200.5 c', format: '%s.%1N', iso: '2026-01-15T10:00:00.500Z' },
  // An epoch after any of datetime.xml's UTC-epoch delimiters -- whitespace,
  // # , " = ( [ | { -- not only at the start (doc-derived).
  { line: 'time=1768471200 msg=x', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: '[1768471200] x', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'id 1768471200 e', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: '{"ts": 1768471200123}', format: '%s%3N', iso: '2026-01-15T10:00:00.123Z' },
  { line: 'a|1768471200.25|b', format: '%s.%2N', iso: '2026-01-15T10:00:00.250Z' },
  { line: 'f(1768471200) #1768471201', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  // The earliest timestamp wins over a more specific one further in.
  { line: '01/15/2026 note 2026-01-10T08:00:00Z', format: '%m/%d/%Y', iso: '2026-01-15T00:00:00.000Z' },
  { line: '1768471200 at 2026-01-10T08:00:00Z', format: '%s', iso: '2026-01-15T10:00:00.000Z' },
  { line: 'at 2026-01-10T08:00:00Z id=1768471200', format: '%Y-%m-%dT%H:%M:%S%z', iso: '2026-01-10T08:00:00.000Z' },

  // A weekday alone names no date.
  { line: 'Thu started', format: null },
  { line: 'THU started', format: null },
  // Month names stand as words, and a month and day with neither year nor
  // time is not a timestamp: in any case it reads prose.
  { line: 'Market 5 closed', format: null },
  { line: 'Decimal 12 places', format: null },
  { line: 'you may 12 things', format: null },
  { line: 'in March 3 times', format: null },
  { line: 'Jan 15 rollover', format: null },
  // A date is not read out of a longer number.
  { line: 'id 120260922-01-15', format: null },
  { line: 'ref 3/4/2026/7', format: null },
  // Only a plausible epoch, standing alone after a delimiter.
  { line: '17684712001 b', format: null },
  { line: '176847120012 c', format: null },
  { line: '9999999999 d', format: null },
  { line: 'id-1768471200 e', format: null },
  { line: 'v1768471200 e', format: null },
  // `:` is not one of the delimiters, so compact JSON's `"ts":1768471200` is not either.
  { line: 'id:1768471200 e', format: null },
  { line: '{"ts":1768471200}', format: null },
  { line: '1768471200.1234567890 e', format: null },
  // Shaped like a date, not one.
  { line: '2026-13-45 bad', format: null },
  { line: 'no digits here', format: null },
];

describe('the timestamp recogniser', () => {
  it('compiles every format in its table', () => {
    // 30 ISO forms per separator, 17 others, 11 epoch forms: a format whose
    // regex the regex guard refused would drop out of the table silently.
    expect(AUTO_TIME_FORMATS).toHaveLength(88);
  });

  it.each(CORPUS)('reads $line as $format', ({ line, format, iso }) => {
    const found = recognizeTimestamp(line, { now: NOW });
    expect(found?.format ?? null).toBe(format);
    if (found) expect(found.parsed.date.toISOString()).toBe(iso);
  });
});

describe('line breaking, extraction and the scaffold agree', () => {
  it.each(CORPUS)('on $line', ({ line, format, iso }) => {
    // Extraction reads the same format and instant.
    const read = extracted(line);
    expect(read && { format: read.format, iso: read.iso }).toEqual(format === null ? null : { format, iso });

    // BREAK_ONLY_BEFORE_DATE starts an event exactly where a timestamp is read.
    expect(startsEvent(line)).toBe(format !== null);

    // The scaffold suggests that format, and extraction configured with the
    // scaffold's suggestions reads the same instant through TIME_FORMAT.
    const suggestions = detectTimestamp([line]);
    if (format === null) {
      expect(suggestions).toEqual([]);
      return;
    }
    expect(suggestions.find((s) => s.key === 'TIME_FORMAT')?.value).toBe(format);
    const configured = extracted(line, suggestions.map((s) => dir(s.key, s.value)));
    expect(configured).toEqual({ source: 'TIME_FORMAT', format: undefined, iso });
  });

  // The stanza's location settings apply to both: a line starts an event
  // exactly when extraction reads a timestamp from it.
  const LOCATED: { name: string; directives: ConfDirective[]; lines: string[] }[] = [
    {
      name: 'TIME_PREFIX alone',
      directives: [dir('TIME_PREFIX', 'at=')],
      lines: ['at=2026-01-15 10:00:00 a', 'x 2026-01-15 10:00:01 no prefix', 'at=later 2026-01-15'],
    },
    {
      name: 'TIME_FORMAT',
      directives: [dir('TIME_FORMAT', '%d.%m.%Y %H:%M:%S')],
      lines: ['15.01.2026 10:00:01 a', '45.01.2026 10:00:02 b', '2026-01-15 10:00:00 auto form'],
    },
    {
      name: 'MAX_TIMESTAMP_LOOKAHEAD',
      directives: [dir('MAX_TIMESTAMP_LOOKAHEAD', '10')],
      lines: ['2026-01-15 a', 'later than ten 2026-01-15'],
    },
    {
      name: 'a TIME_PREFIX that will not compile',
      directives: [dir('TIME_PREFIX', '(')],
      lines: ['2026-01-15T10:00:00Z a'],
    },
  ];

  it.each(LOCATED)('under $name', ({ directives, lines }) => {
    for (const line of lines) {
      expect(startsEvent(line, directives), line).toBe(extracted(line, directives) !== null);
    }
  });

  it('breaks nowhere when TIME_PREFIX will not compile, as extraction reads no timestamp', () => {
    const raw = '2026-01-15T10:00:00Z a\n2026-01-15T10:00:01Z b';
    expect(breakLines(raw, [dir('TIME_PREFIX', '(')], META)).toHaveLength(1);
  });
});
