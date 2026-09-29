// ---------------------------------------------------------------------------
// timestampProperties.test.ts
// Property-based tests for timestamp parsing: strftime.ts, the shared
// recogniser, and the extractor that places `_time`.
//
// An instant, a zone offset and sub-millisecond digits are generated, and the
// instant's wall clock in that zone is rendered with a strftime layout: ISO,
// Apache, RFC 2822, 12-hour, compact and day-of-year dates, fractions of every
// width from 1 to 9 digits, and the zone as `Z`, `±HH:MM` or `±HHMM`, attached
// or after a space. Instants cluster on year boundaries and 29 February as
// well as spreading over years 1–9999. Reading the text back must give the
// instant, truncated to what the fraction carries, at millisecond precision.
//
// Every parse runs with the host zone faked to a generated offset: the local
// Date getters are replaced, as strftime.test.ts does, so a parser that read
// the host zone anywhere would drift with it.
//
// Yearless stamps (syslog's `%b %e %H:%M:%S`) are read against a generated
// `now`: the result is the most recent instant with that wall date and time,
// and never more than the parser's two-day tolerance ahead of `now`.
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { formatStrftime, parseTimestamp } from '../../utils/strftime';
import { recognizeTimestamp } from '../processors/timestampRecognizer';
import { extractTimestamps } from '../processors/timestampExtractor';
import type { SplunkEvent } from '../types';
import { runCtx } from './runCtx';
import { fcSeed } from '../../test/fcSeed';

fc.configureGlobal({ seed: fcSeed(371), numRuns: 200 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** parseTimestampDetailed's YEARLESS_FUTURE_TOLERANCE_MS. */
const YEARLESS_TOLERANCE = 2 * DAY;

// ── The host zone ───────────────────────────────────────

const LOCAL_GETTERS = [
  ['getFullYear', 'getUTCFullYear'],
  ['getMonth', 'getUTCMonth'],
  ['getDate', 'getUTCDate'],
  ['getDay', 'getUTCDay'],
  ['getHours', 'getUTCHours'],
  ['getMinutes', 'getUTCMinutes'],
  ['getSeconds', 'getUTCSeconds'],
  ['getMilliseconds', 'getUTCMilliseconds'],
] as const;

/** Run `fn` with every local Date getter reading the wall clock `offsetMinutes` east of UTC. */
function inHostZone<T>(offsetMinutes: number, fn: () => T): T {
  const spies = [
    ...LOCAL_GETTERS.map(([local, utc]) =>
      vi.spyOn(Date.prototype, local).mockImplementation(function (this: Date) {
        return new Date(this.getTime() + offsetMinutes * MIN)[utc]();
      }),
    ),
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-offsetMinutes),
  ];
  try {
    return fn();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

// ── Generators ──────────────────────────────────────────

const hostOffset = fc.integer({ min: -12 * 60, max: 14 * 60 });
const zoneOffset = fc.integer({ min: -14 * 60, max: 14 * 60 });

/** Date.UTC, without its mapping of years 0–99 onto 1900–1999. */
function utc(year: number, month: number, day: number, hour = 0): number {
  const d = new Date(Date.UTC(2000, month, day, hour));
  d.setUTCFullYear(year, month, day);
  return d.getTime();
}

const inYears = (from: number, to: number) => fc.integer({ min: utc(from, 0, 2), max: utc(to, 11, 30) });

/** Within a day and a half of 1 January, or of 29 February in a leap year. */
const nearBoundary = (from: number, to: number) =>
  fc.oneof(
    fc.tuple(fc.integer({ min: from, max: to }), fc.integer({ min: -36 * HOUR, max: 36 * HOUR }))
      .map(([y, d]) => utc(y, 0, 1) + d),
    fc.tuple(fc.integer({ min: Math.ceil(from / 4), max: Math.floor(to / 4) }), fc.integer({ min: -36 * HOUR, max: 36 * HOUR }))
      .map(([q, d]) => utc(q * 4, 1, 29, 12) + d),
  );

/** Any instant whose wall year, in any zone, has four digits or fewer. */
const instant = fc.oneof(inYears(2, 9998), nearBoundary(1970, 2100), nearBoundary(4, 9996));

type Zone = { spelling: 'Z' } | { spelling: 'colon' | 'plain'; offset: number };
const zone: fc.Arbitrary<Zone> = fc.oneof(
  fc.constant({ spelling: 'Z' as const }),
  fc.record({ spelling: fc.constantFrom('colon' as const, 'plain' as const), offset: zoneOffset }),
);
const offsetOf = (z: Zone) => (z.spelling === 'Z' ? 0 : z.offset);

/** Layouts with `{F}` where the fraction goes and `{Z}` where the zone does. */
const layout = fc.constantFrom(
  '%Y-%m-%dT%H:%M:%S{F}{Z}',
  '%Y-%m-%d %H:%M:%S{F}{Z}',
  '%d/%b/%Y:%H:%M:%S{F}{Z}',
  '%a, %d %B %Y %H:%M:%S{F}{Z}',
  '%m/%d/%Y %I:%M:%S{F} %p{Z}',
  '%b %e %H:%M:%S{F} %Y{Z}',
  '%Y%m%d%H%M%S{F}{Z}',
  '%Y-%j %H:%M:%S{F}{Z}',
);

/** 0: no fraction. 1–9: `%<w>N`, bare `%N` standing in for 9 half the time. */
const fractionWidth = fc.integer({ min: 0, max: 9 });

interface Stamp {
  format: string;
  text: string;
  /** What the text encodes, at millisecond precision. */
  expected: number;
}

const stamp = fc
  .record({
    at: instant,
    subMs: fc.integer({ min: 0, max: 999_999 }),
    zone: fc.option(zone, { nil: undefined }),
    spaceBeforeZone: fc.boolean(),
    layout,
    width: fractionWidth,
    bareN: fc.boolean(),
    sep: fc.constantFrom('.', ','),
    longNames: fc.boolean(),
  })
  .map((g): Stamp => {
    const w = g.width;
    const fraction = w === 0 ? '' : `${g.sep}${w === 9 && g.bareN ? '%N' : `%${w}N`}`;
    const zoneSpec = g.zone === undefined ? '' : `${g.spaceBeforeZone ? ' ' : ''}%z`;
    const format = g.layout.replace('{F}', fraction).replace('{Z}', zoneSpec);
    const digits = String(new Date(g.at).getUTCMilliseconds()).padStart(3, '0') + String(g.subMs).padStart(6, '0');
    const kept = digits.slice(0, w);
    const text = render(format, g.at, offsetOf(g.zone ?? { spelling: 'Z' }), g.zone, kept, g.longNames);
    const expected = g.at - new Date(g.at).getUTCMilliseconds() + Number(kept.padEnd(3, '0').slice(0, 3));
    return { format, text, expected };
  });

// ── Rendering ───────────────────────────────────────────

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, w = 2) => String(n).padStart(w, '0');

function spellZone(z: Zone): string {
  if (z.spelling === 'Z') return 'Z';
  const sign = z.offset < 0 ? '-' : '+';
  const abs = Math.abs(z.offset);
  return `${sign}${pad(Math.floor(abs / 60))}${z.spelling === 'colon' ? ':' : ''}${pad(abs % 60)}`;
}

/** `at`'s wall clock `offset` minutes east of UTC, written with `format`. */
function render(format: string, at: number, offset: number, z: Zone | undefined, fraction: string, longNames: boolean): string {
  const wall = new Date(at + offset * MIN);
  const year = wall.getUTCFullYear();
  const h = wall.getUTCHours();
  const dayOfYear = Math.floor((Date.UTC(2000, wall.getUTCMonth(), wall.getUTCDate()) - Date.UTC(2000, 0, 1)) / DAY) + 1;
  const leapShift = wall.getUTCMonth() > 1 && !isLeap(year) ? -1 : 0; // 2000 is a leap year
  const name = (full: string) => (longNames ? full : full.slice(0, 3));
  const tokens: Record<string, string> = {
    '%Y': pad(year, 4),
    '%m': pad(wall.getUTCMonth() + 1),
    '%d': pad(wall.getUTCDate()),
    '%e': String(wall.getUTCDate()).padStart(2, ' '),
    '%H': pad(h),
    '%I': pad(h % 12 === 0 ? 12 : h % 12),
    '%p': h < 12 ? 'AM' : 'PM',
    '%M': pad(wall.getUTCMinutes()),
    '%S': pad(wall.getUTCSeconds()),
    '%b': name(MONTHS[wall.getUTCMonth()]!),
    '%B': name(MONTHS[wall.getUTCMonth()]!),
    '%a': name(DAYS[wall.getUTCDay()]!),
    '%j': pad(dayOfYear + leapShift, 3),
    '%N': fraction,
    '%z': z === undefined ? '' : spellZone(z),
  };
  return format.replace(/%(?:[1-9]N|[YmdeHIpMSbBajNz])/g, (t) => (/^%\dN$/.test(t) ? fraction : tokens[t]!));
}

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// ── Properties ──────────────────────────────────────────

describe('parseTimestamp — reads back the instant a format rendered', () => {
  it('for every layout, fraction width and zone spelling, whatever the host zone', () => {
    fc.assert(
      fc.property(stamp, hostOffset, ({ format, text, expected }, host) => {
        const parsed = inHostZone(host, () => parseTimestamp(text, format));
        expect(parsed?.getTime()).toBe(expected);
      }),
      { numRuns: 400 },
    );
  });

  it('applies a fallback TZ to a stamp that carries no zone', () => {
    const noZone = stamp.filter((s) => !s.format.includes('%z'));
    fc.assert(
      fc.property(noZone, zone, hostOffset, ({ format, text, expected }, tz, host) => {
        // The text was rendered as UTC wall time; read in `tz`, it is that far off.
        const parsed = inHostZone(host, () => parseTimestamp(text, format, spellZone(tz)));
        expect(parsed?.getTime()).toBe(expected - offsetOf(tz) * MIN);
      }),
    );
  });

  it('round-trips formatStrftime, which renders in the host zone', () => {
    const format = fc.constantFrom(
      '%Y-%m-%dT%H:%M:%S.%3N%z',
      '%d/%b/%Y:%H:%M:%S %z',
      '%a %B %d %Y %I:%M:%S %p %z',
      '%F %T.%6N %z',
      '%m/%d/%y %H:%M:%S %z',
      '%s.%3N',
    );
    // %s reads 10–13 digits, so from 2001-09-09; %y pivots at 69, so up to 2068.
    fc.assert(
      fc.property(inYears(2002, 2067), format, hostOffset, (at, fmt, host) => {
        const text = inHostZone(host, () => formatStrftime(new Date(at), fmt));
        const precision = fmt.includes('N') ? 1 : 1000;
        const parsed = inHostZone(-host, () => parseTimestamp(text, fmt));
        expect(parsed?.getTime()).toBe(Math.floor(at / precision) * precision);
      }),
    );
  });
});

describe('recognizeTimestamp — reads an ISO stamp of any fraction width and zone', () => {
  const iso = fc
    .record({
      at: fc.oneof(inYears(1971, 2099), nearBoundary(1971, 2099)),
      subMs: fc.integer({ min: 0, max: 999_999 }),
      zone: fc.option(zone, { nil: undefined }),
      spaceBeforeZone: fc.boolean(),
      t: fc.constantFrom('T', ' '),
      width: fractionWidth,
      before: fc.constantFrom('', 'INFO ', '[', 'ts=', '<14>1 '),
      after: fc.constantFrom('', ' msg', ']', ' level=INFO', ', next'),
    })
    .map((g) => {
      const w = g.width;
      const format = `%Y-%m-%d${g.t}%H:%M:%S${w === 0 ? '' : `.%${w}N`}${g.zone === undefined ? '' : `${g.spaceBeforeZone ? ' ' : ''}%z`}`;
      const digits = pad(new Date(g.at).getUTCMilliseconds(), 3) + pad(g.subMs, 6);
      const kept = digits.slice(0, w);
      const text = render(format, g.at, offsetOf(g.zone ?? { spelling: 'Z' }), g.zone, kept, false);
      const expected = g.at - new Date(g.at).getUTCMilliseconds() + Number(kept.padEnd(3, '0').slice(0, 3));
      return { line: `${g.before}${text}${g.after}`, text, start: g.before.length, expected };
    });

  it('finds the whole stamp and its instant, whatever surrounds it', () => {
    fc.assert(
      fc.property(iso, hostOffset, ({ line, text, start, expected }, host) => {
        const found = inHostZone(host, () => recognizeTimestamp(line));
        expect(found).toMatchObject({ start, text });
        expect(found?.parsed.date.getTime()).toBe(expected);
      }),
    );
  });
});

describe('extractTimestamps — places _time at the instant TIME_FORMAT reads', () => {
  const event = (raw: string): SplunkEvent => ({
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  });
  const dir = (key: string, value: string) => ({ key, value, line: 1, directiveType: key });

  it('with or without TIME_PREFIX, for a now inside the sanity bounds', () => {
    const recent = stamp.filter((s) => s.expected > Date.UTC(1971, 0, 1) && s.expected < Date.UTC(2100, 0, 1));
    fc.assert(
      fc.property(
        recent,
        fc.boolean(),
        // Within MAX_DAYS_HENCE (2) ahead of now and MAX_DAYS_AGO (2000) behind.
        fc.integer({ min: -DAY, max: 1999 * DAY }),
        hostOffset,
        ({ format, text, expected }, withPrefix, sinceStamp, host) => {
          const directives = [dir('TIME_FORMAT', format), ...(withPrefix ? [dir('TIME_PREFIX', 'ts=')] : [])];
          const [out] = inHostZone(host, () =>
            extractTimestamps([event(`id=7 ts=${text} done`)], directives, runCtx([], { now: new Date(expected + sinceStamp) })),
          );
          expect(out!._time?.getTime()).toBe(expected);
        },
      ),
    );
  });
});

describe('parseTimestamp — a yearless stamp is the most recent one it can be', () => {
  const yearless = fc
    .record({
      now: fc.oneof(inYears(1972, 2098), nearBoundary(1972, 2098)),
      // The stamp's own instant, from well before now to a little after it.
      back: fc.integer({ min: -3 * DAY, max: 800 * DAY }),
      zone: fc.option(zone, { nil: undefined }),
      format: fc.constantFrom('%b %e %H:%M:%S', '%b %d %H:%M:%S', '%m-%d %H:%M:%S'),
      host: hostOffset,
    })
    .chain((g) =>
      fc.oneof(
        fc.constant(g.now - g.back),
        // A 29 February near now, which most years cannot hold.
        fc.integer({ min: -4, max: 1 }).map((dy) => {
          const y = new Date(g.now).getUTCFullYear() + dy;
          return Date.UTC(y - (y % 4), 1, 29, 12);
        }),
      ).map((at) => ({ ...g, at })),
    );

  it('never lands more than the tolerance past now, and no later candidate would', () => {
    fc.assert(
      fc.property(yearless, ({ now, at, zone: z, format, host }) => {
        const offset = z === undefined ? 0 : offsetOf(z);
        const fmt = z === undefined ? format : `${format} %z`;
        const text = render(fmt, at, offset, z, '', false);
        const parsed = inHostZone(host, () => parseTimestamp(text, fmt, undefined, undefined, undefined, new Date(now)));

        // Every instant with this wall date and time, in the years that could hold it.
        const wall = new Date(at + offset * MIN);
        const candidates: number[] = [];
        const nowYear = new Date(now).getUTCFullYear();
        for (let y = nowYear - 8; y <= nowYear + 1; y++) {
          const t = Date.UTC(y, wall.getUTCMonth(), wall.getUTCDate(), wall.getUTCHours(), wall.getUTCMinutes(), wall.getUTCSeconds());
          if (new Date(t).getUTCDate() === wall.getUTCDate()) candidates.push(t - offset * MIN);
        }
        const latest = Math.max(...candidates.filter((t) => t <= now + YEARLESS_TOLERANCE));

        expect(parsed).not.toBeNull();
        expect(parsed!.getTime() - now).toBeLessThanOrEqual(YEARLESS_TOLERANCE);
        expect(parsed!.getTime()).toBe(latest);
      }),
      { numRuns: 400 },
    );
  });
});
