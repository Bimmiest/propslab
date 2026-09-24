import { describe, it, expect } from 'vitest';
import { probeTimestamp, probeTimestamps } from '../timestampMatch';
import type { TimeConfig } from '../timestampMatch';
import { extractTimestamps } from '../processors/timestampExtractor';
import { runPipeline } from '../pipeline';
import type { ConfDirective, SplunkEvent, ValidationDiagnostic } from '../types';

function config(overrides: Partial<TimeConfig> = {}): TimeConfig {
  return { timePrefix: null, timeFormat: null, maxLookahead: 128, tz: null, ...overrides };
}

describe('probeTimestamp — matching', () => {
  it('finds a timestamp with no TIME_PREFIX', () => {
    const raw = '2026-04-21 10:00:00 something happened';
    const { match } = probeTimestamp(raw, config({ timeFormat: '%Y-%m-%d %H:%M:%S' }));
    expect(match).not.toBeNull();
    expect(match!.matchedText).toBe('2026-04-21 10:00:00');
    expect(raw.substring(match!.tsStart, match!.tsEnd)).toBe('2026-04-21 10:00:00');
    expect(match!.parsedTimeMs).not.toBeNull();
  });

  it('anchors the search after a TIME_PREFIX match', () => {
    const raw = 'ignore 1999-01-01 ts=2026-04-21 10:00:00 rest';
    const { match } = probeTimestamp(
      raw,
      config({ timePrefix: 'ts=', timeFormat: '%Y-%m-%d %H:%M:%S' }),
    );
    expect(match).not.toBeNull();
    // The 1999 date precedes the prefix, so it must not win.
    expect(match!.matchedText).toBe('2026-04-21 10:00:00');
    expect(raw.substring(match!.prefixStart, match!.prefixEnd)).toBe('ts=');
  });

  it('honours MAX_TIMESTAMP_LOOKAHEAD', () => {
    const raw = 'ts=' + ' '.repeat(60) + '2026-04-21 10:00:00';
    const tight = probeTimestamp(
      raw,
      config({ timePrefix: 'ts=', timeFormat: '%Y-%m-%d %H:%M:%S', maxLookahead: 10 }),
    );
    expect(tight.match).toBeNull();

    const loose = probeTimestamp(
      raw,
      config({ timePrefix: 'ts=', timeFormat: '%Y-%m-%d %H:%M:%S', maxLookahead: 128 }),
    );
    expect(loose.match).not.toBeNull();
  });

  it('reports no match when TIME_PREFIX is absent from the event', () => {
    const probe = probeTimestamp(
      'no prefix here 2026-04-21 10:00:00',
      config({ timePrefix: 'ts=', timeFormat: '%Y-%m-%d %H:%M:%S' }),
    );
    expect(probe.match).toBeNull();
    expect(probe.prefix).toBeNull();
  });
});

describe('probeTimestamp — the prefix span the overlay renders', () => {
  // The overlay draws the lookahead window whenever TIME_PREFIX matched, even
  // when TIME_FORMAT then did not — that is what distinguishes "the prefix is
  // wrong" from "the format is wrong". It used to re-run the regex on the render
  // thread to recover this; now it comes back on the probe (#117).
  it('carries the prefix span when the prefix matched but the format did not', () => {
    const raw = 'ts=not-a-timestamp at all';
    const probe = probeTimestamp(
      raw,
      config({ timePrefix: 'ts=', timeFormat: '%Y-%m-%d %H:%M:%S', maxLookahead: 10 }),
    );
    expect(probe.match).toBeNull();
    expect(probe.prefix).not.toBeNull();
    expect(raw.substring(probe.prefix!.start, probe.prefix!.end)).toBe('ts=');
    expect(probe.prefix!.lookaheadEnd).toBe(Math.min(3 + 10, raw.length));
  });

  it('carries the prefix span when TIME_FORMAT is not set yet', () => {
    // Halfway through writing a config: prefix typed, format not.
    const probe = probeTimestamp('ts=2026-04-21', config({ timePrefix: 'ts=' }));
    expect(probe.match).toBeNull();
    expect(probe.prefix).not.toBeNull();
  });

  it('clamps the lookahead window to the end of the event', () => {
    const raw = 'ts=x';
    const probe = probeTimestamp(raw, config({ timePrefix: 'ts=', maxLookahead: 9999 }));
    expect(probe.prefix!.lookaheadEnd).toBe(raw.length);
  });
});

describe('probeTimestamp — patterns safeRegex refuses', () => {
  it('reports nothing rather than throwing when TIME_PREFIX will not compile', () => {
    const probe = probeTimestamp(
      'ts=2026-04-21 10:00:00',
      config({ timePrefix: '(?<', timeFormat: '%Y-%m-%d %H:%M:%S' }),
    );
    expect(probe.match).toBeNull();
    expect(probe.prefix).toBeNull();
  });
});

describe('probeTimestamps — batch', () => {
  it('returns one probe per input, aligned to the inputs', () => {
    const probes = probeTimestamps(
      ['2026-04-21 10:00:00 a', 'no timestamp', '2026-04-22 11:00:00 b'],
      config({ timeFormat: '%Y-%m-%d %H:%M:%S' }),
    );
    expect(probes).toHaveLength(3);
    expect(probes[0]!.match?.matchedText).toBe('2026-04-21 10:00:00');
    expect(probes[1]!.match).toBeNull();
    expect(probes[2]!.match?.matchedText).toBe('2026-04-22 11:00:00');
  });

  it('carries parsedTimeMs as a primitive, so it survives a structured clone', () => {
    // The worker boundary is why this is a number and not a Date. Asserting the
    // type keeps a future refactor from quietly putting a Date back on the wire.
    const probe = probeTimestamps(['2026-04-21 10:00:00'], config({ timeFormat: '%Y-%m-%d %H:%M:%S' }))[0]!;
    expect(typeof probe.match!.parsedTimeMs).toBe('number');
    expect(new Date(probe.match!.parsedTimeMs!).toISOString()).toContain('2026-04-21');
  });
});

/**
 * The Timestamp tab's prober and the pipeline's extractor must agree on where
 * a timestamp is and what it says: the tab highlights with one and badges
 * `_time` from the other. They used to carry separate copies of the
 * TIME_PREFIX → TIME_FORMAT search, and the prober's scanned the lookahead
 * window unanchored and parsed without TZ_ALIAS or `now` (#313). Each case runs
 * both over the same input and compares them, rather than pinning either one.
 */
describe('probeTimestamp agrees with extractTimestamps (#313)', () => {
  const NOW = new Date('2026-08-04T00:00:00.000Z');

  function event(raw: string): SplunkEvent {
    return {
      _raw: raw,
      _time: null,
      _meta: {},
      fields: {},
      metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      lineNumbers: { start: 1, end: 1 },
      processingTrace: [],
    };
  }

  /** Run both sides over one event under the same stanza. */
  function both(raw: string, stanza: Record<string, string>, now: Date = NOW) {
    const directives: ConfDirective[] = Object.entries(stanza).map(([key, value]) => ({
      key,
      value,
      line: 1,
      directiveType: key,
    }));
    const extracted = extractTimestamps([event(raw)], directives, undefined, now)[0]!;
    const source = extracted.processingTrace.at(-1)?.timeSource;
    const probe = probeTimestamp(
      raw,
      config({
        timePrefix: stanza.TIME_PREFIX ?? null,
        timeFormat: stanza.TIME_FORMAT ?? null,
        tz: stanza.TZ ?? null,
        tzAlias: stanza.TZ_ALIAS ?? null,
        now: now.getTime(),
      }),
    );
    return { extracted, source, probe };
  }

  it('does not match a date that does not sit right after TIME_PREFIX', () => {
    // The reported repro: the tab highlighted 2026-01-15, the pipeline did not
    // read it.
    const { source, probe } = both('ts=x 2026-01-15', { TIME_PREFIX: 'ts=', TIME_FORMAT: '%Y-%m-%d' });
    expect(source).not.toBe('TIME_FORMAT');
    expect(probe.match).toBeNull();
    // The prefix still matched, so the overlay can show the window it searched.
    expect(probe.prefix).not.toBeNull();
  });

  it('reports the span the extractor records, past the whitespace strptime skips', () => {
    const raw = 'ts=   2026-01-15 10:00:00 rest';
    const { extracted, source, probe } = both(raw, { TIME_PREFIX: 'ts=', TIME_FORMAT: '%Y-%m-%d %H:%M:%S' });
    expect(source).toBe('TIME_FORMAT');
    expect(probe.match).not.toBeNull();
    expect(String(probe.match!.tsStart)).toBe(extracted.fields.timestartpos);
    expect(String(probe.match!.tsEnd)).toBe(extracted.fields.timeendpos);
    expect(probe.match!.matchedText).toBe('2026-01-15 10:00:00');
    expect(probe.match!.parsedTimeMs).toBe(extracted._time!.getTime());
  });

  it('gives a yearless format the year of `now`, as the pipeline does', () => {
    // A `now` in another year than the clock's, which is the case that drifted:
    // the prober took the year from the real clock.
    const { extracted, source, probe } = both(
      'Aug  3 10:00:00 host msg',
      { TIME_FORMAT: '%b %e %H:%M:%S' },
      new Date('2021-08-04T00:00:00.000Z'),
    );
    expect(source).toBe('TIME_FORMAT');
    expect(new Date(probe.match!.parsedTimeMs!).getUTCFullYear()).toBe(2021);
    expect(probe.match!.parsedTimeMs).toBe(extracted._time!.getTime());
  });

  it('applies TZ_ALIAS to the zone the event carries', () => {
    const { extracted, source, probe } = both('2026-08-03 10:00:00 XYZ msg', {
      TIME_FORMAT: '%Y-%m-%d %H:%M:%S %Z',
      TZ_ALIAS: 'XYZ=GMT+3:00',
    });
    expect(source).toBe('TIME_FORMAT');
    expect(probe.match!.parsedTimeMs).toBe(extracted._time!.getTime());
    // And the alias really moved it: without one XYZ does not resolve at all.
    expect(new Date(probe.match!.parsedTimeMs!).toISOString()).toBe('2026-08-03T07:00:00.000Z');
  });

  it('reads an empty TIME_PREFIX as unset, and both sides agree (#328)', () => {
    // Doc-derived: props.conf.spec gives no meaning to an empty TIME_PREFIX, and
    // an empty setting is an unset one — as this engine already reads an empty
    // TIME_FORMAT, TZ or ROUTE_EVENTS_OLDER_THAN. The extractor used to compile
    // '' and anchor TIME_FORMAT at offset 0, so a mid-line date was missed; the
    // prober called the same '' "no prefix" and found it.
    for (const prefix of ['', '   ']) {
      const { extracted, source, probe } = both('level=info at 2026-08-03 10:00:00', {
        TIME_PREFIX: prefix,
        TIME_FORMAT: '%Y-%m-%d %H:%M:%S',
      });
      expect(source).toBe('TIME_FORMAT');
      expect(probe.prefix).toBeNull();
      expect(String(probe.match!.tsStart)).toBe(extracted.fields.timestartpos);
      expect(probe.match!.parsedTimeMs).toBe(extracted._time!.getTime());
    }
  });

  it('reports no compile error for an empty TIME_PREFIX (#328)', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractTimestamps(
      [event('2026-08-03 10:00:00 msg')],
      [
        { key: 'TIME_PREFIX', value: '', line: 1, directiveType: 'TIME_PREFIX' },
        { key: 'TIME_FORMAT', value: '%Y-%m-%d %H:%M:%S', line: 2, directiveType: 'TIME_FORMAT' },
      ],
      diagnostics,
      NOW,
    );
    expect(diagnostics.filter((d) => d.directiveKey === 'TIME_PREFIX')).toEqual([]);
  });

  it('agrees with no TIME_PREFIX, scanning the window unanchored', () => {
    const { extracted, source, probe } = both('level=info at 2026-08-03 10:00:00', {
      TIME_FORMAT: '%Y-%m-%d %H:%M:%S',
    });
    expect(source).toBe('TIME_FORMAT');
    expect(String(probe.match!.tsStart)).toBe(extracted.fields.timestartpos);
    expect(probe.match!.parsedTimeMs).toBe(extracted._time!.getTime());
  });
});

/**
 * The tab probes the text the extractor read, which is not the final `_raw`:
 * SEDCMD, DEST_KEY = _raw and INGEST_EVAL all run after timestamping. Probing
 * the final `_raw` reported "TIME_PREFIX did not match" on an event whose
 * `_time` the pipeline had read from that very prefix (#328). These run the
 * whole pipeline, so the ordering is the pipeline's and not the test's.
 */
describe('probing what the extractor read, after _raw is rewritten (#328)', () => {
  const NOW = Date.parse('2026-01-16T00:00:00.000Z');
  const METADATA = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  const PROPS = [
    '[st]',
    'SHOULD_LINEMERGE = false',
    'TIME_PREFIX = host=\\S+\\s',
    'TIME_FORMAT = %Y-%m-%d %H:%M:%S',
    'SEDCMD-mask = s/host=\\S+ //',
  ].join('\n');
  const TIME_CONFIG = config({
    timePrefix: 'host=\\S+\\s',
    timeFormat: '%Y-%m-%d %H:%M:%S',
    now: NOW,
  });

  it('records the pre-SEDCMD text on the event, and probing it agrees with _time', () => {
    const { result } = runPipeline('host=web01 2026-01-15 10:00:00 login', METADATA, PROPS, '', {
      perEventPipeline: false,
      now: NOW,
    });
    const ev = result.events[0]!;
    // The repro: SEDCMD removed the prefix after the extractor had used it.
    expect(ev._raw).toBe('2026-01-15 10:00:00 login');
    expect(ev.processingTrace.find((s) => s.processor === 'timestampExtractor')?.timeSource).toBe('TIME_FORMAT');
    expect(ev.timestampText).toBe('host=web01 2026-01-15 10:00:00 login');

    // The final _raw is what the tab used to probe — and it disagreed.
    expect(probeTimestamp(ev._raw, TIME_CONFIG).prefix).toBeNull();

    const probe = probeTimestamp(ev.timestampText!, TIME_CONFIG);
    expect(probe.match).not.toBeNull();
    expect(probe.match!.matchedText).toBe('2026-01-15 10:00:00');
    expect(probe.match!.parsedTimeMs).toBe(ev._time!.getTime());
  });

  it('records the text even when the extractor fell back, so a miss is a real miss', () => {
    const { result } = runPipeline('nohost 2026-01-15 10:00:00 login', METADATA, PROPS, '', {
      perEventPipeline: false,
      now: NOW,
    });
    const ev = result.events[0]!;
    expect(ev.timestampText).toBe('nohost 2026-01-15 10:00:00 login');
    expect(ev.processingTrace.find((s) => s.processor === 'timestampExtractor')?.timeSource).not.toBe('TIME_FORMAT');
    expect(probeTimestamp(ev.timestampText!, TIME_CONFIG).match).toBeNull();
  });
});
