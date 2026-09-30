// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins a timestamp-extraction behaviour the suite ran but never asserted:
// where exactly the sanity bounds fall, what an unusable bound falls back to,
// which zone a dateless stamp's "today" is read in, and what the trace says
// when no timestamp was read.
//
// The bounds and their defaults are props.conf.spec's; doc-derived, no capture.
import { describe, it, expect } from 'vitest';
import { extractTimestamps } from '../processors/timestampExtractor';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string): SplunkEvent {
  return makeEvent(raw);
}

function dir(key: string, value: string, line = 1): ConfDirective {
  return { key, value, line, directiveType: key };
}

const NOW = new Date('2026-08-04T00:00:00.000Z');
const FMT = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S', 5);
const step = (e: SplunkEvent) => e.processingTrace.filter((s) => s.processor === 'timestampExtractor').at(-1)!;
const iso = (e: SplunkEvent) => e._time?.toISOString() ?? null;

const run = (raws: string[], directives: ConfDirective[], diagnostics?: ValidationDiagnostic[]) =>
  extractTimestamps(raws.map(event), directives, runCtx(NOW, diagnostics));

describe('MAX_DAYS_AGO and MAX_DAYS_HENCE', () => {
  it('accept a timestamp exactly on the bound and reject one a second past it', () => {
    const d: ValidationDiagnostic[] = [];
    const [onAgo, pastAgo, onHence, pastHence] = run(
      ['2026-07-25 00:00:00', '2026-07-24 23:59:59', '2026-08-06 00:00:00', '2026-08-06 00:00:01'],
      [FMT, dir('MAX_DAYS_AGO', '10'), dir('MAX_DAYS_HENCE', '2'), dir('MAX_DIFF_SECS_AGO', '99999999'), dir('MAX_DIFF_SECS_HENCE', '99999999')],
      d,
    );
    expect(iso(onAgo!)).toBe('2026-07-25T00:00:00.000Z');
    expect(step(pastAgo!).timeSource).toBe('previous-event');
    expect(step(pastAgo!).description).toMatch(/rejected: more than MAX_DAYS_AGO \(10\) days in the past/);
    expect(iso(onHence!)).toBe('2026-08-06T00:00:00.000Z');
    expect(step(pastHence!).description).toMatch(/rejected: more than MAX_DAYS_HENCE \(2\) days in the future/);
    // Located at TIME_FORMAT, which is what to check first.
    expect(d.map((x) => [x.line, x.directiveKey])).toEqual([[5, 'TIME_FORMAT'], [5, 'TIME_FORMAT']]);
  });

  it.each(['0', '-4', 'soon'])('fall back to the default for an unusable value (%s)', (value) => {
    // 100 days ago is inside the 2000-day default and outside any bound of 0.
    const [e] = run(['2026-04-26 00:00:00'], [FMT, dir('MAX_DAYS_AGO', value)]);
    expect(iso(e!)).toBe('2026-04-26T00:00:00.000Z');
  });

  it('anchor the warning at TZ when there is no TIME_FORMAT, and name no key when there is neither', () => {
    const withTz: ValidationDiagnostic[] = [];
    run(['2020-01-01 00:00:00'], [dir('TZ', 'UTC', 7)], withTz);
    expect(withTz[0]).toMatchObject({ line: 7, directiveKey: 'TZ' });

    const bare: ValidationDiagnostic[] = [];
    run(['2020-01-01 00:00:00'], [], bare);
    expect(bare).toHaveLength(1);
    expect(bare[0]).not.toHaveProperty('directiveKey');
  });

  it('warn once per distinct reason, however many events it rejects', () => {
    const d: ValidationDiagnostic[] = [];
    run(['2020-01-01 00:00:00', '2020-01-02 00:00:00'], [FMT], d);
    expect(d).toHaveLength(1);
  });
});

describe('MAX_DIFF_SECS_AGO and MAX_DIFF_SECS_HENCE', () => {
  it('say nothing about a step exactly on the bound', () => {
    const [, e] = run(['2026-08-03 10:00:00', '2026-08-03 09:00:00'], [FMT]);
    expect(step(e!).description).toBe('Extracted timestamp: 2026-08-03T09:00:00.000Z');
  });

  it('keep a step past the bound in the majority format, and say why', () => {
    const [, e] = run(['2026-08-03 10:00:00', '2026-08-03 08:59:59'], [FMT]);
    expect(iso(e!)).toBe('2026-08-03T08:59:59.000Z');
    expect(step(e!).description).toBe(
      'Extracted timestamp: 2026-08-03T08:59:59.000Z (more than MAX_DIFF_SECS_AGO (3600s) before the previous event, ' +
        "kept because its format is the one most of this source's timestamps use)",
    );
  });

  it('measure HENCE forward from the previous event', () => {
    const [, on, past] = run(
      ['2026-08-03 10:00:00', '2026-08-03 10:00:10', '2026-08-03 10:00:21'],
      [FMT, dir('MAX_DIFF_SECS_HENCE', '10')],
    );
    expect(step(on!).description).toBe('Extracted timestamp: 2026-08-03T10:00:10.000Z');
    expect(step(past!).description).toMatch(/more than MAX_DIFF_SECS_HENCE \(10s\) after the previous event, kept/);
  });

  it('reject a step past the bound in a format most timestamps do not use', () => {
    // Auto-recognition: two ISO stamps, then a US-style date an hour and more earlier.
    const [, , odd] = run(['2026-08-03 10:00:00', '2026-08-03 10:00:01', '08/03/2026 08:00:00'], []);
    expect(step(odd!).timeSource).toBe('previous-event');
    expect(step(odd!).description).toMatch(/in a format \(%m\/%d\/%Y %H:%M:%S\) most of this source's timestamps do not use/);
  });
});

describe('what the trace says when no timestamp was read', () => {
  it.each([
    [[dir('TIME_PREFIX', 'ts=')], 'TIME_PREFIX did not match this event'],
    [[dir('TIME_FORMAT', '%Y-%m-%d')], 'TIME_FORMAT did not match this event'],
    [[], 'No recognisable timestamp in this event'],
  ])('%j', (directives, reason) => {
    const [e] = run(['no stamp here'], directives);
    expect(step(e!).description).toBe(
      `${reason}, and no previous event to inherit from — fell back to the time of indexing (2026-08-04T00:00:00.000Z)`,
    );
    expect(step(e!).timeSource).toBe('current-time');
  });

  it('inherits from the previous event and says so', () => {
    const [, e] = run(['2026-08-03 10:00:00', 'no stamp here'], [FMT]);
    expect(step(e!).description).toBe('TIME_FORMAT did not match this event — inherited 2026-08-03T10:00:00.000Z from the previous event');
  });

  it('reports a TIME_PREFIX that will not compile, as an error, and treats it as never matching', () => {
    const d: ValidationDiagnostic[] = [];
    const [e] = run(['2026-08-03 10:00:00'], [dir('TIME_PREFIX', '(unclosed', 4)], d);
    expect(d[0]).toMatchObject({ level: 'error', line: 4, directiveKey: 'TIME_PREFIX' });
    expect(d[0]!.message).toMatch(/^TIME_PREFIX \(\(unclosed\) could not be compiled: /);
    expect(step(e!).description).toMatch(/^TIME_PREFIX could not be compiled, so it never matches, and no previous event/);
  });

  it('marks the event timestamp=none and records the field', () => {
    const [e] = run(['no stamp'], []);
    expect(e!.fields['timestamp']).toBe('none');
    expect(step(e!).fieldsAdded).toEqual(['timestamp']);
  });

  it.each(['none', 'subseconds'])('writes no timestamp field under ADD_EXTRA_TIME_FIELDS = %s', (mode) => {
    const [e] = run(['no stamp'], [dir('ADD_EXTRA_TIME_FIELDS', mode)]);
    expect(e!.fields).toEqual({});
    expect(step(e!)).not.toHaveProperty('fieldsAdded');
  });
});

describe('what the trace says when a timestamp was read', () => {
  it('lists the extra fields it added', () => {
    const [e] = run(['2026-08-03 10:00:00'], [FMT]);
    expect(step(e!).fieldsAdded).toContain('date_hour');
    expect(step(e!).timeSource).toBe('TIME_FORMAT');
  });

  it('adds no fieldsAdded key when ADD_EXTRA_TIME_FIELDS writes none', () => {
    const [e] = run(['2026-08-03 10:00:00'], [FMT, dir('ADD_EXTRA_TIME_FIELDS', 'subseconds')]);
    expect(step(e!)).not.toHaveProperty('fieldsAdded');
    expect(e!.fields).toEqual({});
  });
});

describe('DATETIME_CONFIG', () => {
  it('reads CURRENT case-insensitively and with surrounding space', () => {
    const [e] = run(['2020-01-01 00:00:00'], [dir('DATETIME_CONFIG', '  current ')]);
    expect(iso(e!)).toBe('2026-08-04T00:00:00.000Z');
    expect(step(e!)).toEqual({
      processor: 'timestampExtractor',
      phase: 'index-time',
      description: 'DATETIME_CONFIG = CURRENT — _time set to the time of indexing (2026-08-04T00:00:00.000Z), not read from the event',
      timeSource: 'datetime-config-current',
      fieldsAdded: ['timestamp'],
    });
    expect(e!.fields['timestamp']).toBe('none');
  });

  it('describes NONE differently', () => {
    const [e] = run(['x'], [dir('DATETIME_CONFIG', 'NONE'), dir('ADD_EXTRA_TIME_FIELDS', 'none')]);
    expect(step(e!)).toEqual({
      processor: 'timestampExtractor',
      phase: 'index-time',
      description: 'DATETIME_CONFIG = NONE — timestamp extraction disabled, _time is the time of indexing (2026-08-04T00:00:00.000Z)',
      timeSource: 'datetime-config-none',
    });
  });
});

describe('a dateless timestamp read off the clock', () => {
  it("takes today's date in the stamp's own zone, not UTC's", () => {
    // 20:00Z is already 01:00 on the 16th at +05:00, so 00:30 +0500 is on the 16th there: 19:30Z on the 15th.
    const now = new Date('2026-01-15T20:00:00.000Z');
    const [e] = extractTimestamps(
      [event('00:30:00 +0500 x')],
      [dir('TIME_FORMAT', '%H:%M:%S %z'), dir('DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME', 'true')],
      runCtx(now),
    );
    expect(iso(e!)).toBe('2026-01-15T19:30:00.000Z');
    expect(step(e!).description).toBe(
      'Extracted timestamp: 2026-01-15T19:30:00.000Z (no date in the timestamp: date taken from the clock (DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME))',
    );
  });
});

describe('an unresolvable zone', () => {
  it('is reported once, at TZ when TZ is set', () => {
    const d: ValidationDiagnostic[] = [];
    run(['2026-08-03 10:00:00', '2026-08-03 10:00:01'], [FMT, dir('TZ', '  Nowhere/Land ', 9)], d);
    const hits = d.filter((x) => x.message.startsWith('Timezone "Nowhere/Land"'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ line: 9, directiveKey: 'TZ' });
  });
});
