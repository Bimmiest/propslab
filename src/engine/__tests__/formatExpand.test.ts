// expandFormat's `${name}` references. The named-group branch is reached through
// whole transforms elsewhere; these pin its three outcomes directly, since a
// mutation run found the two that are not the common case unasserted: a name the
// match has no group for expands to nothing, and a match with no named groups at
// all leaves the reference in the text.
import { describe, it, expect } from 'vitest';
import { expandFormat, type FormatMatch } from '../transforms/format';

const match = (groups: Record<string, string | undefined> | undefined): FormatMatch =>
  Object.assign(['whole', 'one'], { groups });

describe('expandFormat — ${name} references', () => {
  it('expands a named group to its text', () => {
    expect(expandFormat('ip=${ip}!', match({ ip: '10.0.0.1' }))).toBe('ip=10.0.0.1!');
  });

  it('expands a name the match has no group for to nothing', () => {
    expect(expandFormat('a${nope}b', match({ ip: '10.0.0.1' }))).toBe('ab');
  });

  it('expands a named group that did not take part in the match to nothing', () => {
    expect(expandFormat('a${ip}b', match({ ip: undefined }))).toBe('ab');
  });

  it('leaves the reference in the text when the match has no named groups', () => {
    expect(expandFormat('a${ip}b', match(undefined))).toBe('a${ip}b');
  });

  it('expands numbered and named references in one FORMAT', () => {
    expect(expandFormat('$1/${ip}', match({ ip: 'x' }))).toBe('one/x');
  });
});
