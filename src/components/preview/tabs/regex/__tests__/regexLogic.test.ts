import { describe, it, expect } from 'vitest';
import {
  addBlockReason,
  alignResults,
  buildGroupColorMap,
  classNameError,
  countMatched,
  extractNamedGroups,
  highlightSegments,
} from '../regexLogic';
import { matchInputs, type RegexMatchInfo } from '../../../../../engine/regexMatch';
import { fieldColorAt } from '../../shared/fieldColors';

/** The first match of `pattern` in `raw`, as the worker reports it. */
function matchOf(pattern: string, raw: string): RegexMatchInfo {
  const info = matchInputs(pattern, [raw])?.[0];
  if (!info) throw new Error(`${pattern} does not match ${raw}`);
  return info;
}

const colors = new Map([
  ['ip', 'red'],
  ['m', 'blue'],
]);
/** Segments as `kind:text`, the part of each that is drawn. */
const drawn = (raw: string, pattern: string) =>
  highlightSegments(raw, matchOf(pattern, raw), colors).map((s) => `${s.kind}:${s.text}`);

describe('highlightSegments', () => {
  it('draws the text around a group-less match muted and the match whole', () => {
    expect(drawn('a 42 b', '\\d+')).toEqual(['outside:a ', 'whole:42', 'outside: b']);
  });

  it('omits the text before or after a match at either end', () => {
    expect(drawn('42', '\\d+')).toEqual(['whole:42']);
  });

  it('draws each named group in its colour, with the match text between groups', () => {
    const raw = 'x 10.0.0.1 GET /a';
    const segments = highlightSegments(raw, matchOf('(?P<ip>[\\d.]+) (?P<m>\\w+) /', raw), colors);
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'outside:x ',
      'group:10.0.0.1',
      'between: ',
      'group:GET',
      'between: /',
      'outside:a',
    ]);
    expect(segments[1]).toMatchObject({ key: 'grp-ip', name: 'ip', color: 'red' });
    expect(segments[2]!.key).toBe('mid-10');
  });

  it('falls back to the primary text colour for a group with no assigned colour', () => {
    const raw = 'k=v';
    const group = highlightSegments(raw, matchOf('k=(?<other>v)', raw), colors).find((s) => s.kind === 'group');
    expect(group).toMatchObject({ name: 'other', color: 'var(--color-text-primary)' });
  });

  it('draws only the part of a lookahead group inside the match, once (#430)', () => {
    const raw = 'foo barbaz qux';
    const segments = highlightSegments(raw, matchOf('bar(?=(?P<x>baz))', raw), colors);
    expect(segments.map((s) => s.text).join('')).toBe(raw);
    expect(segments.some((s) => s.kind === 'group')).toBe(false);
  });

  it('draws a group nested in another once, as part of the outer one', () => {
    const raw = 'ab';
    const segments = highlightSegments(raw, matchOf('(?<outer>a(?<inner>b))', raw), colors);
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual(['group:ab']);
  });
});

describe('classNameError', () => {
  it.each([
    ['', /Enter a class name/],
    ['a=b', /cannot contain "="/],
    ['a b', /only letters, digits/],
    ['[x]', /only letters, digits/],
  ])('rejects %j', (name, message) => {
    expect(classNameError(name)).toMatch(message);
  });

  it('accepts the characters Splunk class names use', () => {
    expect(classNameError('my_class-1.v2')).toBeNull();
  });
});

describe('addBlockReason', () => {
  const inputs = ['a'];
  const ok = { pattern: 'a', status: 'ok' as const, inputs };

  it('has nothing to say without a valid pattern', () => {
    expect(addBlockReason('', null, ok, '', inputs)).toEqual({ reason: null, isError: false });
    expect(addBlockReason('(', 'bad', ok, '', inputs)).toEqual({ reason: null, isError: false });
  });

  it('allows a settled ok run of this pattern over these inputs', () => {
    expect(addBlockReason('a', null, ok, 'a', inputs)).toEqual({ reason: null, isError: false });
  });

  it('blocks a timed-out or uncompilable pattern as an error', () => {
    const timedOut = addBlockReason('a', null, { ...ok, status: 'timeout' }, 'a', inputs);
    expect(timedOut.reason).toMatch(/timed out/);
    expect(timedOut.isError).toBe(true);
    const invalid = addBlockReason('a', null, { ...ok, status: 'invalid' }, 'a', inputs);
    expect(invalid.reason).toMatch(/won't compile/);
    expect(invalid.isError).toBe(true);
  });

  it('waits while the results belong to another pattern or other inputs', () => {
    const wait = { reason: 'Wait for the pattern to finish testing before adding it.', isError: false };
    expect(addBlockReason('ab', null, ok, 'ab', inputs)).toEqual(wait);
    expect(addBlockReason('a', null, { ...ok, status: 'pending' }, 'a', inputs)).toEqual(wait);
    expect(addBlockReason('a', null, ok, 'a', ['a'])).toEqual(wait);
  });
});

describe('alignResults and countMatched', () => {
  const hit = matchOf('a', 'a');

  it('is empty with nothing settled', () => {
    expect(alignResults(null, ['a'])).toEqual([]);
  });

  it('returns the settled results as they are for the very inputs they were matched over', () => {
    const inputs = ['a', 'b'];
    const results = [hit, null];
    expect(alignResults({ pattern: 'a', inputs, results }, inputs)).toBe(results);
  });

  it('aligns results to new inputs by text, leaving unseen text undefined', () => {
    const aligned = alignResults({ pattern: 'a', inputs: ['a', 'b'], results: [hit, null] }, ['b', 'c', 'a']);
    expect(aligned).toEqual([null, undefined, hit]);
    expect(countMatched(aligned)).toBe(1);
  });
});

describe('named groups', () => {
  it('lists every spelling of a named group, in order, and none for an invalid pattern', () => {
    expect(extractNamedGroups("(?P<a>x)(?<b>y)(?'c'z)")).toEqual(['a', 'b', 'c']);
    expect(extractNamedGroups('(')).toEqual([]);
    expect(extractNamedGroups('')).toEqual([]);
  });

  it('colours groups by position in the theme palette', () => {
    const map = buildGroupColorMap(['a', 'b'], 'dark');
    expect([...map]).toEqual([
      ['a', fieldColorAt(0, 'dark')],
      ['b', fieldColorAt(1, 'dark')],
    ]);
  });
});
