// ---------------------------------------------------------------------------
// `*` glob matching for the XML_IE_* lists.
//
// Doc-derived: props.conf.spec says only that the XML_IE_* lists are
// comma-separated and accept "*" as a wildcard. The finer points — anchoring,
// case sensitivity, `*` crossing newlines, every other character literal —
// are those of compiling the glob to a regex; the parity property below pins
// them to that reference.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { compileWildcard } from '../wildcardMatch';
import { fcSeed } from '../../../test/fcSeed';

/** The regex compilation, kept here only as the parity reference. */
function reference(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`, 's');
}

const m = (pattern: string, s: string) => compileWildcard(pattern)(s);

describe('compileWildcard', () => {
  it('matches the whole string, not a substring', () => {
    expect(m('Process', 'Process')).toBe(true);
    expect(m('Process', 'ProcessId')).toBe(false);
    expect(m('Process*', 'ProcessId')).toBe(true);
    expect(m('*Id', 'ProcessId')).toBe(true);
    expect(m('*Process*', 'ParentProcessId')).toBe(true);
    expect(m('*Process*', 'Parent')).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(m('event*', 'EventID')).toBe(false);
  });

  it('lets * match nothing, and a lone * match everything', () => {
    expect(m('a*b', 'ab')).toBe(true);
    expect(m('*', '')).toBe(true);
    expect(m('**', 'anything')).toBe(true);
  });

  it('lets * cross newlines', () => {
    expect(m('a*b', 'a\nb')).toBe(true);
  });

  it('treats every other character literally', () => {
    expect(m('a.c', 'abc')).toBe(false);
    expect(m('a.c', 'a.c')).toBe(true);
    expect(m('a?c', 'abc')).toBe(false);
    expect(m('\\d*', '\\d1')).toBe(true);
    expect(m('(x)*', '(x)y')).toBe(true);
  });

  it('does not let the prefix and suffix share characters', () => {
    expect(m('ab*ba', 'aba')).toBe(false);
    expect(m('ab*ba', 'abba')).toBe(true);
  });

  it('agrees with the regex compilation it replaced', () => {
    const chars = fc.constantFrom('a', 'b', '*', '.', '\n', '\\');
    fc.assert(
      fc.property(
        fc.array(chars, { maxLength: 8 }).map((c) => c.join('')),
        fc
          .array(
            chars.filter((c) => c !== '*'),
            { maxLength: 12 },
          )
          .map((c) => c.join('')),
        (pattern, s) => compileWildcard(pattern)(s) === reference(pattern).test(s),
      ),
      { seed: fcSeed(371), numRuns: 2000 },
    );
  });

  it('does a bounded amount of work on patterns that made the regex backtrack exponentially (#344)', () => {
    // Operations, not milliseconds (#507): a stopwatch assertion is a coin flip
    // on a loaded runner. The linear-time claim is that each middle segment is
    // searched for once, leftmost, after the previous one — so the matcher makes
    // at most one indexOf per segment, however long the input is. A backtracking
    // implementation retries segments and its count grows with the input.
    // Each pattern is tried on `a…a` (never matches) and `a…ab` (matches the
    // ones that end in b), so both the failing and the succeeding scan are counted.
    const cases: { pattern: string; segments: number; onAs: boolean; onAsThenB: boolean }[] = [
      { pattern: '*a*a*a*a*b', segments: 4, onAs: false, onAsThenB: true },
      { pattern: '*a*a*a*a*a*a*b', segments: 6, onAs: false, onAsThenB: true },
      { pattern: '*a*a*a*a*a*a*ab*', segments: 7, onAs: false, onAsThenB: true },
      { pattern: '*aa*aa*aa*aa*aa*aa*c*', segments: 7, onAs: false, onAsThenB: false },
    ];
    const indexOf = vi.spyOn(String.prototype, 'indexOf');
    const runs: { calls: number; result: boolean }[][] = [];
    try {
      for (const { pattern } of cases) {
        const match = compileWildcard(pattern);
        const row: { calls: number; result: boolean }[] = [];
        for (const n of [5_000, 10_000]) {
          for (const value of ['a'.repeat(n), `${'a'.repeat(n)}b`]) {
            indexOf.mockClear();
            const result = match(value);
            row.push({ calls: indexOf.mock.calls.length, result });
          }
        }
        runs.push(row);
      }
    } finally {
      indexOf.mockRestore();
    }
    cases.forEach(({ segments, onAs, onAsThenB }, i) => {
      const [as5, asB5, as10, asB10] = runs[i]!;
      expect([as5!.result, asB5!.result, as10!.result, asB10!.result]).toEqual([onAs, onAsThenB, onAs, onAsThenB]);
      for (const r of runs[i]!) expect(r.calls).toBeLessThanOrEqual(segments);
      // Doubling the input does not add work.
      expect(as10!.calls).toBe(as5!.calls);
      expect(asB10!.calls).toBe(asB5!.calls);
    });
  });
});
