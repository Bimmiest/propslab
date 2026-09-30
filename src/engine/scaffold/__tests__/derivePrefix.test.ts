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
    // No stopwatch (#507). The anchored regex this replaced retried from every
    // start position, so its cost was quadratic and lived inside one regex
    // call, which nothing can count. The input is sized instead so that the
    // quadratic version cannot finish inside the test's own timeout (a million
    // characters is about 5*10^11 steps; 50,000 took seconds), while the
    // backward scan makes a few million single-character checks.
    const long = 'a'.repeat(1_000_000);
    expect(derivePrefix(long)).toBe('');
    expect(derivePrefix(`${long}=`)).toBe(`${long}=`);
    expect(derivePrefix('a '.repeat(500_000))).toBe('');
  });
});
