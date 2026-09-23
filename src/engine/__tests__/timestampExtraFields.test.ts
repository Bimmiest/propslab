// ---------------------------------------------------------------------------
// timestampExtraFields.test.ts
// ADD_EXTRA_TIME_FIELDS and DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME (#273).
//
// Doc-derived throughout. The modes and the dateless-date rules are read from
// props.conf.spec 10.4.3 (as summarised in the registry descriptions); the
// field values follow Splunk's documented default-field conventions. No capture
// pins any of it: the fidelity capture excluded every date_* / timestartpos /
// timeendpos / timestamp field (see fixtures/splunk-10.4.0/manifest.json), and
// no captured case has a dateless timestamp. Assertions are kept to what those
// documents actually state.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import {
  extractTimestamps,
  resolveExtraTimeFields,
  EXTRA_TIME_FIELD_NAMES,
} from '../processors/timestampExtractor';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective } from '../types';

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

function dir(key: string, value: string): ConfDirective {
  return { key, value, line: 1, directiveType: key };
}

const NOW = new Date('2026-08-04T00:30:00.000Z');

function run(raws: string[], directives: ConfDirective[], now: Date = NOW): SplunkEvent[] {
  return extractTimestamps(raws.map(event), directives, [], now);
}

/** Only the fields ADD_EXTRA_TIME_FIELDS governs. */
function timeFields(e: SplunkEvent | undefined): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const name of EXTRA_TIME_FIELD_NAMES) {
    const v = e?.fields[name];
    if (v !== undefined) out[name] = v;
  }
  return out;
}

describe('ADD_EXTRA_TIME_FIELDS (#273)', () => {
  const FORMAT = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('writes the date_* and position fields by default', () => {
    // 2024-01-15 is a Monday. Values are unpadded numbers and lower-case full
    // names; with no zone in the stamp and no TZ, date_zone is `local`.
    const [e] = run(['2024-01-15 09:05:03 hello'], [FORMAT]);
    expect(timeFields(e)).toEqual({
      date_hour: '9',
      date_mday: '15',
      date_minute: '5',
      date_month: 'january',
      date_second: '3',
      date_wday: 'monday',
      date_year: '2024',
      date_zone: 'local',
      timestartpos: '0',
      timeendpos: '19',
    });
  });

  it('lists them as added by the timestamp step, at index time', () => {
    const [e] = run(['2024-01-15 09:05:03 hello'], [FORMAT]);
    const step = e?.processingTrace.find((s) => s.processor === 'timestampExtractor');
    expect(step?.phase).toBe('index-time');
    expect(step?.fieldsAdded).toContain('date_hour');
    expect(step?.fieldsAdded).toContain('timestartpos');
  });

  it('describes the wall clock as written, and the zone as minutes from UTC', () => {
    // 10:05 at -05:00 is 15:05 UTC; date_hour is the 10 the event says.
    const [e] = run(['2024-01-15T10:05:03-0500 x'], [dir('TIME_FORMAT', '%Y-%m-%dT%H:%M:%S%z')]);
    expect(e?._time?.toISOString()).toBe('2024-01-15T15:05:03.000Z');
    expect(e?.fields.date_hour).toBe('10');
    expect(e?.fields.date_zone).toBe('-300');
  });

  it('takes the zone from TZ when the stamp has none', () => {
    const [winter] = run(['2024-01-15 10:00:00 x'], [FORMAT, dir('TZ', 'America/New_York')]);
    const [summer] = run(['2024-07-15 10:00:00 x'], [FORMAT, dir('TZ', 'America/New_York')]);
    expect(winter?.fields.date_zone).toBe('-300');
    expect(summer?.fields.date_zone).toBe('-240');
    expect(summer?.fields.date_hour).toBe('10');
  });

  it('measures timestartpos / timeendpos in _raw, past a TIME_PREFIX', () => {
    const raw = 'id=5 ts=2024-01-15 10:00:00 rest';
    const [e] = run([raw], [FORMAT, dir('TIME_PREFIX', 'ts=')]);
    expect(e?.fields.timestartpos).toBe('8');
    expect(e?.fields.timeendpos).toBe('27');
    expect(raw.slice(8, 27)).toBe('2024-01-15 10:00:00');
  });

  it('measures the positions of an auto-recognised timestamp too', () => {
    const raw = 'host a: 2024-01-15 10:00:00 msg';
    const [e] = run([raw], []);
    expect(raw.slice(Number(e?.fields.timestartpos), Number(e?.fields.timeendpos))).toBe('2024-01-15 10:00:00');
  });

  it('gives an epoch timestamp a zone of 0', () => {
    const [e] = run(['1705312800 msg'], []);
    expect(e?.fields.date_zone).toBe('0');
    expect(e?.fields.date_hour).toBe('10');
  });

  it('marks an event whose _time was not read from its text with timestamp=none, and no date_*', () => {
    const [e] = run(['no timestamp here'], [FORMAT]);
    expect(timeFields(e)).toEqual({ timestamp: 'none' });
  });

  it('marks DATETIME_CONFIG = CURRENT events with timestamp=none', () => {
    const [e] = run(['2024-01-15 10:00:00 x'], [dir('DATETIME_CONFIG', 'CURRENT')]);
    expect(timeFields(e)).toEqual({ timestamp: 'none' });
  });

  it('"subseconds" drops the fields but keeps the sub-second part of _time', () => {
    const directives = [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S.%3N'), dir('ADD_EXTRA_TIME_FIELDS', 'subseconds')];
    const [found, missing] = run(['2024-01-15 10:00:00.250 x', 'none'], directives);
    expect(timeFields(found)).toEqual({});
    expect(timeFields(missing)).toEqual({});
    expect(found?._time?.toISOString()).toBe('2024-01-15T10:00:00.250Z');
  });

  it('"none" drops the fields and the sub-seconds, leaving _time to the second', () => {
    const directives = [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S.%3N'), dir('ADD_EXTRA_TIME_FIELDS', 'none')];
    const [e] = run(['2024-01-15 10:00:00.250 x'], directives);
    expect(timeFields(e)).toEqual({});
    expect(e?._time?.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });

  it('reads false as none and true as all', () => {
    expect(resolveExtraTimeFields('false')).toBe('none');
    expect(resolveExtraTimeFields(' None ')).toBe('none');
    expect(resolveExtraTimeFields('true')).toBe('all');
    expect(resolveExtraTimeFields('all')).toBe('all');
    expect(resolveExtraTimeFields(undefined)).toBe('all');
    expect(resolveExtraTimeFields('SUBSECONDS')).toBe('subseconds');
  });

  it('reaches the pipeline output', () => {
    const { result } = runPipeline(
      '2024-01-15 10:00:00 hello',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nSHOULD_LINEMERGE = false\nTIME_FORMAT = %Y-%m-%d %H:%M:%S\n',
      '',
      { perEventPipeline: false, now: NOW.getTime() },
    );
    expect(result.events[0]?.fields.date_month).toBe('january');
  });
});

describe('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME (#273)', () => {
  const TIME_ONLY = dir('TIME_FORMAT', '%H:%M:%S');

  it('no longer puts a dateless timestamp on 1 January', () => {
    const [e] = run(['00:10:00 x'], [TIME_ONLY]);
    expect(e?._time?.toISOString()).toBe('2026-08-04T00:10:00.000Z');
  });

  // NOW is 00:30. A stamp of 23:00 read as today would be 22.5 hours ahead of
  // the clock, so it is yesterday's. The next line, 01:00, is what tells the two
  // strategies apart: carried forward it stays on yesterday's date; read off the
  // clock it is today, half an hour ahead.
  const RAWS = ['23:00:00 late', '01:00:00 early'];

  it('by default carries the date forward from the last timestamp that parsed', () => {
    const out = run(RAWS, [TIME_ONLY]);
    expect(out.map((e) => e._time?.toISOString())).toEqual([
      '2026-08-03T23:00:00.000Z',
      '2026-08-03T01:00:00.000Z',
    ]);
  });

  it('when true, takes each date from the clock: today, or yesterday if 3h or more ahead', () => {
    const out = run(RAWS, [TIME_ONLY, dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true')]);
    expect(out.map((e) => e._time?.toISOString())).toEqual([
      '2026-08-03T23:00:00.000Z',
      '2026-08-04T01:00:00.000Z',
    ]);
  });

  // `on` is the one Splunk true spelling this reader missed before the shared
  // parser (#301); the rest it already accepted.
  it.each(['on', 'yes', '1'])('reads %j as true, like every other boolean', (v) => {
    const out = run(RAWS, [TIME_ONLY, dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', v)]);
    expect(out[1]?._time?.toISOString()).toBe('2026-08-04T01:00:00.000Z');
  });

  it('treats a stamp just under three hours ahead as today', () => {
    const [e] = run(['03:29:59 x'], [TIME_ONLY, dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true')]);
    expect(e?._time?.toISOString()).toBe('2026-08-04T03:29:59.000Z');
    const [f] = run(['03:30:00 x'], [TIME_ONLY, dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true')]);
    expect(f?._time?.toISOString()).toBe('2026-08-03T03:30:00.000Z');
  });

  it('reads "today" in the stamp\'s own zone', () => {
    // 03:00 UTC is 22:00 on the 3rd at -05:00, so 21:00 there is the 3rd too.
    const [e] = run(
      ['21:00:00 x'],
      [TIME_ONLY, dir('TZ', '-0500'), dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true')],
      new Date('2026-08-04T03:00:00Z'),
    );
    expect(e?._time?.toISOString()).toBe('2026-08-04T02:00:00.000Z');
    expect(e?.fields.date_mday).toBe('3');
  });

  it('says in the trace where the date came from', () => {
    const [, second] = run(RAWS, [TIME_ONLY]);
    const step = second?.processingTrace.find((s) => s.processor === 'timestampExtractor');
    expect(step?.description).toContain('previous timestamp');
  });

  it('leaves a timestamp that has a date alone', () => {
    const out = run(['2024-01-15 10:00:00 x'], [
      dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'),
      dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true'),
      dir('MAX_DAYS_AGO', '10000'),
    ]);
    expect(out[0]?._time?.toISOString()).toBe('2024-01-15T10:00:00.000Z');
  });
});
