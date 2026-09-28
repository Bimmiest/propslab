import { describe, expect, it } from 'vitest';
import { countLines } from '../countLines';

describe('countLines', () => {
  it('matches split-based counting', () => {
    for (const text of ['a', 'a\n', '\n', 'a\nb', 'a\r\nb\r\n', '\n\n\n', 'x'.repeat(10) + '\n' + 'y']) {
      expect(countLines(text)).toBe(text.split('\n').length);
    }
  });

  it('is 0 for an empty buffer', () => {
    expect(countLines('')).toBe(0);
  });
});
