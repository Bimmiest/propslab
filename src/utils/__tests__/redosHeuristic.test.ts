import { describe, it, expect } from 'vitest';
import { hasReDoSRisk } from '../redosHeuristic';

// The heuristic is advisory now — it ranks the MCP server's timeout suspects —
// so these pin its verdicts only; no pattern is refused on its word.

describe('hasReDoSRisk — strengthened heuristic (#11/#34)', () => {
  it.each([
    '(\\d+)+',        // nested quantified group
    '(.+)*x',         // nested group, star outer
    '(.*,){20}',      // bounded repetition of a group with an inner quantifier
    'a*a*',           // adjacent same-atom quantifiers
    '\\d+\\d+',       // adjacent same-atom quantifiers (escaped atom)
    'a*a*a*a*a*a*a*c', // long adjacent run
  ])('flags catastrophic pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });

  it.each([
    '(foo|bar)+',     // benign alternation (NOT flagged — needs real overlap analysis)
    'a+b+',           // different atoms
    '\\d+\\.\\d+',    // digits.digits (dot between, not adjacent same atom)
    '(ab){3}',        // bounded group with no inner quantifier
    '\\d{2,3}',       // a plain bound
    '(?<num>\\d+)',   // a single named group
  ])('does not flag benign pattern %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
  });
});

describe('hasReDoSRisk — ambiguity analysis (#55)', () => {
  it.each([
    '(\\d+\\.){3}\\d+',      // canonical IPv4 — `\d+` cannot match the `.`
    '^(?:[^ ]* ){2}',        // Splunk docs' own TIME_PREFIX recipe
    '(?:[^,]*,)+',           // CSV field walk
    '(?:[^"]*"){2}',         // walk to the second quote
    '(?:\\d+[a-z]+)+',       // boundary is the group's own start, and it is unambiguous
    '(?:\\[[^\\]]*\\])+',    // bracketed segments
    '(?i-s:\\d+\\.)+',       // a scoped flag group is analysed like any other
  ])('does not flag safe repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
  });

  it.each([
    '(a+)+',                 // classic nested quantifier
    '(\\w+)*',
    '(?:\\d*)*',
    '([a-z]+\\w*)+',         // `\w` overlaps `[a-z]`
    '(\\s*\\S*)+',           // body can match empty
    '(?:\\w+=\\S+\\s*)+',    // trailing `\S+` can eat the next iteration's `\w+`
    '(?i:(x+)+)',            // inside a scoped flag group
  ])('flags ambiguous repeated group %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });
});

describe('hasReDoSRisk — adjacent quantifiers compare whole atoms (#365)', () => {
  it.each(['\\d+d+', '\\.+.+', 'd+\\d+', '\\w*w*'])('does not read an escape and its bare letter as one atom: %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(false);
  });

  it.each(['\\\\d+d+', '\\.+\\.+', 'x\\d+\\d+'])('still flags a repeated atom after escaped backslashes: %s', (p) => {
    expect(hasReDoSRisk(p)).toBe(true);
  });
});
