import { describe, it, expect, vi } from 'vitest';
import { detached, hasReDoSRisk } from '../redosHeuristic';

// The heuristic is advisory now — it ranks the MCP server's timeout suspects —
// so these pin its verdicts only; no pattern is refused on its word.

describe('hasReDoSRisk — strengthened heuristic (#11/#34)', () => {
  it.each([
    '(\\d+)+', // nested quantified group
    '(.+)*x', // nested group, star outer
    '(.*,){20}', // bounded repetition of a group with an inner quantifier
    'a*a*', // adjacent same-atom quantifiers
    '\\d+\\d+', // adjacent same-atom quantifiers (escaped atom)
    'a*a*a*a*a*a*a*c', // long adjacent run
  ])('flags catastrophic pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });

  it.each([
    '(foo|bar)+', // benign alternation (NOT flagged — needs real overlap analysis)
    'a+b+', // different atoms
    '\\d+\\.\\d+', // digits.digits (dot between, not adjacent same atom)
    '(ab){3}', // bounded group with no inner quantifier
    '\\d{2,3}', // a plain bound
    '(?<num>\\d+)', // a single named group
  ])('does not flag benign pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
  });
});

describe('hasReDoSRisk — ambiguity analysis (#55)', () => {
  it.each([
    '(\\d+\\.){3}\\d+', // canonical IPv4 — `\d+` cannot match the `.`
    '^(?:[^ ]* ){2}', // Splunk docs' own TIME_PREFIX recipe
    '(?:[^,]*,)+', // CSV field walk
    '(?:[^"]*"){2}', // walk to the second quote
    '(?:\\d+[a-z]+)+', // boundary is the group's own start, and it is unambiguous
    '(?:\\[[^\\]]*\\])+', // bracketed segments
    '(?i-s:\\d+\\.)+', // a scoped flag group is analysed like any other
  ])('does not flag safe repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
  });

  it.each([
    '(a+)+', // classic nested quantifier
    '(\\w+)*',
    '(?:\\d*)*',
    '([a-z]+\\w*)+', // `\w` overlaps `[a-z]`
    '(\\s*\\S*)+', // body can match empty
    '(?:\\w+=\\S+\\s*)+', // trailing `\S+` can eat the next iteration's `\w+`
    '(?i:(x+)+)', // inside a scoped flag group
  ])('flags ambiguous repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });
});

describe('hasReDoSRisk — adjacent quantifiers compare whole atoms (#365)', () => {
  it.each(['\\d+d+', '\\.+.+', 'd+\\d+', '\\w*w*'])(
    'does not read an escape and its bare letter as one atom: %s',
    (p) => {
      expect(hasReDoSRisk(p)).toBe(false);
    },
  );

  it.each(['\\\\d+d+', '\\.+\\.+', 'x\\d+\\d+'])('still flags a repeated atom after escaped backslashes: %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });
});

describe('hasReDoSRisk — the verdict cache (#487)', () => {
  it('gives the same verdict for a pattern too long to cache, every time', () => {
    // Past the full analysis's length limit the verdict is not cached; the
    // cheap check runs on each call. (The MCP package's suspects test checks
    // that cached keys keep no caller text alive.)
    const long = `(a+)+${'x'.repeat(3_000)}`;
    expect(hasReDoSRisk(long)).toBe(true);
    expect(hasReDoSRisk(long)).toBe(true);
    expect(hasReDoSRisk('x'.repeat(3_000))).toBe(false);
  });

  it('caches a copy of the key with the same characters', () => {
    const text = `prefix ${'日'.repeat(100)} (?<a>(b+)+) suffix`;
    const cut = text.slice(text.indexOf('('), text.indexOf(' suffix'));
    expect(detached(cut)).toBe('(?<a>(b+)+)');
    expect(detached('')).toBe('');
    expect(hasReDoSRisk(cut)).toBe(true);
    expect(hasReDoSRisk('(?<a>(b+)+)')).toBe(true);
  });
});

describe('hasReDoSRisk — very long patterns (#480)', () => {
  // REDOS_ANALYSIS_MAX_LENGTH is 2000 and REDOS_PRESENCE_CHECK_MAX_LENGTH 5000.
  const padded = (core: string, length: number) => core + 'x'.repeat(length - core.length);

  it('runs only the presence check between the analysis cap and the length cap', () => {
    expect(hasReDoSRisk(padded('(a+)+', 2001))).toBe(true);
    expect(hasReDoSRisk(padded('(ab)', 2001))).toBe(false);
    expect(hasReDoSRisk(padded('(ab)', 5000))).toBe(false);
  });

  it('assumes a pattern past the length cap is risky, without scanning it', () => {
    expect(hasReDoSRisk(padded('(ab)', 5001))).toBe(true);
    // Quadratic for REDOS_NESTED_GROUP: about 0.8 s at 30,000 characters when it
    // was scanned. No stopwatch (#507), two structural bounds instead. First,
    // the only regex the overlong pattern is handed to is the one linear
    // adjacent-quantifier check, counted rather than timed. Second, the pattern
    // is sized so that a scan by the nested-group regex (about 10^12 steps at a
    // million characters) could not finish inside the test's own timeout.
    const unclosed = '(' + '*'.repeat(1_000_000);
    const test = vi.spyOn(RegExp.prototype, 'test');
    expect(hasReDoSRisk(unclosed)).toBe(true);
    const overlong = test.mock.calls.filter(([input]) => input.length > 5000);
    test.mockRestore();
    expect(overlong).toHaveLength(1);
  });
});
