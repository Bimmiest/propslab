import { describe, it, expect } from 'vitest';
import { extractTimestamps, resolveLookahead } from '../processors/timestampExtractor';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

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

const iso = (d: Date | null) => d?.toISOString() ?? null;

/**
 * A fixed stand-in for index time. The tail of the fallback chain is the time of
 * indexing, so without pinning it these assertions would drift with the clock.
 */
const NOW = new Date('2026-08-04T00:00:00.000Z');

/** The step that resolved _time, which is where the provenance lives (#85). */
const timeSource = (e: SplunkEvent) =>
  e.processingTrace.filter((s) => s.processor === 'timestampExtractor').at(-1)?.timeSource;

describe('extractTimestamps — explicit TIME_FORMAT (regression)', () => {
  it('parses with a configured TIME_FORMAT', () => {
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 some log')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('respects TIME_PREFIX', () => {
    const e = extractTimestamps(
      [event('id=5 ts=2024-01-15T10:00:00 rest')],
      [dir('TIME_FORMAT', '%Y-%m-%dT%H:%M:%S'), dir('TIME_PREFIX', 'ts=')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  // #66: with TIME_PREFIX set, the format must match immediately after the
  // prefix. A date elsewhere in the line must NOT be extracted (a broken
  // TIME_PREFIX config fails in Splunk rather than silently grabbing a mid-line
  // date), so the event falls through to the rest of the chain.
  it('does not extract a mid-line date when TIME_PREFIX does not sit before it', () => {
    const e = extractTimestamps(
      [event('ts=pending job started 2024-01-15 10:00:00')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'), dir('TIME_PREFIX', 'ts=')],
      undefined,
      NOW,
    )[0]!;
    // The mid-line date is not used. With nothing to inherit from, the chain
    // ends at index time (#85) — what matters is that it did not come from the text.
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  it('still parses when only whitespace separates the prefix from the date', () => {
    const e = extractTimestamps(
      [event('ts=  2024-01-15 10:00:00')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'), dir('TIME_PREFIX', 'ts=')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('without TIME_PREFIX, still finds a TIME_FORMAT date later in the line', () => {
    // No prefix → unanchored scan within the lookahead window (unchanged).
    const e = extractTimestamps(
      [event('log message here 2024-01-15 10:00:00')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  // SEM-9: %z must match a trailing ISO-8601 'Z' (and keep it UTC even when TZ is set).
  it('matches %z against a literal Z and stays UTC despite a configured TZ', () => {
    const e = extractTimestamps(
      [event('2024-01-15T10:00:00Z some log')],
      [dir('TIME_FORMAT', '%Y-%m-%dT%H:%M:%S%z'), dir('TZ', 'America/New_York')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });
});

describe('extractTimestamps — auto recognition (no TIME_FORMAT)', () => {
  it('recognises ISO 8601', () => {
    const e = extractTimestamps([event('2024-01-15T10:00:00 hello')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('recognises ISO 8601 with Z as UTC', () => {
    const e = extractTimestamps([event('2024-01-15T10:00:00.250Z hello')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.250Z');
  });

  it('honours a numeric zone offset', () => {
    const e = extractTimestamps([event('2024-01-15T10:00:00+05:00 hello')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-15T05:00:00.000Z');
  });

  it('recognises an Apache access-log timestamp', () => {
    const e = extractTimestamps([event('10.0.0.1 - - [15/Jan/2024:10:00:00 +0000] "GET /"')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('recognises a leading epoch (seconds)', () => {
    const e = extractTimestamps([event('1705312800 event body')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('respects TIME_PREFIX during auto recognition', () => {
    const e = extractTimestamps(
      [event('garbage 9999 when=2024-01-15T10:00:00 tail')],
      [dir('TIME_PREFIX', 'when=')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('falls back to index time when no timestamp is recognisable', () => {
    const e = extractTimestamps([event('no timestamp anywhere here')], [], undefined, NOW)[0]!;
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  // #12: position-scored recognition — the timestamp at the front of the region
  // wins over a more-specific one embedded later in the message body.
  it('prefers the earliest timestamp over a more-specific one deeper in the text', () => {
    const e = extractTimestamps([event('01/02/2024 note 2023-06-15T08:00:00 tail')], [])[0]!;
    expect(iso(e._time)).toBe('2024-01-02T00:00:00.000Z');
  });
});

// #12: out-of-range fields are a parse failure, not a silent Date rollover.
describe('extractTimestamps — range validation (#12)', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('rejects an impossible day (Feb 30) instead of rolling into March', () => {
    const e = extractTimestamps([event('2024-02-30 10:00:00 x')], [fmt], undefined, NOW)[0]!;
    // Feb 30 is a parse failure, so the text supplies no timestamp and the
    // chain falls through — it must never roll over into a neighbouring date.
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  it('rejects an out-of-range month (13)', () => {
    const e = extractTimestamps([event('2024-13-01 10:00:00 x')], [fmt], undefined, NOW)[0]!;
    // month 13 is a parse failure, so the text supplies no timestamp and the
    // chain falls through — it must never roll over into a neighbouring date.
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  it('rejects an out-of-range hour (25)', () => {
    const e = extractTimestamps([event('2024-01-15 25:00:00 x')], [fmt], undefined, NOW)[0]!;
    // hour 25 is a parse failure, so the text supplies no timestamp and the
    // chain falls through — it must never roll over into a neighbouring date.
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  it('still accepts a valid leap day', () => {
    const e = extractTimestamps([event('2024-02-29 10:00:00 x')], [fmt])[0]!;
    expect(iso(e._time)).toBe('2024-02-29T10:00:00.000Z');
  });
});

// #227: TZ_ALIAS remaps an ambiguous zone abbreviation read out of the event.
//
// Every assertion here is DOC-DERIVED, from the props.conf.spec description of
// TZ_ALIAS and its own example (`TZ_ALIAS = EST=GMT-5:00,METT=GMT+1:00`). No
// fidelity capture backs them: the fixture corpus is closed (see the fixtures
// README), so these are a reading of the documentation rather than a recording
// of Splunk, and they are kept narrow for that reason. The one place the spec
// is silent — whether the table also rewrites the stanza's own TZ — is asserted
// as "it does not", which is the reading the spec's wording ("timezone strings
// extracted from events") supports.
describe('extractTimestamps — TZ_ALIAS (#227)', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S %Z');

  it('resolves an aliased abbreviation to the offset the table names', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 EST x')],
      [fmt, dir('TZ_ALIAS', 'EST=GMT-5:00,METT=GMT+1:00')],
      diags,
    )[0]!;
    // EST aliased to GMT-5:00 → local 10:00 is 15:00 UTC.
    expect(iso(e._time)).toBe('2024-01-15T15:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('applies the alias in preference to the built-in abbreviation table', () => {
    const diags: ValidationDiagnostic[] = [];
    // EST resolves to -0500 unaided; aliasing it to Eastern Australia is the
    // disambiguation the directive exists for, and must win.
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 EST x')],
      [fmt, dir('TZ_ALIAS', 'EST=GMT+10:00')],
      diags,
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T00:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('accepts an IANA name as the target, so the offset follows DST', () => {
    const diags: ValidationDiagnostic[] = [];
    const alias = dir('TZ_ALIAS', 'XYZ=Europe/London');
    // London is GMT in January and BST in July. A fixed offset could not do
    // both, which is what makes the IANA target worth accepting.
    const winter = extractTimestamps([event('2024-01-15 10:00:00 XYZ x')], [fmt, alias], diags)[0]!;
    const summer = extractTimestamps([event('2024-07-15 10:00:00 XYZ x')], [fmt, alias], diags)[0]!;
    expect(iso(winter._time)).toBe('2024-01-15T10:00:00.000Z');
    expect(iso(summer._time)).toBe('2024-07-15T09:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('matches the event zone case-insensitively', () => {
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 est x')],
      [fmt, dir('TZ_ALIAS', 'EST=GMT-5:00')],
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T15:00:00.000Z');
  });

  it('leaves a zone the table does not name alone', () => {
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 PST x')],
      [fmt, dir('TZ_ALIAS', 'EST=GMT+10:00')],
    )[0]!;
    // PST keeps its built-in -0800: 10:00 local is 18:00 UTC.
    expect(iso(e._time)).toBe('2024-01-15T18:00:00.000Z');
  });

  it('does not rewrite the stanza TZ, only a zone read from the event', () => {
    const diags: ValidationDiagnostic[] = [];
    // No %Z in the format, so there is no event-borne zone to remap and TZ
    // stands as written.
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 x')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'), dir('TZ', 'EST'), dir('TZ_ALIAS', 'EST=GMT+10:00')],
      diags,
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T15:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('warns about a malformed pair and still applies the rest of the table', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 EST x')],
      [fmt, dir('TZ_ALIAS', 'GMT-6:00,EST=GMT-5:00')],
      diags,
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T15:00:00.000Z');
    const warning = diags.find((d) => d.directiveKey === 'TZ_ALIAS');
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('"GMT-6:00"');
  });

  it('names both halves when the alias target cannot be resolved', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 EST x')],
      [fmt, dir('TZ_ALIAS', 'EST=Middle/Earth')],
      diags,
    )[0]!;
    // Unresolvable, so UTC — the documented fallback for any zone.
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
    // Reporting only the target would name a string the operator never wrote in
    // an event; reporting only EST would hide which half is broken.
    const warning = diags.find((d) => /could not be resolved/.test(d.message));
    expect(warning?.message).toContain('EST');
    expect(warning?.message).toContain('Middle/Earth');
  });
});

// #12: an unresolvable timezone is treated as UTC but now warns instead of
// drifting silently.
describe('extractTimestamps — timezone resolution (#12)', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('warns when the TZ cannot be resolved and falls back to UTC', () => {
    // A name no time-zone database has. Europe/London used to stand in for this
    // case, but IANA names resolve for real now (#159), so only a genuinely
    // unknown zone still exercises the fallback.
    const diags: ValidationDiagnostic[] = [];
    const e = extractTimestamps([event('2024-01-15 10:00:00 x')], [fmt, dir('TZ', 'Middle/Earth')], diags)[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
    expect(diags.some((d) => d.level === 'warning' && /Middle\/Earth/.test(d.message))).toBe(true);
  });

  it('resolves an IANA zone name against its real offset, without warning (#159)', () => {
    const diags: ValidationDiagnostic[] = [];
    // London is BST (+01:00) in July, so 10:00 local is 09:00Z.
    const e = extractTimestamps([event('2024-07-15 10:00:00 x')], [fmt, dir('TZ', 'Europe/London')], diags)[0]!;
    expect(iso(e._time)).toBe('2024-07-15T09:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('does not warn for a resolvable numeric TZ offset', () => {
    const diags: ValidationDiagnostic[] = [];
    const e = extractTimestamps([event('2024-01-15 10:00:00 x')], [fmt, dir('TZ', '-0500')], diags)[0]!;
    // TZ=-0500 → local 10:00 is 15:00 UTC.
    expect(iso(e._time)).toBe('2024-01-15T15:00:00.000Z');
    expect(diags).toHaveLength(0);
  });

  it('warns only once for the same unresolved TZ across many events', () => {
    const diags: ValidationDiagnostic[] = [];
    extractTimestamps(
      [event('2024-01-15 10:00:00 a'), event('2024-01-16 11:00:00 b')],
      [fmt, dir('TZ', 'Middle/Earth')],
      diags,
    );
    expect(diags.filter((d) => /Middle\/Earth/.test(d.message))).toHaveLength(1);
  });
});

describe('#163 — an event with no timestamp inherits the previous one', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('inherits from the preceding event', () => {
    const out = extractTimestamps(
      [event('2024-01-15 10:00:00 first'), event('continuation with no date')],
      [fmt],
    );
    expect(iso(out[0]!._time)).toBe('2024-01-15T10:00:00.000Z');
    expect(iso(out[1]!._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('falls back to index time when there is nothing to inherit from', () => {
    const out = extractTimestamps(
      [event('no date here'), event('2024-01-15 10:00:00 later')],
      [fmt],
      undefined,
      NOW,
    );
    // Splunk always places an event on the timeline; the trace is what says the
    // value was not read from the event (#85).
    expect(iso(out[0]!._time)).toBe(NOW.toISOString());
    expect(timeSource(out[0]!)).toBe('current-time');
    expect(iso(out[1]!._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('inherits the most recent resolved time, not the first of the batch', () => {
    const out = extractTimestamps(
      [event('2024-01-15 10:00:00 a'), event('2024-01-16 11:00:00 b'), event('no date')],
      [fmt],
    );
    expect(iso(out[2]!._time)).toBe('2024-01-16T11:00:00.000Z');
  });

  it('inherits when TIME_PREFIX does not match at all', () => {
    const out = extractTimestamps(
      [event('ts=2024-01-15 10:00:00 a'), event('no prefix on this line')],
      [fmt, dir('TIME_PREFIX', 'ts=')],
    );
    expect(iso(out[1]!._time)).toBe('2024-01-15T10:00:00.000Z');
  });

  it('records the inheritance in the trace rather than implying extraction', () => {
    const out = extractTimestamps([event('2024-01-15 10:00:00 a'), event('no date')], [fmt]);
    const step = out[1]!.processingTrace.at(-1);
    expect(step?.description).toContain('inherited');
  });
});

describe('#85 — DATETIME_CONFIG', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('CURRENT stamps index time and ignores the date in the event', () => {
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 has a perfectly good date')],
      [fmt, dir('DATETIME_CONFIG', 'CURRENT')],
      undefined,
      NOW,
    )[0]!;
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('datetime-config-current');
  });

  it('NONE disables extraction and says so distinctly', () => {
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 has a perfectly good date')],
      [fmt, dir('DATETIME_CONFIG', 'NONE')],
      undefined,
      NOW,
    )[0]!;
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('datetime-config-none');
  });

  it('is case-insensitive, as conf values are', () => {
    const e = extractTimestamps([event('x')], [dir('DATETIME_CONFIG', 'current')], undefined, NOW)[0]!;
    expect(timeSource(e)).toBe('datetime-config-current');
  });

  it('leaves extraction alone when it names a datetime.xml file', () => {
    // That file is unreachable from a browser, so the normal path runs and the
    // directive keeps its declared limitation rather than silently meaning CURRENT.
    const e = extractTimestamps(
      [event('2024-01-15 10:00:00 x')],
      [fmt, dir('DATETIME_CONFIG', '/etc/apps/my_app/datetime.xml')],
      undefined,
      NOW,
    )[0]!;
    expect(iso(e._time)).toBe('2024-01-15T10:00:00.000Z');
    expect(timeSource(e)).toBe('TIME_FORMAT');
  });
});

describe('#85 — timestamp sanity bounds', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('accepts a timestamp inside the default bounds', () => {
    const e = extractTimestamps([event('2026-08-03 10:00:00 x')], [fmt], undefined, NOW)[0]!;
    expect(iso(e._time)).toBe('2026-08-03T10:00:00.000Z');
    expect(timeSource(e)).toBe('TIME_FORMAT');
  });

  it('rejects a timestamp further back than MAX_DAYS_AGO', () => {
    const e = extractTimestamps(
      [event('2026-07-01 10:00:00 x')],
      [fmt, dir('MAX_DAYS_AGO', '7')],
      undefined,
      NOW,
    )[0]!;
    expect(iso(e._time)).toBe(NOW.toISOString());
    expect(timeSource(e)).toBe('current-time');
  });

  it('rejects a timestamp further ahead than MAX_DAYS_HENCE', () => {
    // Default MAX_DAYS_HENCE is 2 days, so a date a year out is refused.
    const e = extractTimestamps([event('2027-08-04 10:00:00 x')], [fmt], undefined, NOW)[0]!;
    expect(timeSource(e)).toBe('current-time');
  });

  it('falls back to the previous event rather than the clock when there is one', () => {
    const out = extractTimestamps(
      [event('2026-08-03 10:00:00 good'), event('2027-08-04 10:00:00 way out')],
      [fmt],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-03T10:00:00.000Z');
    expect(timeSource(out[1]!)).toBe('previous-event');
  });

  // This used to assert the jump was rejected. props.conf.spec says an event
  // beyond MAX_DIFF_SECS_AGO is accepted "only if it has the same exact time
  // format as the majority of timestamps from the source" — and under an
  // explicit TIME_FORMAT every timestamp has that format, so it is kept (#286).
  // Doc-derived; no fixture covers it.
  it('keeps a jump backwards beyond MAX_DIFF_SECS_AGO when it is in the TIME_FORMAT', () => {
    const out = extractTimestamps(
      [event('2026-08-03 10:00:00 first'), event('2026-08-03 08:00:00 two hours earlier')],
      [fmt, dir('MAX_DIFF_SECS_AGO', '3600')],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-03T08:00:00.000Z');
    expect(timeSource(out[1]!)).toBe('TIME_FORMAT');
    expect(out[1]!.processingTrace.at(-1)?.description).toContain('MAX_DIFF_SECS_AGO');
  });

  it('keeps newest-first logs in their own times (#286)', () => {
    const out = extractTimestamps(
      [
        event('2026-08-03 12:00:00 c'),
        event('2026-08-03 09:00:00 b'),
        event('2026-08-03 06:00:00 a'),
      ],
      [fmt],
      undefined,
      NOW,
    );
    expect(out.map((e) => iso(e._time))).toEqual([
      '2026-08-03T12:00:00.000Z',
      '2026-08-03T09:00:00.000Z',
      '2026-08-03T06:00:00.000Z',
    ]);
  });

  // Doc-derived (#286). Without TIME_FORMAT the "majority format" is judged over
  // the events accepted so far in the sample: a backwards jump in the format the
  // file has been using is kept, one in a different shape is the false match
  // the bound exists for, and is refused.
  it('under auto-recognition, keeps a backwards jump in the majority format', () => {
    const out = extractTimestamps(
      [event('2026-08-03T12:00:00 a'), event('2026-08-03T11:59:00 b'), event('2026-08-03T06:00:00 c')],
      [],
      undefined,
      NOW,
    );
    expect(iso(out[2]!._time)).toBe('2026-08-03T06:00:00.000Z');
    expect(timeSource(out[2]!)).toBe('auto-recognition');
  });

  it('under auto-recognition, rejects a backwards jump in a minority format', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = extractTimestamps(
      [event('2026-08-03T12:00:00 a'), event('2026-08-03T11:59:00 b'), event('08/01/2026 06:00:00 c')],
      [],
      diagnostics,
      NOW,
    );
    expect(iso(out[2]!._time)).toBe('2026-08-03T11:59:00.000Z');
    expect(timeSource(out[2]!)).toBe('previous-event');
    expect(diagnostics.some((d) => d.message.includes('MAX_DIFF_SECS_AGO') && d.message.includes('%m/%d/%Y'))).toBe(true);
  });

  it('allows a backwards jump within MAX_DIFF_SECS_AGO', () => {
    const out = extractTimestamps(
      [event('2026-08-03 10:00:00 first'), event('2026-08-03 09:30:00 half an hour earlier')],
      [fmt, dir('MAX_DIFF_SECS_AGO', '3600')],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-03T09:30:00.000Z');
    expect(timeSource(out[1]!)).toBe('TIME_FORMAT');
  });

  it('warns once per reason rather than once per event', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractTimestamps(
      [event('2027-08-04 10:00:00 a'), event('2027-08-05 10:00:00 b'), event('2027-08-06 10:00:00 c')],
      [fmt],
      diagnostics,
      NOW,
    );
    const bounds = diagnostics.filter((d) => d.message.includes('MAX_DAYS_HENCE'));
    expect(bounds).toHaveLength(1);
    expect(bounds[0]?.level).toBe('warning');
  });

  it('names the bound that rejected the timestamp in the trace', () => {
    const e = extractTimestamps([event('2027-08-04 10:00:00 x')], [fmt], undefined, NOW)[0]!;
    const step = e.processingTrace.at(-1);
    expect(step?.description).toContain('MAX_DAYS_HENCE');
    expect(step?.description).toContain('rejected');
  });

  it('an out-of-bounds timestamp does not become the baseline for the next event', () => {
    // If the rejected value were recorded, the following event would be
    // measured against a time Splunk never accepted.
    const out = extractTimestamps(
      [event('2026-08-03 10:00:00 good'), event('2027-08-04 10:00:00 rejected'), event('no date')],
      [fmt],
      undefined,
      NOW,
    );
    expect(iso(out[2]!._time)).toBe('2026-08-03T10:00:00.000Z');
  });
});

describe('#85 — MAX_DIFF_SECS_HENCE', () => {
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  // Previously asserted a rejection; corrected by the spec's same-format
  // exemption, which it words identically for HENCE and AGO (#286). Doc-derived.
  it('keeps a jump forwards beyond MAX_DIFF_SECS_HENCE when it is in the TIME_FORMAT', () => {
    // Three days after the previous event, but still inside MAX_DAYS_HENCE — so
    // this isolates the previous-event bound from the wall-clock one.
    const out = extractTimestamps(
      [event('2026-08-01 10:00:00 first'), event('2026-08-04 09:00:00 three days later')],
      [fmt, dir('MAX_DIFF_SECS_HENCE', '3600')],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-04T09:00:00.000Z');
    expect(timeSource(out[1]!)).toBe('TIME_FORMAT');
  });

  it('under auto-recognition, rejects a forward jump in a minority format', () => {
    const out = extractTimestamps(
      [event('2026-08-01T10:00:00 first'), event('08/03/2026 09:00:00 two days later')],
      [dir('MAX_DIFF_SECS_HENCE', '3600')],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-01T10:00:00.000Z');
    expect(timeSource(out[1]!)).toBe('previous-event');
  });

  it('allows a forwards jump within MAX_DIFF_SECS_HENCE', () => {
    const out = extractTimestamps(
      [event('2026-08-01 10:00:00 first'), event('2026-08-01 10:30:00 half an hour later')],
      [fmt, dir('MAX_DIFF_SECS_HENCE', '3600')],
      undefined,
      NOW,
    );
    expect(iso(out[1]!._time)).toBe('2026-08-01T10:30:00.000Z');
    expect(timeSource(out[1]!)).toBe('TIME_FORMAT');
  });
});

describe('#286 — MAX_TIMESTAMP_LOOKAHEAD = 0 / -1 disables the limit', () => {
  // Doc-derived: props.conf.spec says 0 or -1 disables the length constraint.
  // Both used to fall back to the 128-character default.
  const raw = `${'x'.repeat(200)} 2026-08-03 10:00:00`;
  const fmt = dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S');

  it('does not find a deep timestamp under the default', () => {
    const e = extractTimestamps([event(raw)], [fmt], undefined, NOW)[0]!;
    expect(timeSource(e)).toBe('current-time');
  });

  for (const value of ['0', '-1']) {
    it(`finds it with MAX_TIMESTAMP_LOOKAHEAD = ${value}`, () => {
      const e = extractTimestamps([event(raw)], [fmt, dir('MAX_TIMESTAMP_LOOKAHEAD', value)], undefined, NOW)[0]!;
      expect(iso(e._time)).toBe('2026-08-03T10:00:00.000Z');
    });
  }

  it('still falls back to 128 for a value that is not a usable count', () => {
    expect(resolveLookahead('-5')).toBe(128);
    expect(resolveLookahead('abc')).toBe(128);
    expect(resolveLookahead(undefined)).toBe(128);
    expect(resolveLookahead(' 64 ')).toBe(64);
  });
});

describe('#286 — a TIME_PREFIX that does not compile', () => {
  // Doc-derived: TIME_PREFIX "cannot be found" means no timestamp is extracted.
  // A prefix that cannot even be compiled used to be dropped and the scan began
  // at offset 0, reading a timestamp from exactly where the prefix said not to.
  it('is treated as never matching, and reported as an error', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = extractTimestamps(
      [event('2026-08-03 10:00:00 a'), event('2026-08-03 10:00:01 b')],
      [dir('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'), dir('TIME_PREFIX', 'ts=(')],
      diagnostics,
      NOW,
    );
    expect(out.map(timeSource)).toEqual(['current-time', 'current-time']);
    const errors = diagnostics.filter((d) => d.directiveKey === 'TIME_PREFIX');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.level).toBe('error');
    expect(errors[0]?.message).toContain('ts=(');
  });

  it('names the ReDoS guard when that is what refused it', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractTimestamps([event('x')], [dir('TIME_PREFIX', '(a+)+')], diagnostics, NOW);
    expect(diagnostics.find((d) => d.directiveKey === 'TIME_PREFIX')?.message).toMatch(/ReDoS/);
  });
});
