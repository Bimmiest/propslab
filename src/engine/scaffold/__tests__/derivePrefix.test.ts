import { describe, it, expect } from 'vitest';
import { derivePrefix } from '../analyzers/timestamp';

// The regex derivePrefix used before it became a backward scan (#427). Kept
// here as the reference its results must still equal.
function reference(before: string): string {
  if (!before) return '';
  const kv = /(["']?[\w.-]+["']?\s*[:=]\s*["']?)$/.exec(before);
  if (kv) return kv[1] ?? '';
  const punct = /([^\w\s]{1,4})$/.exec(before);
  if (punct) return punct[1] ?? '';
  return '';
}

describe('derivePrefix (#427)', () => {
  it('returns the trailing key boundary or punctuation delimiter', () => {
    expect(derivePrefix('id=5 time=')).toBe('time=');
    expect(derivePrefix('{"ts": "')).toBe('"ts": "');
    expect(derivePrefix("x 'a.b-c' = '")).toBe("'a.b-c' = '");
    expect(derivePrefix('host [')).toBe('[');
    expect(derivePrefix('abc ')).toBe('');
    expect(derivePrefix('')).toBe('');
  });

  it('matches the reference regex on generated inputs', () => {
    // Characters that exercise every part of the pattern, plus neighbours
    // that are almost-but-not members of its classes.
    const alphabet = ['a', 'Z', '0', '_', '.', '-', '"', "'", ':', '=', ' ', '\t', '[', ']', 'é', ' ', '/'];
    let seed = 427;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let t = 0; t < 20000; t++) {
      let s = '';
      const len = rand(12);
      for (let k = 0; k < len; k++) s += alphabet[rand(alphabet.length)]!;
      expect(derivePrefix(s), JSON.stringify(s)).toBe(reference(s));
    }
  });

  it('stays linear on a long run of word characters', () => {
    const long = 'a'.repeat(50_000);
    const started = performance.now();
    expect(derivePrefix(long)).toBe('');
    expect(derivePrefix(`${long}=`)).toBe(`${long}=`);
    expect(derivePrefix('a '.repeat(25_000))).toBe('');
    expect(performance.now() - started).toBeLessThan(200);
  });
});
