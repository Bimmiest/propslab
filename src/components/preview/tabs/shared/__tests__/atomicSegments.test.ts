// ---------------------------------------------------------------------------
// atomicSegments.test.ts
// The Extractions tab's segmentation of an event into highlighted runs. It
// was a scan of every highlight for every cut (#496), and is now a sweep over
// the highlights open at each cut; the scan is kept here as the reference the
// sweep must agree with.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { atomicSegments, type AtomicSegment, type Highlight } from '../atomicSegments';
import { fcSeed } from '../../../../../test/fcSeed';

/** The original O(cuts × highlights) segmentation. */
function reference(raw: string, highlights: Highlight[]): AtomicSegment[] {
  if (highlights.length === 0) return [];
  const bounds = new Set<number>([0, raw.length]);
  for (const h of highlights) {
    if (h.start >= 0 && h.start <= raw.length) bounds.add(h.start);
    if (h.end >= 0 && h.end <= raw.length) bounds.add(h.end);
  }
  const cuts = [...bounds].sort((a, b) => a - b);
  const out: AtomicSegment[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i]!;
    const e = cuts[i + 1]!;
    let owner: Highlight | null = null;
    for (const h of highlights) {
      if (h.start <= s && h.end >= e && (owner === null || h.end - h.start < owner.end - owner.start)) owner = h;
    }
    const prev = out[out.length - 1];
    if (prev && prev.end === s && (prev.hl?.field ?? null) === (owner?.field ?? null)) prev.end = e;
    else out.push({ start: s, end: e, hl: owner });
  }
  return out;
}

const hl = (start: number, end: number, field: string): Highlight => ({ start, end, field, color: '#000' });

describe('atomicSegments', () => {
  it('draws the innermost field over a nested one, and the outer around it', () => {
    const raw = 'user=alice@example.com';
    const segs = atomicSegments(raw, [hl(5, 22, 'email'), hl(5, 10, 'user')]);
    expect(segs.map((s) => [raw.slice(s.start, s.end), s.hl?.field ?? null])).toEqual([
      ['user=', null],
      ['alice', 'user'],
      ['@example.com', 'email'],
    ]);
  });

  it('gives a tie to the highlight listed first', () => {
    const segs = atomicSegments('abcdef', [hl(1, 3, 'first'), hl(1, 3, 'second')]);
    expect(segs.find((s) => s.start === 1)?.hl?.field).toBe('first');
  });

  it('agrees with the scan it replaced', () => {
    const highlight = fc
      .record({
        start: fc.integer({ min: -2, max: 30 }),
        len: fc.integer({ min: 0, max: 12 }),
        field: fc.constantFrom('a', 'b', 'c', 'd'),
      })
      .map(({ start, len, field }) => hl(start, start + len, field));
    fc.assert(
      fc.property(fc.string({ maxLength: 28 }), fc.array(highlight, { maxLength: 12 }), (raw, highlights) => {
        expect(atomicSegments(raw, highlights)).toEqual(reference(raw, highlights));
      }),
      { seed: fcSeed(496), numRuns: 500 },
    );
  });
});
