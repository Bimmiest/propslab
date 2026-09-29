// ---------------------------------------------------------------------------
// `*` glob matching for the XML_IE_* lists.
//
// Doc-derived: props.conf.spec says only that the XML_IE_* lists are
// comma-separated and accept "*" as a wildcard. The finer points — anchoring,
// case sensitivity, `*` crossing newlines, every other character literal —
// are those of compiling the glob to a regex; the parity property below pins
// them to that reference.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
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
        fc.array(chars.filter((c) => c !== '*'), { maxLength: 12 }).map((c) => c.join('')),
        (pattern, s) => compileWildcard(pattern)(s) === reference(pattern).test(s),
      ),
      { seed: fcSeed(371), numRuns: 2000 },
    );
  });

  it('stays fast on patterns that made the regex backtrack exponentially (#344)', () => {
    const patterns = ['*a*a*a*a*b', '*a*a*a*a*a*a*b', '*a*a*a*a*a*a*ab*', '*aa*aa*aa*aa*aa*aa*c*'];
    // Measure with base input size, then verify time stays sub-linear with larger input
    const value1 = 'a'.repeat(5_000);
    const started1 = performance.now();
    for (const p of patterns) expect(m(p, value1)).toBe(false);
    const time1 = performance.now() - started1;

    const value2 = 'a'.repeat(10_000);
    const started2 = performance.now();
    for (const p of patterns) expect(m(p, value2)).toBe(false);
    const time2 = performance.now() - started2;

    // Verify roughly linear scaling: 2x input should be < 4x time
    // (wall clock is generous to account for system variance)
    if (time1 > 0) {
      expect(time2).toBeLessThan(time1 * 4);
    }
    // Ensure it doesn't timeout completely even on slow machines
    expect(time2).toBeLessThan(1000);
  });
});
