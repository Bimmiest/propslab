// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins an eval builtin's documented result for inputs the suite never
// tried: the NULL-in/NULL-out rule on every string and math function, the
// boundaries of substr() and mvindex(), and the trim family's custom sets.
//
// Doc-derived (Splunk eval function reference), not captured; no fixture
// covers eval, so each assertion is kept to the documented behaviour.
import { describe, it, expect, vi } from 'vitest';
import { evaluateExpression } from '../processors/eval/evaluator';
import type { SplunkEvent } from '../types';

function event(fields: Record<string, string | string[]> = {}): SplunkEvent {
  return {
    _raw: 'raw',
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

const value = (expr: string, fields: Record<string, string | string[]> = {}) =>
  evaluateExpression(expr, event(fields), undefined, 0);

describe('NULL in, NULL out', () => {
  it.each([
    'lower(missing)', 'upper(missing)', 'len(missing)', 'substr(missing, 1)', 'replace(missing, "a", "b")',
    'trim(missing)', 'ltrim(missing)', 'rtrim(missing)', 'urldecode(missing)', 'split(missing, ",")',
    'mvjoin(missing, ",")', 'tostring(missing)', 'abs(missing)', 'ceiling(missing)', 'ceil(missing)',
    'floor(missing)', 'round(missing)', 'sqrt(missing)', 'pow(missing, 2)', 'pow(2, missing)',
    'log(missing)', 'log(8, missing)', 'ln(missing)', 'exp(missing)', 'mvcount(missing)', 'strftime(missing, "%Y")',
    'abs("x")', 'sqrt("x")', 'null()',
  ])('%s', (expr) => {
    expect(value(expr)).toBeNull();
  });
});

describe('the math functions compute what they name', () => {
  it.each([
    ['abs(-3)', 3], ['ceiling(1.2)', 2], ['ceil(-1.2)', -1], ['floor(1.8)', 1], ['floor(-1.2)', -2],
    ['sqrt(16)', 4], ['pow(2, 10)', 1024], ['log(100)', 2], ['log(8, 2)', 3], ['ln(1)', 0], ['exp(0)', 1],
    ['round(2.5)', 3], ['round(-2.5)', -3], ['round(1.2345, 2)', 1.23], ['round(5, "x")', 5],
  ] as const)('%s = %d', (expr, n) => {
    expect(value(expr)).toBeCloseTo(n, 10);
  });

  it('pi() is π', () => {
    expect(value('pi()')).toBe(Math.PI);
  });
});

describe('substr', () => {
  it.each([
    ['substr("hello", 2)', 'ello'],
    ['substr("hello", 2, 3)', 'ell'],
    ['substr("hello", -3)', 'llo'],
    ['substr("hello", -3, 2)', 'll'],
    ['substr("hello", 2, 0)', ''],
    ['substr("hello", 2, -1)', ''],
    ['substr("hello", 9)', ''],
  ])('%s = %j', (expr, s) => {
    expect(value(expr)).toBe(s);
  });
});

describe('the trim family', () => {
  it('trim() strips surrounding whitespace', () => {
    expect(value('trim("  a b  ")')).toBe('a b');
  });

  it('ltrim() and rtrim() default to whitespace, and strip only their own side', () => {
    expect(value('ltrim(" \t a ")')).toBe('a ');
    expect(value('rtrim(" a \n\r")')).toBe(' a');
  });

  it('ltrim() and rtrim() take a set of characters, not a prefix', () => {
    expect(value('ltrim("xyxab", "yx")')).toBe('ab');
    expect(value('rtrim("abyxy", "xy")')).toBe('ab');
    expect(value('ltrim("zab", "xy")')).toBe('zab');
  });

  it('trim everything when every character is in the set', () => {
    expect(value('ltrim("xxx", "x")')).toBe('');
    expect(value('rtrim("xxx", "x")')).toBe('');
  });
});

describe('string functions', () => {
  it.each([
    ['lower("AbC")', 'abc'], ['upper("AbC")', 'ABC'], ['len("abc")', 3], ['len("")', 0],
    ['urldecode("a%20b")', 'a b'], ['urldecode("100%")', '100%'],
    ['nullif("a", "a")', null], ['nullif("a", "b")', 'a'], ['nullif(missing, "x")', null],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('split() and mvjoin() are inverses', () => {
    expect(value('split("a,b,c", ",")')).toEqual(['a', 'b', 'c']);
    expect(value('mvjoin(split("a,b", ","), "-")')).toBe('a-b');
  });
});

describe('type functions', () => {
  it.each([
    ['typeof(1)', 'Number'], ['typeof("a")', 'String'], ['typeof(1==1)', 'Bool'], ['typeof(missing)', 'Invalid'],
    ['typeof(split("a,b", ","))', 'MultiValue'],
    ['isnull(missing)', true], ['isnull("")', false], ['isnotnull(missing)', false], ['isnotnull("")', true],
    ['isint("3")', true], ['isint("3.5")', false], ['isbool(1==1)', true], ['isbool(1)', false],
    ['isstr("a")', true], ['isstr(1)', false],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it.each([
    ['tostring(255, "hex")', '0xff'],
    ['tostring(1234567.891, "commas")', '1,234,567.89'],
    ['tostring(90061, "duration")', '1+01:01:01'],
    ['tostring(3661, "duration")', '01:01:01'],
    ['tostring(-61, "duration")', '-00:01:01'],
    ['tostring("abc", "hex")', 'abc'],
    ['tostring(5)', '5'],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('tonumber() honours a base and rejects digits outside it', () => {
    expect(value('tonumber("z", 36)')).toBe(35);
    expect(value('tonumber("g", 16)')).toBeNull();
    expect(value('tonumber(" 12 ")')).toBe(12);
  });
});

describe('multivalue functions', () => {
  const mv = { m: ['a', 'b', 'c', 'd'] };

  it.each([
    ['mvindex(m, 0)', 'a'], ['mvindex(m, 3)', 'd'], ['mvindex(m, -1)', 'd'], ['mvindex(m, -4)', 'a'],
    ['mvindex(m, 4)', null], ['mvindex(m, -5)', null],
    ['mvindex(m, 1, 2)', ['b', 'c']], ['mvindex(m, 1, -1)', ['b', 'c', 'd']], ['mvindex(m, 2, 2)', 'c'],
    ['mvindex(m, 2, 1)', null], ['mvindex(m, 0, 4)', null], ['mvindex(m, 0, -5)', null],
  ] as const)('%s = %j', (expr, out) => {
    expect(value(expr, mv)).toEqual(out);
  });

  it('mvcount() counts, and is NULL for nothing', () => {
    expect(value('mvcount(m)', mv)).toBe(4);
    expect(value('mvcount("x")')).toBe(1);
  });

  it('mvfind() returns the first matching index, or NULL', () => {
    expect(value('mvfind(m, "^[cd]$")', mv)).toBe(2);
    expect(value('mvfind(m, "^a$")', mv)).toBe(0);
    expect(value('mvfind(m, "z")', mv)).toBeNull();
  });

  it('mvsort(), mvdedup() and mvappend() reshape the list', () => {
    expect(value('mvsort(m)', { m: ['b', 'a', 'B'] })).toEqual(['B', 'a', 'b']);
    expect(value('mvdedup(m)', { m: ['a', 'b', 'a'] })).toEqual(['a', 'b']);
    expect(value('mvappend("x", m, missing)', { m: ['a', 'b'] })).toEqual(['x', 'a', 'b']);
  });

  it('mvzip() stops at the shorter list and defaults to a comma', () => {
    expect(value('mvzip(a, b)', { a: ['1', '2', '3'], b: ['x', 'y'] })).toEqual(['1,x', '2,y']);
    expect(value('mvzip(a, b, "=")', { a: ['1'], b: ['x'] })).toEqual(['1=x']);
  });
});

describe('replace() backreferences', () => {
  it.each([
    ['replace("ab", "(a)(b)", "\\\\2\\\\1")', 'ba'],
    ['replace("ab", "(a)", "[\\\\1]")', '[a]b'],
    ['replace("a", "a", "x\\\\\\\\y")', 'x\\y'],
    ['replace("a", "a", "$1")', '$1'],
    ['replace("aa", "a", "b")', 'bb'],
  ])('%s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });
});

describe('stubbed functions warn, once per call, by name', () => {
  it.each(['md5', 'sha1', 'sha256', 'sha512'])('%s()', (fn) => {
    const warn = vi.fn();
    const out = evaluateExpression(`${fn}("x")`, event(), warn, 0);
    expect(out).toBe(`[${fn}() not simulated]`);
    expect(warn).toHaveBeenCalledWith(fn);
  });
});
