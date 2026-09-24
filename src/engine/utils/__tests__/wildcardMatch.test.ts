// ---------------------------------------------------------------------------
// `*` glob matching for the XML_IE_* lists (#344).
//
// Doc-derived: props.conf.spec says only that the XML_IE_* lists are
// comma-separated and accept "*" as a wildcard. The finer points — anchoring,
// case sensitivity, `*` crossing newlines, every other character literal —
// are the semantics the previous regex compilation had, kept unchanged; the
// parity property below pins them to that reference.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compileWildcard } from '../wildcardMatch';

/** The compilation #344 replaced, kept here only as the parity reference. */
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
      { numRuns: 2000 },
    );
  });

  it('stays fast on patterns that made the regex backtrack exponentially (#344)', () => {
    const value = 'a'.repeat(10_000);
    const patterns = ['*a*a*a*a*b', '*a*a*a*a*a*a*b', '*a*a*a*a*a*a*ab*', '*aa*aa*aa*aa*aa*aa*c*'];
    const started = performance.now();
    for (const p of patterns) expect(m(p, value)).toBe(false);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
