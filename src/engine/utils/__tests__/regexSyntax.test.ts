import { describe, it, expect } from 'vitest';
import { classEnd } from '../regexSyntax';

describe('classEnd', () => {
  it.each([
    ['[abc]x', 5],
    ['[]a]x', 4], // a leading `]` is a member
    ['[^]a]x', 5],
    ['[\\]a]x', 5], // an escaped `]` is a member
    ['[[:digit:]]+x', 11], // a POSIX class is skipped whole
    ['[[:a]b]x', 5], // `[:a]` has no `:]`, so it is not a POSIX class
  ])('ends %s just past its closing bracket', (pattern, end) => {
    expect(classEnd(pattern, 0)).toBe(end);
  });

  it('returns -1 when nothing closes the class', () => {
    expect(classEnd('[abc', 0)).toBe(-1);
    expect(classEnd('[]', 0)).toBe(-1);
    expect(classEnd('x[\\]', 1)).toBe(-1);
  });
});
