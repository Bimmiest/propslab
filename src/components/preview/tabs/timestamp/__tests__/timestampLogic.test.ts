import { describe, it, expect } from 'vitest';
import { extractDirectives, overlaySegments, parseTimeConfig, resolvedTimeSource, timestampTextOf } from '../timestampLogic';
import { STRPTIME_REFERENCE } from '../data';
import { supportedSpecifiers } from '../../../../../utils/strftime';
import { probeTimestamp, type TimeConfig } from '../../../../../engine/timestampMatch';
import type { SplunkEvent } from '../../../../../engine/types';

const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

function makeEvent(over: Partial<SplunkEvent> = {}): SplunkEvent {
  return { _raw: 'raw', _time: null, _meta: {}, fields: {}, metadata, lineNumbers: { start: 1, end: 1 }, processingTrace: [], ...over };
}

describe('parseTimeConfig', () => {
  it('reads the time settings of the stanzas that apply to the event', () => {
    const conf = '[st]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y\nMAX_TIMESTAMP_LOOKAHEAD = 20\nTZ = UTC\nTZ_ALIAS = EST=UTC\n[other]\nTIME_FORMAT = %H\n';
    expect(parseTimeConfig(conf, metadata)).toEqual({
      timePrefix: 'ts=', timeFormat: '%Y', maxLookahead: 20, tz: 'UTC', tzAlias: 'EST=UTC',
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
    expect(timestampTextOf(makeEvent({ timestampText: 'before' }))).toBe('before');
    expect(timestampTextOf(makeEvent())).toBe('raw');
  });

  it('reports the last timestamp step\'s time source', () => {
    const event = makeEvent({
      processingTrace: [
        { processor: 'timestampExtractor', phase: 'index-time', description: '', timeSource: 'current-time' },
        { processor: 'EXTRACT-x', phase: 'search-time', description: '' },
        { processor: 'timestampExtractor', phase: 'index-time', description: '', timeSource: 'previous-event' },
      ],
    });
    expect(resolvedTimeSource(event)).toBe('previous-event');
    expect(resolvedTimeSource(makeEvent())).toBeUndefined();
  });
});

describe('the strptime reference and the format breakdown (#457)', () => {
  const referenced = STRPTIME_REFERENCE.flatMap((cat) => cat.directives.map((d) => d.directive));

  it('describes every specifier the parser implements, once', () => {
    for (const spec of supportedSpecifiers()) expect(referenced, spec).toContain(spec);
    expect(new Set(referenced).size).toBe(referenced.length);
  });

  it('breaks a format down as the parser tokenises it, with the reference\'s descriptions', () => {
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
      'outside:x ', 'prefix:ts=', 'gap: ', 'timestamp:2026-01-15', 'window: ta', 'boundary:]', 'outside:il and more',
    ]);
    expect(segments.map((s) => s.text).join('').replace(']', '')).toBe(raw);
    expect(segments[1]!.title).toBe('TIME_PREFIX: ts=');
    expect(segments[3]!.title).toBe('TIME_FORMAT: %Y-%m-%d\nParsed: 2026-01-15T00:00:00.000Z');
  });

  it('draws no prefix without a TIME_PREFIX, and no window marker when the timestamp ends the lookahead', () => {
    const cfg = { ...config, timePrefix: null, maxLookahead: 10 };
    expect(segmentsOf('2026-01-15 rest', cfg)!.map((s) => s.kind)).toEqual(['timestamp', 'outside']);
  });

  it('draws the lookahead window when the prefix matched but the format did not', () => {
    expect(segmentsOf('a ts=garbage-and-more-text')!.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'outside:a ', 'prefix:ts=', 'window:garbage-and-mo', 'boundary:]', 'outside:re-text',
    ]);
  });

  it('is null when neither matched, so the text is drawn plain', () => {
    expect(segmentsOf('no prefix here')).toBeNull();
    expect(overlaySegments('x', null, config)).toBeNull();
  });
});
