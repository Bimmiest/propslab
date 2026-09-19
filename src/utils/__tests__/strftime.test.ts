import { describe, it, expect } from 'vitest';
import { parseTimestamp, parseTzAlias, strftimeToRegex } from '../strftime';

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

// #227: the zone-spec forms TZ_ALIAS targets are written in, and the table that
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
