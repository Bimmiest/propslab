import { describe, it, expect } from 'vitest';
import { matchInputs } from '../regexMatch';

describe('matchInputs', () => {
  it('returns per-input match info aligned to the inputs', () => {
    const out = matchInputs('\\d+', ['abc', 'id=42', 'x']);
    expect(out).not.toBeNull();
    expect(out!.map((r) => r?.match ?? null)).toEqual([null, '42', null]);
  });

  it('captures named groups and their spans', () => {
    const [r] = matchInputs('user=(?<user>\\w+)', ['user=alice'])!;
    expect(r).not.toBeNull();
    expect(r!.groups).toEqual({ user: 'alice' });
    // "alice" starts at index 5.
    expect(r!.groupSpans['user']).toEqual([5, 10]);
    expect(r!.index).toBe(0);
    expect(r!.match).toBe('user=alice');
  });

  it('supports Splunk (?P<name>...) syntax', () => {
    const [r] = matchInputs('(?P<num>\\d+)', ['id 7'])!;
    expect(r!.groups).toEqual({ num: '7' });
  });

  it('runs a backtracking-prone pattern, which only a PCRE limit stops (#368)', () => {
    // Valid PCRE that Splunk runs, so it is not refused.
    expect(matchInputs('(a+)+$', ['aaaa'])).toEqual([{ index: 0, match: 'aaaa', groups: {}, groupSpans: {} }]);
    // Past MATCH_LIMIT's default it is no match, as an EXTRACT would be.
    expect(matchInputs('(a+)+$', [`${'a'.repeat(30)}!`])).toEqual([null]);
  });

  it('returns null overall for an invalid pattern', () => {
    expect(matchInputs('(', ['x'])).toBeNull();
  });

  it('omits groups that did not participate in the match', () => {
    const [r] = matchInputs('(?<a>x)|(?<b>y)', ['y'])!;
    expect(r!.groups).toEqual({ b: 'y' });
    expect(r!.groupSpans['a']).toBeUndefined();
  });

  it('keeps a group named __proto__ (#430)', () => {
    const [r] = matchInputs('(?<__proto__>\\w+)=(?<v>\\d+)', ['x=1'])!;
    expect(Object.keys(r!.groups)).toEqual(['__proto__', 'v']);
    expect(Object.getOwnPropertyDescriptor(r!.groups, '__proto__')?.value).toBe('x');
    expect(Object.getOwnPropertyDescriptor(r!.groupSpans, '__proto__')?.value).toEqual([0, 1]);
    // Still a plain object, so it survives postMessage and Object.entries as before.
    expect(Object.getPrototypeOf(r!.groups)).toBe(Object.prototype);
    expect(Object.entries(structuredClone(r!.groups))).toEqual([['__proto__', 'x'], ['v', '1']]);
  });
});
