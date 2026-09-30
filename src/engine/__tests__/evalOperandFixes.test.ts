// Eval operand handling: trim's character set (#474), multivalue operands in
// comparisons and IN (#475), and the expression parser's limits and literals
// (#485).
//
// Doc-derived (Splunk eval function and operator reference), not captured; no
// fixture covers eval, so each assertion is kept to the documented behaviour.
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../processors/eval/evaluator';
import type { SplunkEvent } from '../types';
import { makeEvent } from '../../test/makeEvent';

function event(fields: Record<string, string | string[]> = {}): SplunkEvent {
  return makeEvent('raw', { fields });
}

const value = (expr: string, fields: Record<string, string | string[]> = {}) =>
  evaluateExpression(expr, event(fields), undefined, 0);

describe('trim(X, Y) removes the characters in Y from both sides (#474)', () => {
  // Splunk eval functions: trim(<str>,<trim_chars>) "removes the characters in
  // trim_chars from both sides of the string".
  it.each([
    ['trim("xyyx", "x")', 'yy'],
    ['trim("\\"quoted\\"", "\\"")', 'quoted'],
    ['trim("xyxabyxy", "xy")', 'ab'],
    ['trim("xxx", "x")', ''],
    ['trim("zab", "xy")', 'zab'],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('trim, ltrim and rtrim share one default set, so they agree on the same input', () => {
    // NBSP is not in the default set for any of them (JS trim() would strip it).
    const nbsp = ' ';
    const input = ` \t${nbsp}a${nbsp}\n `;
    const f = { s: input };
    expect(value('trim(s)', f)).toBe(`${nbsp}a${nbsp}`);
    expect(value('ltrim(s)', f)).toBe(`${nbsp}a${nbsp}\n `);
    expect(value('rtrim(s)', f)).toBe(` \t${nbsp}a${nbsp}`);
  });
});

describe('multivalue operands match when any value does (#475)', () => {
  const mv = { mv: ['a', 'b'] };

  it.each([
    ['mv == "a"', true],
    ['mv == "b"', true],
    ['mv == "c"', false],
    // Never the space-joined form.
    ['mv == "a b"', false],
    ['"a" == mv', true],
    ['mv = "a"', true],
    ['mv != "c"', true],
    // != is the complement of ==, not "some value differs".
    ['mv != "a"', false],
    ['mv IN ("a")', true],
    ['mv IN ("c", "b")', true],
    ['mv IN ("c")', false],
    ['mv IN ("a b")', false],
    ['mv NOT IN ("a")', false],
    ['mv NOT IN ("c")', true],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr, mv)).toBe(out);
  });

  it('a multivalue field with no values compares as NULL, like a missing field', () => {
    const empty = { mv: [] as string[] };
    expect(value('mv == "a"', empty)).toBeNull();
    expect(value('mv != "a"', empty)).toBeNull();
    expect(value('mv IN ("a")', empty)).toBeNull();
    expect(value('mv NOT IN ("a")', empty)).toBeNull();
  });

  it('a multivalue result of a function is compared the same way', () => {
    expect(value('split("a,b", ",") == "b"')).toBe(true);
  });
});

describe('expression size limit (#485)', () => {
  it('rejects a 200k-term chain with a clear diagnostic, not a stack overflow', () => {
    const chain = Array.from({ length: 200_000 }, () => '1').join('+');
    expect(() => value(chain)).toThrow(/too long or deeply nested/);
    expect(() => value(chain)).not.toThrow(/call stack/);
  });

  it.each([
    ['concat', Array.from({ length: 5000 }, () => '"a"').join('.')],
    ['AND', Array.from({ length: 5000 }, () => '1').join(' AND ')],
    ['NOT', `${'NOT '.repeat(5000)}1`],
    ['unary minus', `${'- '.repeat(5000)}1`],
  ])('rejects a long %s chain', (_name, expr) => {
    expect(() => value(expr)).toThrow(/too long or deeply nested/);
  });

  // The limit is 1000 chained operations: the deepest tree accepted must also
  // evaluate without exhausting the stack, and one operation more is rejected.
  it.each([
    ['arithmetic', (n: number) => Array.from({ length: n + 1 }, () => '1').join('+')],
    ['concat', (n: number) => Array.from({ length: n + 1 }, () => '"a"').join('.')],
    ['OR', (n: number) => Array.from({ length: n + 1 }, () => 'false').join(' OR ')],
    ['NOT', (n: number) => `${'NOT '.repeat(n)}true`],
    ['unary minus', (n: number) => `${'- '.repeat(n)}1`],
  ])('%s: 1000 chained operations evaluate, 1001 are rejected', (_name, build) => {
    expect(() => value(build(1000))).not.toThrow();
    expect(() => value(build(1001))).toThrow(/more than 1000 chained operations/);
  });

  it('counts nesting through parentheses and calls, not just flat chains', () => {
    const wrapped = (n: number) => `${'abs('.repeat(n)}1${')'.repeat(n)}`;
    expect(value(wrapped(40))).toBe(1);
    const chain = (n: number) => Array.from({ length: n + 1 }, () => '1').join('+');
    // 990 additions inside 20 nested calls is 1010 levels in all.
    expect(() => value(`${'abs('.repeat(20)}${chain(990)}${')'.repeat(20)}`)).toThrow(/chained operations/);
  });

  it('still evaluates a chain of a few hundred terms', () => {
    const chain = Array.from({ length: 500 }, () => '1').join('+');
    expect(value(chain)).toBe(500);
  });
});

describe('exponent literals (#485)', () => {
  // The string "1e3" already coerces to 1000 (parseDecimal); the literal now
  // means the same thing.
  it.each([
    ['1e3', 1000],
    ['1E3', 1000],
    ['2.5e-1', 0.25],
    ['1e+2 + 1', 101],
    ['.5e1', 5],
    ['-1e2', -100],
    ['1e3 * 2', 2000],
  ] as const)('%s = %d', (expr, n) => {
    expect(value(expr)).toBe(n);
  });

  it('agrees with the coercion of the same text as a string', () => {
    expect(value('"1e3" + 1')).toBe(value('1e3 + 1'));
  });

  it('an e with no digits after it is not an exponent', () => {
    expect(() => value('1e')).toThrow();
    expect(() => value('1e+')).toThrow();
  });
});

describe('unary minus repeats (#485)', () => {
  it.each([
    ['- - 3', 3],
    ['- - - 3', -3],
    ['-(-3)', 3],
    ['- -x', 4],
    ['-x', -4],
  ] as const)('%s = %d', (expr, n) => {
    expect(value(expr, { x: '4' })).toBe(n);
  });
});
