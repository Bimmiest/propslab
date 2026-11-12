import { describe, it, expect } from 'vitest';
import {
  extractTimestamps,
  supportedSpecifiers,
  probeTimestamp,
  type TimeConfig,
  type ConfDirective,
  type SplunkEvent,
} from 'propslab-engine';
import {
  extractDirectives,
  fallbackReason,
  isSimulated,
  overlaySegments,
  parseTimeConfig,
  recognisedDirectives,
  recognisedRead,
  recognisedSegments,
  resolvedTimeSource,
  shownKinds,
  summariseRecognition,
  timestampStepOf,
  timestampTextOf,
} from '../timestampLogic';
import { runCtx } from '../../../../../test/runCtx';
import { STRPTIME_REFERENCE } from '../data';
import { makeEvent } from '../../../../../test/makeEvent';

const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const dir = (key: string, value: string): ConfDirective => ({ key, value, line: 1, directiveType: key });

function eventWith(over: Partial<SplunkEvent> = {}): SplunkEvent {
  return makeEvent('raw', { metadata, ...over });
}

describe('parseTimeConfig', () => {
  it('reads the time settings of the stanzas that apply to the event', () => {
    const conf =
      '[st]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y\nMAX_TIMESTAMP_LOOKAHEAD = 20\nTZ = UTC\nTZ_ALIAS = EST=UTC\n[other]\nTIME_FORMAT = %H\n';
    expect(parseTimeConfig(conf, metadata)).toEqual({
      timePrefix: 'ts=',
      timeFormat: '%Y',
      maxLookahead: 20,
      tz: 'UTC',
      tzAlias: 'EST=UTC',
    });
  });

  it('reads an empty TIME_PREFIX as unset and a missing lookahead as the default', () => {
    const config = parseTimeConfig('[st]\nTIME_PREFIX =\n', metadata);
    expect(config.timePrefix).toBeNull();
    expect(config.timeFormat).toBeNull();
    expect(config.maxLookahead).toBe(128);
  });

  it('ignores a stanza that does not match the event', () => {
    expect(parseTimeConfig('[other]\nTIME_FORMAT = %Y\n', metadata).timeFormat).toBeNull();
  });
});

describe('timestampTextOf and resolvedTimeSource', () => {
  it('prefers the text the extractor read over the final _raw', () => {
    expect(timestampTextOf(eventWith({ timestampText: 'before' }))).toBe('before');
    expect(timestampTextOf(eventWith())).toBe('raw');
  });

  it("reports the last timestamp step's time source", () => {
    const event = eventWith({
      processingTrace: [
        { processor: 'timestampExtractor', phase: 'index-time', description: '', timeSource: 'current-time' },
        { processor: 'EXTRACT-x', phase: 'search-time', description: '' },
        { processor: 'timestampExtractor', phase: 'index-time', description: '', timeSource: 'previous-event' },
      ],
    });
    expect(resolvedTimeSource(event)).toBe('previous-event');
    expect(resolvedTimeSource(eventWith())).toBeUndefined();
  });
});

describe('the strptime reference and the format breakdown (#457)', () => {
  const referenced = STRPTIME_REFERENCE.flatMap((cat) => cat.directives.map((d) => d.directive));

  it('describes every specifier the parser implements, once', () => {
    for (const spec of supportedSpecifiers()) expect(referenced, spec).toContain(spec);
    expect(new Set(referenced).size).toBe(referenced.length);
  });

  it('marks as not simulated exactly the reference rows the parser does not implement', () => {
    expect(referenced.filter((spec) => !isSimulated(spec))).toEqual([
      '%C',
      '%G',
      '%g',
      '%h',
      '%u',
      '%w',
      '%P',
      '%R',
      '%c',
      '%x',
      '%X',
      '%D',
      '%r',
      '%n',
      '%t',
      '%V',
      '%U',
      '%W',
    ]);
    // Whole specifiers only: a longer spelling that starts with one is not it.
    expect(isSimulated('%Y')).toBe(true);
    expect(isSimulated('%%')).toBe(true);
    expect(isSimulated('%Yx')).toBe(false);
    expect(isSimulated('%0N')).toBe(false);
  });

  it("breaks a format down as the parser tokenises it, with the reference's descriptions", () => {
    expect(extractDirectives('%Y-%m-%dT%H:%M:%S.%3N%:z')).toEqual([
      { directive: '%Y', description: '4-digit year' },
      { directive: '%m', description: 'Month as zero-padded number' },
      { directive: '%d', description: 'Day of month, zero-padded' },
      { directive: '%H', description: '24-hour, zero-padded' },
      { directive: '%M', description: 'Minute (00–59)' },
      { directive: '%S', description: 'Second (00–60)' },
      { directive: '%3N', description: 'Milliseconds (3 digits)' },
      { directive: '%:z', description: 'UTC offset (+HH:MM)' },
    ]);
  });

  it('names the specifiers the old breakdown skipped, and leaves out the escape and unsupported ones', () => {
    expect(extractDirectives('%%Y %j %k %Q %N %c').map((d) => d.directive)).toEqual(['%j', '%k', '%Q', '%N']);
  });
});

describe('overlaySegments', () => {
  const config: TimeConfig = { timePrefix: 'ts=', timeFormat: '%Y-%m-%d', maxLookahead: 14, tz: 'UTC' };
  const segmentsOf = (raw: string, cfg: TimeConfig = config) => overlaySegments(raw, probeTimestamp(raw, cfg), cfg);

  it('splits a match into the text before, the prefix, the gap, the timestamp, the window and after', () => {
    const raw = 'x ts= 2026-01-15 tail and more';
    const segments = segmentsOf(raw)!;
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'outside:x ',
      'prefix:ts=',
      'gap: ',
      'timestamp:2026-01-15',
      'window: ta',
      'boundary:]',
      'outside:il and more',
    ]);
    expect(
      segments
        .filter((s) => s.kind !== 'boundary')
        .map((s) => s.text)
        .join(''),
    ).toBe(raw);
    expect(segments[1]!.title).toBe('TIME_PREFIX: ts=');
    expect(segments[3]!.title).toBe('TIME_FORMAT: %Y-%m-%d\nParsed: 2026-01-15T00:00:00.000Z');
  });

  it('draws no prefix without a TIME_PREFIX, and no window marker when the timestamp ends the lookahead', () => {
    const cfg = { ...config, timePrefix: null, maxLookahead: 10 };
    expect(segmentsOf('2026-01-15 rest', cfg)!.map((s) => s.kind)).toEqual(['timestamp', 'outside']);
  });

  it('draws the lookahead window when the prefix matched but the format did not', () => {
    expect(segmentsOf('a ts=garbage-and-more-text')!.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'outside:a ',
      'prefix:ts=',
      'window:garbage-and-mo',
      'boundary:]',
      'outside:re-text',
    ]);
  });

  it('is null when neither matched, so the text is drawn plain', () => {
    expect(segmentsOf('no prefix here')).toBeNull();
    expect(overlaySegments('x', null, config)).toBeNull();
  });
});

// With no TIME_FORMAT, the tab reads what automatic recognition did from the
// run's trace (#898). Built by the extractor itself, so the tab and the
// engine are held to one contract.
describe('automatic recognition (#898)', () => {
  const now = new Date('2026-11-01T00:00:00.000Z');
  const run = (...raws: string[]) =>
    extractTimestamps(
      raws.map((raw) => makeEvent(raw)),
      [],
      runCtx(now),
    );
  const noFormat: TimeConfig = { timePrefix: null, timeFormat: null, maxLookahead: 128, tz: null };

  it('reads the format and the span of an event it recognised, and nothing of one it did not', () => {
    const [read, fallback] = run('a 2026/10/25 14:23:01 b', 'no time');
    expect(recognisedRead(read!)).toEqual({ format: '%Y/%m/%d %H:%M:%S', span: { start: 2, end: 21 } });
    expect(recognisedRead(fallback!)).toBeNull();
  });

  it('counts recognised and fallback events, and puts the most common format first', () => {
    const summary = summariseRecognition(
      run('25/Oct/2026:14:23:01 x', '2026-10-25 14:23:02 y', 'none', '2026-10-25 14:23:03 ok'),
    );
    expect(summary.recognised).toBe(3);
    expect(summary.fallback).toBe(1);
    expect(summary.formats.map((f) => [f.format, f.count])).toEqual([
      ['%Y-%m-%d %H:%M:%S', 2],
      ['%d/%b/%Y:%H:%M:%S', 1],
    ]);
    // The first event read with a format is the one its directives come from.
    expect(summary.formats[0]?.example).toEqual({ text: '2026-10-25 14:23:02 y', span: { start: 0, end: 19 } });
  });

  it('keeps first-seen order between formats with the same count', () => {
    const summary = summariseRecognition(run('25/Oct/2026:14:23:01 x', '2026-10-25 14:23:02 y'));
    expect(summary.formats.map((f) => f.format)).toEqual(['%d/%b/%Y:%H:%M:%S', '%Y-%m-%d %H:%M:%S']);
  });

  it('counts an event with no timestamp step as neither', () => {
    expect(summariseRecognition([makeEvent('x')])).toEqual({ formats: [], recognised: 0, fallback: 0 });
  });

  it('writes the directives the scaffold would, located from the example event', () => {
    const [format] = summariseRecognition(run('1,2026/10/25 14:23:01,007')).formats;
    expect(recognisedDirectives(format!, noFormat)).toEqual([
      { key: 'TIME_PREFIX', value: ',' },
      { key: 'TIME_FORMAT', value: '%Y/%m/%d %H:%M:%S' },
      { key: 'MAX_TIMESTAMP_LOOKAHEAD', value: '20' },
    ]);
  });

  it('leaves TIME_PREFIX out when no stable prefix precedes the timestamp', () => {
    const [format] = summariseRecognition(run('2026-10-25 14:23:01 x')).formats;
    expect(recognisedDirectives(format!, noFormat)).toEqual([
      { key: 'TIME_FORMAT', value: '%Y-%m-%d %H:%M:%S' },
      { key: 'MAX_TIMESTAMP_LOOKAHEAD', value: '29' },
    ]);
  });

  it('writes TIME_FORMAT alone when TIME_PREFIX is already set', () => {
    const [format] = summariseRecognition(run('ts=2026-10-25 14:23:01 x')).formats;
    expect(recognisedDirectives(format!, { ...noFormat, timePrefix: 'ts=' })).toEqual([
      { key: 'TIME_FORMAT', value: '%Y-%m-%d %H:%M:%S' },
    ]);
  });

  it('says why an event fell back and where its _time came from', () => {
    const [, previous] = run('2026-10-25 14:23:01 x', 'no time');
    expect(fallbackReason(timestampStepOf(previous!))).toBe('No timestamp found — _time from the previous event');
    const [clock] = run('no time');
    expect(fallbackReason(timestampStepOf(clock!))).toBe('No timestamp found — _time from the time of indexing');
    const [old] = extractTimestamps([makeEvent('2020-01-01 00:00:00 x')], [dir('MAX_DAYS_AGO', '7')], runCtx(now));
    expect(fallbackReason(timestampStepOf(old!))).toBe(
      'Timestamp outside the sanity bounds — _time from the time of indexing',
    );
  });

  it('names DATETIME_CONFIG as the reason, and nothing for an event that was read', () => {
    const [current] = extractTimestamps([makeEvent('x')], [dir('DATETIME_CONFIG', 'CURRENT')], runCtx(now));
    expect(fallbackReason(timestampStepOf(current!))).toBe('DATETIME_CONFIG = CURRENT');
    const [read] = run('2026-10-25 14:23:01 x');
    expect(fallbackReason(timestampStepOf(read!))).toBeNull();
    expect(fallbackReason(undefined)).toBeNull();
  });

  it('draws the recorded span as the timestamp, titled with the recognised format', () => {
    const raw = 'a 2026/10/25 14:23:01 b';
    const segments = recognisedSegments(
      raw,
      null,
      { ...noFormat, maxLookahead: 25 },
      { format: '%Y/%m/%d %H:%M:%S', span: { start: 2, end: 21 }, timeMs: Date.UTC(2026, 9, 25, 14, 23, 1) },
    )!;
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'gap:a ',
      'timestamp:2026/10/25 14:23:01',
      'window: b',
      'boundary:]',
    ]);
    expect(segments[1]?.title).toBe('Recognized format: %Y/%m/%d %H:%M:%S\nParsed: 2026-10-25T14:23:01.000Z');
  });

  it('draws the TIME_PREFIX match the prober found before a recognised timestamp', () => {
    const raw = 'id ts=2026-10-25 14:23:01 tail';
    const config = { ...noFormat, timePrefix: 'ts=', maxLookahead: 20 };
    const segments = recognisedSegments(raw, probeTimestamp(raw, config), config, {
      format: '%Y-%m-%d %H:%M:%S',
      span: { start: 6, end: 25 },
      timeMs: null,
    })!;
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'outside:id ',
      'prefix:ts=',
      'timestamp:2026-10-25 14:23:01',
      'window: ',
      'boundary:]',
      'outside:tail',
    ]);
    expect(segments[2]?.title).toContain('Parsed: failed');
  });

  it('lists the overlay kinds that are on screen', () => {
    const kinds = shownKinds([[{ key: 'ts', kind: 'timestamp', text: 'x' }], null]);
    expect([...kinds]).toEqual(['timestamp']);
  });
});
