import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { formatStrftime, parseTimestamp, parseTzAlias, strftimeToRegex, supportedSpecifiers } from '../strftime';

/** Helper: ISO string of a parsed timestamp, or null. */
function iso(text: string, format: string, tz?: string): string | null {
  const d = parseTimestamp(text, format, tz);
  return d ? d.toISOString() : null;
}

describe('strftime — baseline directives (regression)', () => {
  it('parses a full ISO-8601 timestamp with milliseconds', () => {
    expect(iso('2024-01-15T10:00:00.123', '%Y-%m-%dT%H:%M:%S.%3N'))
      .toBe('2024-01-15T10:00:00.123Z');
  });

  it('parses month abbreviations', () => {
    expect(iso('Jan 15 2024 10:00:00', '%b %d %Y %H:%M:%S'))
      .toBe('2024-01-15T10:00:00.000Z');
  });

  it('applies a numeric %z offset', () => {
    expect(iso('2024-01-15T10:00:00+05:30', '%Y-%m-%dT%H:%M:%S%z'))
      .toBe('2024-01-15T04:30:00.000Z');
  });

  it('reads a four-digit year below 100 as written, not as 19xx (#371)', () => {
    expect(iso('0050-06-01 12:00:00', '%Y-%m-%d %H:%M:%S')).toBe('0050-06-01T12:00:00.000Z');
  });

  it('rejects out-of-range components', () => {
    expect(parseTimestamp('2024-13-15 10:00:00', '%Y-%m-%d %H:%M:%S')).toBeNull();
    expect(parseTimestamp('2024-01-32 10:00:00', '%Y-%m-%d %H:%M:%S')).toBeNull();
  });

  it('expands the %T and %F composites', () => {
    expect(iso('2024-01-15 10:00:00', '%F %T')).toBe('2024-01-15T10:00:00.000Z');
  });
});

describe('#69.1 — Splunk enhanced-strptime specifiers', () => {
  it('supports %:z (offset with a colon)', () => {
    expect(iso('2024-01-02T03:04:05+05:30', '%Y-%m-%dT%H:%M:%S%:z'))
      .toBe('2024-01-01T21:34:05.000Z');
  });

  it('supports %::z (offset with seconds)', () => {
    expect(iso('2024-01-02T03:04:05+05:30:00', '%Y-%m-%dT%H:%M:%S%::z'))
      .toBe('2024-01-01T21:34:05.000Z');
  });

  it('supports bare %N as %9N (nanoseconds)', () => {
    expect(iso('2024-01-15T10:00:00.123456789', '%Y-%m-%dT%H:%M:%S.%N'))
      .toBe('2024-01-15T10:00:00.123Z');
  });

  it('supports the %Q subsecond family with %s', () => {
    // 1712345678 seconds + 123 ms
    expect(parseTimestamp('1712345678123', '%s%3Q')?.getTime()).toBe(1712345678123);
    // bare %Q == %3Q
    expect(parseTimestamp('1712345678123', '%s%Q')?.getTime()).toBe(1712345678123);
  });
});

describe('#69.2 — %s must not discard captured subseconds', () => {
  it('folds %3N milliseconds into an epoch-seconds timestamp', () => {
    expect(parseTimestamp('1712345678123', '%s%3N')?.getTime()).toBe(1712345678123);
  });

  it('folds %6N microseconds (floored to ms) into %s', () => {
    // 1712345678 s + 456789 us -> +456 ms
    expect(parseTimestamp('1712345678456789', '%s%6N')?.getTime()).toBe(1712345678456);
  });
});

describe('#69.3 — numeric directives accept 1-2 unpadded digits', () => {
  it('parses US-style unpadded dates and times', () => {
    expect(iso('1/5/2024 3:04:05', '%m/%d/%Y %H:%M:%S'))
      .toBe('2024-01-05T03:04:05.000Z');
  });

  it('still parses zero-padded values', () => {
    expect(iso('01/05/2024 03:04:05', '%m/%d/%Y %H:%M:%S'))
      .toBe('2024-01-05T03:04:05.000Z');
  });
});

describe('#69.4 — %y century pivot (POSIX)', () => {
  it('maps 69 to 1969', () => {
    expect(iso('69-01-02', '%y-%m-%d')).toBe('1969-01-02T00:00:00.000Z');
  });

  it('maps 68 to 2068', () => {
    expect(iso('68-01-02', '%y-%m-%d')).toBe('2068-01-02T00:00:00.000Z');
  });

  it('maps 70 to 1970', () => {
    expect(iso('70-01-02', '%y-%m-%d')).toBe('1970-01-02T00:00:00.000Z');
  });
});

describe('#69.5 — %%T must not corrupt into %H handling', () => {
  it('treats %%T as a literal percent followed by T', () => {
    expect(strftimeToRegex('%%T').source).toBe('%T');
  });

  it('matches a literal "%T" in the text', () => {
    expect(iso('2024-01-15%T', '%Y-%m-%d%%T')).toBe('2024-01-15T00:00:00.000Z');
  });

  it('still expands a standalone %T', () => {
    expect(strftimeToRegex('%T').source).toBe('(\\d{1,2}):(\\d{1,2}):(\\d{1,2})');
  });
});

describe('#159 — IANA zone names resolve against real zone data', () => {
  const FMT = '%Y-%m-%d %H:%M:%S';

  it('applies a named zone rather than assuming UTC', () => {
    // The fidelity capture: 10:00 in New York in January is 15:00Z.
    expect(iso('2026-01-15 10:00:00', FMT, 'America/New_York')).toBe('2026-01-15T15:00:00.000Z');
  });

  it('uses the offset in force on the event date, not a fixed one', () => {
    // Same zone, same wall clock, six months apart: EST is -05:00 and EDT is
    // -04:00. A fixed-offset table cannot produce both, which is the whole
    // reason zone names need real data.
    expect(iso('2026-01-15 12:00:00', FMT, 'America/New_York')).toBe('2026-01-15T17:00:00.000Z');
    expect(iso('2026-07-15 12:00:00', FMT, 'America/New_York')).toBe('2026-07-15T16:00:00.000Z');
  });

  it('handles zones on a non-hour offset', () => {
    expect(iso('2026-01-15 12:00:00', FMT, 'Asia/Kolkata')).toBe('2026-01-15T06:30:00.000Z');
    expect(iso('2026-01-15 12:00:00', FMT, 'Australia/Adelaide')).toBe('2026-01-15T01:30:00.000Z');
  });

  it('handles a southern-hemisphere zone, where the DST sense is inverted', () => {
    // Sydney is +11:00 in January and +10:00 in July -- the opposite way round
    // from New York, so a hemisphere-blind fix would get one of them wrong.
    expect(iso('2026-01-15 12:00:00', FMT, 'Australia/Sydney')).toBe('2026-01-15T01:00:00.000Z');
    expect(iso('2026-07-15 12:00:00', FMT, 'Australia/Sydney')).toBe('2026-07-15T02:00:00.000Z');
  });

  it('resolves a wall clock an hour either side of a spring-forward transition', () => {
    // US DST begins 2026-03-08 02:00 local. 01:30 is still EST (-05:00) and
    // 03:30 is already EDT (-04:00) -- the pair that a single-pass offset guess
    // gets wrong, because the guess is taken at the wrong instant.
    expect(iso('2026-03-08 01:30:00', FMT, 'America/New_York')).toBe('2026-03-08T06:30:00.000Z');
    expect(iso('2026-03-08 03:30:00', FMT, 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
  });

  it('resolves an ambiguous fall-back wall clock to its first occurrence', () => {
    // US DST ends 2026-11-01 02:00 local, so 01:30 happens twice. The first is
    // EDT (-04:00) at 05:30Z; the second is EST (-05:00) at 06:30Z.
    expect(iso('2026-11-01 01:30:00', FMT, 'America/New_York')).toBe('2026-11-01T05:30:00.000Z');
  });

  it('resolves a spring-forward gap forward west of UTC as well as east', () => {
    // 02:30 does not exist on either day; it reads at the offset before the
    // gap, landing on 03:30 after it. Resolution used to depend on the zone
    // being east of UTC, putting New York's 02:30 at 01:30 EST. Convention-
    // derived (the strptime/Temporal "compatible" reading); no capture covers DST.
    expect(iso('2026-03-08 02:30:00', FMT, 'America/New_York')).toBe('2026-03-08T07:30:00.000Z');
    expect(iso('2026-03-29 02:30:00', FMT, 'Europe/Berlin')).toBe('2026-03-29T01:30:00.000Z');
  });

  it('resolves a fall-back overlap to its first occurrence east of UTC as well as west', () => {
    // Berlin's 02:30 on 2026-10-25 is 00:30Z in CEST, then 01:30Z in CET.
    expect(iso('2026-10-25 02:30:00', FMT, 'Europe/Berlin')).toBe('2026-10-25T00:30:00.000Z');
    // Southern hemisphere: Sydney leaves AEDT on 2026-04-05 at 03:00.
    expect(iso('2026-04-05 02:30:00', FMT, 'Australia/Sydney')).toBe('2026-04-04T15:30:00.000Z');
  });

  it('still prefers an explicit offset in the event over the stanza zone', () => {
    expect(iso('2026-01-15 10:00:00 +0900', `${FMT} %z`, 'America/New_York')).toBe(
      '2026-01-15T01:00:00.000Z',
    );
  });

  it('treats an unresolvable zone as UTC and reports it', () => {
    const seen: string[] = [];
    const d = parseTimestamp('2026-01-15 10:00:00', FMT, 'Mars/Olympus_Mons', (v) => seen.push(v));
    expect(d?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
    expect(seen).toEqual(['Mars/Olympus_Mons']);
  });

  it('does not report a zone it could resolve', () => {
    const seen: string[] = [];
    parseTimestamp('2026-01-15 10:00:00', FMT, 'Europe/London', (v) => seen.push(v));
    expect(seen).toEqual([]);
  });
});

// The zone-spec forms TZ_ALIAS targets are written in, and the table that
// parses them. Doc-derived from props.conf.spec's own `EST=GMT-5:00` example.
describe('strftime — GMT-relative zone specs (#227)', () => {
  const FMT = '%Y-%m-%d %H:%M:%S';

  it('reads GMT-5:00 as UTC-5, the sign meaning Splunk\'s example relies on', () => {
    expect(iso('2026-01-15 10:00:00', FMT, 'GMT-5:00')).toBe('2026-01-15T15:00:00.000Z');
  });

  it('accepts the single-digit, colonless and UTC-prefixed spellings alike', () => {
    expect(iso('2026-01-15 10:00:00', FMT, 'GMT-5')).toBe('2026-01-15T15:00:00.000Z');
    expect(iso('2026-01-15 10:00:00', FMT, 'GMT-0500')).toBe('2026-01-15T15:00:00.000Z');
    expect(iso('2026-01-15 10:00:00', FMT, 'UTC+1:00')).toBe('2026-01-15T09:00:00.000Z');
  });

  it('reads a GMT-relative zone with minutes out of the event through %Z', () => {
    // %Z stopped at the colon, reading `GMT+05` and dropping the half hour.
    expect(iso('2026-01-15 10:00:00 GMT+05:30', `${FMT} %Z`)).toBe('2026-01-15T04:30:00.000Z');
    // A colon with no minutes after it is not part of the zone.
    expect(iso('2026-01-15 10:00:00 PST: started', `${FMT} %Z`)).toBe('2026-01-15T18:00:00.000Z');
  });

  it('leaves Etc/GMT-5 to IANA, where the sign is inverted', () => {
    // The trap this pins: `GMT-5` is UTC-5, but the IANA zone `Etc/GMT-5` is
    // UTC+5 — the POSIX convention, which the tz database kept and which reads
    // backwards to everyone who meets it. The two must not be conflated, so
    // this asserts they resolve to opposite sides of UTC.
    expect(iso('2026-01-15 10:00:00', FMT, 'Etc/GMT-5')).toBe('2026-01-15T05:00:00.000Z');
    expect(iso('2026-01-15 10:00:00', FMT, 'GMT-5')).toBe('2026-01-15T15:00:00.000Z');
  });
});

describe('parseTzAlias (#227)', () => {
  it('reads the comma-separated pairs from the spec example', () => {
    const { aliases, invalid } = parseTzAlias('EST=GMT-5:00,METT=GMT+1:00');
    expect(aliases.get('EST')).toBe('GMT-5:00');
    expect(aliases.get('METT')).toBe('GMT+1:00');
    expect(invalid).toEqual([]);
  });

  it('upper-cases the abbreviation but keeps the target verbatim', () => {
    // The zone in an event is not reliably cased; the target is a zone spec
    // that may be case-sensitive (`America/New_York`), so it is not touched.
    const { aliases } = parseTzAlias('est=America/New_York');
    expect(aliases.get('EST')).toBe('America/New_York');
  });

  it('tolerates surrounding whitespace and empty entries', () => {
    const { aliases, invalid } = parseTzAlias('  EST = GMT-5:00 , , CST=GMT-6:00 ');
    expect(aliases.get('EST')).toBe('GMT-5:00');
    expect(aliases.get('CST')).toBe('GMT-6:00');
    expect(invalid).toEqual([]);
  });

  it('reports a malformed pair instead of dropping it silently', () => {
    const { aliases, invalid } = parseTzAlias('GMT-6:00,EST=,=GMT-5,CST=GMT-6:00');
    expect([...aliases.keys()]).toEqual(['CST']);
    expect(invalid).toEqual(['GMT-6:00', 'EST=', '=GMT-5']);
  });

  it('is empty for an empty value rather than throwing', () => {
    const { aliases, invalid } = parseTzAlias('');
    expect(aliases.size).toBe(0);
    expect(invalid).toEqual([]);
  });
});

describe('strftime — the year of a yearless timestamp (#356)', () => {
  const SYSLOG = '%b %d %H:%M:%S';
  const at = (text: string, now: string, format = SYSLOG) =>
    parseTimestamp(text, format, undefined, undefined, undefined, new Date(now))?.toISOString() ?? null;

  // Convention-derived, not captured: syslog readers place a yearless RFC 3164
  // stamp in the most recent year that does not put it in the future.
  it('rolls back to last year a date that would otherwise be in the future', () => {
    expect(at('Dec 31 23:59:00', '2026-01-01T00:30:00Z')).toBe('2025-12-31T23:59:00.000Z');
  });

  it('keeps this year for a date in the past or only slightly ahead of the clock', () => {
    expect(at('Jan 1 00:10:00', '2026-01-01T00:30:00Z')).toBe('2026-01-01T00:10:00.000Z');
    expect(at('Jan 2 00:10:00', '2026-01-01T00:30:00Z')).toBe('2026-01-02T00:10:00.000Z');
  });

  it('finds 29 February in the previous year when this one has none', () => {
    expect(at('Feb 29 10:00:00', '2025-03-01T00:00:00Z')).toBe('2024-02-29T10:00:00.000Z');
  });

  // Found by timestampProperties.test.ts.
  it('goes back to the last 29 February rather than forward to this year\'s', () => {
    expect(at('Feb 29 10:00:00', '2024-01-15T00:00:00Z')).toBe('2020-02-29T10:00:00.000Z');
  });

  it('finds 29 February more than one year back', () => {
    expect(at('Feb 29 10:00:00', '2026-03-01T00:00:00Z')).toBe('2024-02-29T10:00:00.000Z');
  });

  it('reads a stamp from a zone already in the new year as that year', () => {
    // 05:00 on 1 January in UTC+9 is 20:00 on 31 December in UTC — now.
    expect(at('Jan 1 05:00:00 +0900', '2025-12-31T20:00:00Z', '%b %d %H:%M:%S %z')).toBe('2025-12-31T20:00:00.000Z');
  });

  it('does not touch a format that carries a year', () => {
    expect(at('Dec 31 2026 23:59:00', '2026-01-01T00:30:00Z', '%b %d %Y %H:%M:%S')).toBe('2026-12-31T23:59:00.000Z');
  });

  it('takes the year from UTC, not the host zone', () => {
    // The process TZ is fixed when Node starts, so stand in for a host west of
    // UTC at New Year: every local accessor reads a day earlier. The result
    // must not move.
    const dayEarlier = (d: Date) => new Date(d.getTime() - 86_400_000);
    const spies = [
      vi.spyOn(Date.prototype, 'getFullYear').mockImplementation(function (this: Date) {
        return dayEarlier(this).getUTCFullYear();
      }),
      vi.spyOn(Date.prototype, 'getMonth').mockImplementation(function (this: Date) {
        return dayEarlier(this).getUTCMonth();
      }),
      vi.spyOn(Date.prototype, 'getDate').mockImplementation(function (this: Date) {
        return dayEarlier(this).getUTCDate();
      }),
    ];
    try {
      expect(new Date('2026-01-01T00:30:00Z').getFullYear()).toBe(2025);
      expect(at('Jan 1 00:10:00', '2026-01-01T00:30:00Z')).toBe('2026-01-01T00:10:00.000Z');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('strftime — month and weekday names accept either length (#356)', () => {
  // Doc-derived: POSIX strptime defines %b/%B (and %a/%A) as equivalent, each
  // matching the full or the abbreviated name.
  it('reads a full month name with %b and an abbreviation with %B', () => {
    expect(iso('September 5 2024 10:00:00', '%b %d %Y %H:%M:%S')).toBe('2024-09-05T10:00:00.000Z');
    expect(iso('Sep 5 2024 10:00:00', '%B %d %Y %H:%M:%S')).toBe('2024-09-05T10:00:00.000Z');
    expect(iso('may 5 2024 10:00:00', '%B %d %Y %H:%M:%S')).toBe('2024-05-05T10:00:00.000Z');
  });

  it('reads a full weekday name with %a and an abbreviation with %A', () => {
    expect(iso('Thursday 2024-09-05 10:00:00', '%a %Y-%m-%d %H:%M:%S')).toBe('2024-09-05T10:00:00.000Z');
    expect(iso('Thu 2024-09-05 10:00:00', '%A %Y-%m-%d %H:%M:%S')).toBe('2024-09-05T10:00:00.000Z');
  });
});

describe('formatStrftime — every parsed specifier renders (#429)', () => {
  // Built from local parts, so it renders as these fields on any machine (#407).
  const at = new Date(2024, 6, 1, 7, 5, 9, 42);

  it('renders the subsecond family at its Splunk width', () => {
    expect(formatStrftime(at, '%1N %2N %3N %6N %9N %N')).toBe('0 04 042 042000 042000000 042000000');
    expect(formatStrftime(at, '%Q %3Q %6Q %9Q %f')).toBe('042 042 042000 042000000 042000');
  });

  it('space-pads %k and %l', () => {
    expect(formatStrftime(at, '[%k] [%l]')).toBe('[ 7] [ 7]');
    expect(formatStrftime(new Date(2024, 6, 1, 19), '[%k] [%l]')).toBe('[19] [ 7]');
  });

  it('renders %:z and %::z as %z with colons', () => {
    const [, sign, hh, mm] = /^([+-])(\d{2})(\d{2})$/.exec(formatStrftime(at, '%z'))!;
    expect(formatStrftime(at, '%:z')).toBe(`${sign}${hh}:${mm}`);
    expect(formatStrftime(at, '%::z')).toBe(`${sign}${hh}:${mm}:00`);
  });

  it('leaves a specifier the parser does not read as literal text', () => {
    expect(formatStrftime(at, '%c %w %U %V %%T')).toBe('%c %w %U %V %T');
  });

  // It divided the span between local midnights by 24 hours, which comes up an
  // hour short of a whole day after spring-forward: 2024-07-01 00:30 in
  // Europe/London read as day 182. Run under TZ=Europe/London to see it fail.
  it('counts %j in calendar days, not across a DST change', () => {
    for (let day = 1; day <= 366; day++) {
      const d = new Date(2024, 0, day, 0, 30);
      expect(formatStrftime(d, '%j')).toBe(String(day).padStart(3, '0'));
    }
  });
});

describe('formatStrftime then parseTimestamp agree for every specifier (#429)', () => {
  // Each specifier sits in a format that pins the instant, so its value is
  // load-bearing (or, for %a/%A, at least has to be read back). Rendered and
  // read in the host's real zone, which %z/%Z carry across.
  const T = '%H:%M:%S %z';
  const cases = [
    `%Y-%m-%d ${T}`, `%y-%m-%d ${T}`, `%Y-%m-%e ${T}`, `%Y %j ${T}`,
    `%Y %b %d ${T}`, `%Y %B %d ${T}`, `%a %A %F ${T}`,
    '%Y-%m-%d %I:%M:%S %p %z', '%Y-%m-%d %l:%M:%S %p %z', '%Y-%m-%d %k:%M:%S %z',
    '%F %T %Z', '%F %T %:z', '%F %T %::z', '%s', '%s.%3N', '100%% %F %T %z',
    ...['%1N', '%2N', '%3N', '%4N', '%5N', '%6N', '%7N', '%8N', '%9N', '%N', '%Q', '%3Q', '%6Q', '%9Q', '%f']
      .map((s) => `%F %T.${s} %z`),
  ];

  it('covers every supported specifier', () => {
    for (const spec of supportedSpecifiers()) {
      expect(cases.some((c) => c.includes(spec)), spec).toBe(true);
    }
  });

  it('reads back the instant each format rendered', () => {
    // %s reads 10-13 digits, so from 2001-09-09; %y pivots at 69, so up to 2068.
    const instant = fc.integer({ min: Date.UTC(2002, 0, 1), max: Date.UTC(2067, 11, 31) });
    fc.assert(
      fc.property(instant, fc.constantFrom(...cases), (ms, format) => {
        const text = formatStrftime(new Date(ms), format);
        const width = /%(\d)N/.exec(format)?.[1];
        const precision = width ? 10 ** Math.max(0, 3 - Number(width)) : /%\d?[NQf]/.test(format) ? 1 : 1000;
        expect(parseTimestamp(text, format)?.getTime(), `${format} → ${text}`)
          .toBe(Math.floor(ms / precision) * precision);
      }),
      { seed: 429, numRuns: 2000 },
    );
  });
});
