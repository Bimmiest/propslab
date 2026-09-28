// ---------------------------------------------------------------------------
// ianaDstProperties.test.ts
// Property-based tests for reading a wall clock in an IANA zone across its DST
// transitions (strftime.ts, TZ = <IANA name>).
//
// A zone, a year and one of that year's transitions are generated, then a wall
// clock within a few hours of it: inside a spring-forward gap, inside a
// fall-back overlap, or either side. Zones cover both hemispheres, both sides
// of UTC, half-hour offsets and Lord Howe's half-hour DST.
//
// The oracle reads offsets through Intl's `longOffset` zone name, not the
// formatToParts arithmetic the parser uses, and expects the convention the
// parser documents: an overlap resolves to its first occurrence, and a gap
// forward by the offset in force before it (02:30 in a 02:00→03:00 gap is
// 03:30 after it).
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseTimestamp } from '../strftime';

const SEED = 399;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ZONES = [
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns',
  'America/Santiago',
  'Europe/Berlin',
  'Europe/London',
  'Australia/Sydney',
  'Australia/Adelaide',
  'Australia/Lord_Howe',
  'Pacific/Auckland',
  'Pacific/Chatham',
] as const;

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/** Minutes east of UTC that `zone` is at `atMs`, from its `GMT±HH:MM` name. */
function offsetAt(zone: string, atMs: number): number {
  let f = offsetFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' });
    offsetFormatters.set(zone, f);
  }
  const name = f.formatToParts(new Date(atMs)).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!m) throw new Error(`unexpected offset name ${name}`);
  if (!m[1]) return 0;
  return (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
}

interface Transition {
  /** The first instant at the new offset. */
  at: number;
  before: number;
  after: number;
}

const transitionCache = new Map<string, Transition[]>();

/** A zone's offset changes during a UTC year, each to the millisecond. */
function transitions(zone: string, year: number): Transition[] {
  const key = `${zone}|${year}`;
  const cached = transitionCache.get(key);
  if (cached) return cached;
  const found: Transition[] = [];
  const start = Date.UTC(year, 0, 1);
  for (let day = start; day < Date.UTC(year + 1, 0, 1); day += DAY) {
    const before = offsetAt(zone, day);
    const after = offsetAt(zone, day + DAY);
    if (before === after) continue;
    let lo = day;
    let hi = day + DAY;
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetAt(zone, mid) === before) lo = mid;
      else hi = mid;
    }
    found.push({ at: hi, before, after });
  }
  transitionCache.set(key, found);
  return found;
}

/** `wall` (a wall clock written as a UTC epoch) as `%Y-%m-%d %H:%M:%S.%3N` text. */
function render(wall: number): string {
  return new Date(wall).toISOString().replace('T', ' ').replace('Z', '');
}

/**
 * Where `wall` lands in `zone`: the earliest instant showing that wall clock,
 * or for a wall clock no instant shows, the instant at the offset before the gap.
 */
function expectedInstant(zone: string, wall: number, t: Transition): number {
  const shows = [t.before, t.after]
    .map((o) => wall - o * MIN)
    .filter((instant) => instant + offsetAt(zone, instant) * MIN === wall);
  return shows.length > 0 ? Math.min(...shows) : wall - t.before * MIN;
}

const YEARS = { min: 1996, max: 2037 };

const nearTransition = fc
  .record({
    zone: fc.constantFrom(...ZONES),
    year: fc.integer(YEARS),
    pick: fc.nat(),
    // Wall-clock distance from the transition's local time, to the millisecond.
    delta: fc.integer({ min: -3 * HOUR, max: 3 * HOUR }),
  })
  .map(({ zone, year, pick, delta }) => {
    const all = transitions(zone, year);
    if (all.length === 0) return null;
    const t = all[pick % all.length]!;
    // The transition's wall clock read at the old offset: where the gap or
    // overlap begins.
    return { zone, t, wall: t.at + t.before * MIN + delta };
  })
  .filter((g): g is { zone: (typeof ZONES)[number]; t: Transition; wall: number } => g !== null);

describe('IANA wall clocks across DST transitions', () => {
  it('read to the instant the zone showed, first occurrence in an overlap, forward in a gap', () => {
    fc.assert(
      fc.property(nearTransition, ({ zone, t, wall }) => {
        const parsed = parseTimestamp(render(wall), '%Y-%m-%d %H:%M:%S.%3N', zone);
        expect(parsed?.getTime(), `${render(wall)} ${zone}`).toBe(expectedInstant(zone, wall, t));
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('generates gaps and overlaps on both sides of UTC, in both hemispheres', () => {
    // Guards the generator: a property that never reached a gap would pass
    // against the old east-of-UTC-only resolution.
    const seen = new Set<string>();
    fc.assert(
      fc.property(nearTransition, ({ t, wall }) => {
        const local = wall - t.at - t.before * MIN;
        const width = (t.after - t.before) * MIN;
        const inside = width > 0 ? local >= 0 && local < width : local >= width && local < 0;
        if (inside) seen.add(`${width > 0 ? 'gap' : 'overlap'} ${t.before < 0 ? 'west' : 'east'}`);
      }),
      { seed: SEED, numRuns: 400 },
    );
    expect([...seen].sort()).toEqual(['gap east', 'gap west', 'overlap east', 'overlap west']);
  });
});
