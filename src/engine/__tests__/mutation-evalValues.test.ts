// Tests written against mutants that survived `npm run test:mutation` (#370).
// eval's value model — the coercions and comparisons every operator and builtin
// share — was only ever reached through whole expressions, which left most of
// its branches free to change: `if(0, …)` taking the true branch, `x / 0`
// yielding Infinity, `max("b", "a")` picking the first argument. These pin the
// rules directly, and then through the expressions a user writes.
//
// Doc-derived (Splunk eval documentation).
import { describe, it, expect } from 'vitest';
import {
  addOrConcat,
  arith,
  compare,
  isNumericValue,
  minMax,
  numArg,
  parseDecimal,
  parseNumber,
  strArg,
  toBool,
  toMv,
  toNum,
  toStr,
  toTri,
} from '../processors/eval/values';
import { evaluateExpression } from '../processors/eval/evaluator';
import type { SplunkEvent } from '../types';
import { makeEvent } from '../../test/makeEvent';

function event(fields: Record<string, string | string[]> = {}): SplunkEvent {
  return makeEvent('raw', { fields });
}

const value = (expr: string, fields: Record<string, string | string[]> = {}) =>
  evaluateExpression(expr, event(fields), undefined, 0);

describe('parseDecimal', () => {
  it.each([
    ['7', 7],
    ['-7', -7],
    ['+7', 7],
    ['12.5', 12.5],
    ['12.', 12],
    ['.25', 0.25],
    ['1e3', 1000],
    ['1E+3', 1000],
    ['2.5e-1', 0.25],
    ['10e10', 1e11],
    [' 42 ', 42],
  ])('reads %j as %d', (s, n) => {
    expect(parseDecimal(s)).toBe(n);
  });

  it.each([
    '',
    ' ',
    'abc',
    '1a',
    'a1',
    '1.2.3',
    '.',
    '+',
    '-',
    'e5',
    '1e',
    '1e+',
    '--1',
    '1 2',
    '0x10',
    'Infinity',
    '1e999',
  ])('refuses %j', (s) => {
    expect(parseDecimal(s)).toBeNull();
  });
});

describe('parseNumber', () => {
  it('reads a decimal, and the exact text of a non-finite number (#446)', () => {
    expect(parseNumber(' 42 ')).toBe(42);
    expect(parseNumber('Infinity')).toBe(Infinity);
    expect(parseNumber('-Infinity')).toBe(-Infinity);
    expect(parseNumber('NaN')).toBe(NaN);
  });

  it.each(['inf', '-inf', 'nan', 'infinity', 'NAN', ' Infinity', 'abc', ''])('refuses %j', (s) => {
    expect(parseNumber(s)).toBeNull();
  });
});

describe('toBool', () => {
  it.each([
    [null, false],
    [undefined, false],
    [true, true],
    [false, false],
    [0, false],
    [1, true],
    [-1, true],
    [0.5, true],
    ['', false],
    ['0', false],
    ['false', false],
    ['FALSE', false],
    ['False', false],
    ['1', true],
    ['no', true],
    ['true', true],
    [' ', true],
    [[], false],
    [['0'], true],
    [['a', 'b'], true],
  ] as const)('reads %j as %s', (v, b) => {
    expect(toBool(v as never)).toBe(b);
  });
});

describe('toTri', () => {
  it('keeps NULL as NULL and reads everything else through toBool', () => {
    expect(toTri(null)).toBeNull();
    expect(toTri(undefined)).toBeNull();
    expect(toTri(0)).toBe(false);
    expect(toTri('x')).toBe(true);
  });
});

describe('toNum', () => {
  it.each([
    [null, 0],
    [undefined, 0],
    [5, 5],
    [true, 1],
    [false, 0],
    ['12', 12],
    ['abc', 0],
    ['', 0],
    [['3', '4'], 3],
    [[], 0],
    [['x'], 0],
  ] as const)('reads %j as %d', (v, n) => {
    expect(toNum(v as never)).toBe(n);
  });
});

describe('numArg', () => {
  it.each([
    [null, null],
    [undefined, null],
    [5, 5],
    // A number is taken as it is (#446). The old reading turned NaN and
    // Infinity into NULL; Splunk keeps both as numbers.
    [NaN, NaN],
    [Infinity, Infinity],
    [true, 1],
    [false, 0],
    ['12', 12],
    ['abc', null],
    [['3', '4'], 3],
    [[], null],
    [['x'], null],
  ] as const)('reads %j as %s', (v, n) => {
    expect(numArg(v as never)).toBe(n);
  });
});

describe('toStr, strArg and toMv', () => {
  it('toStr turns NULL into "" and joins a multivalue with spaces', () => {
    expect(toStr(null)).toBe('');
    expect(toStr(undefined)).toBe('');
    expect(toStr(['a', 'b'])).toBe('a b');
    expect(toStr(3)).toBe('3');
    expect(toStr(false)).toBe('false');
  });

  it('strArg keeps NULL as NULL but "" as ""', () => {
    expect(strArg(null)).toBeNull();
    expect(strArg(undefined)).toBeNull();
    expect(strArg('')).toBe('');
    expect(strArg(['a', 'b'])).toBe('a b');
  });

  it('toMv wraps a scalar and drops NULL', () => {
    expect(toMv(null)).toEqual([]);
    expect(toMv(undefined)).toEqual([]);
    expect(toMv('a')).toEqual(['a']);
    expect(toMv(3)).toEqual(['3']);
    expect(toMv(['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('isNumericValue', () => {
  it('accepts numbers and decimal strings only', () => {
    expect(isNumericValue(3)).toBe(true);
    // NaN and Infinity are numbers (#446), which the old reading refused.
    expect(isNumericValue(NaN)).toBe(true);
    expect(isNumericValue(-Infinity)).toBe(true);
    expect(isNumericValue('3')).toBe(true);
    expect(isNumericValue('x')).toBe(false);
    expect(isNumericValue(true)).toBe(false);
    expect(isNumericValue(null)).toBe(false);
    expect(isNumericValue(['3'])).toBe(false);
  });
});

describe('addOrConcat and arith', () => {
  it('propagates NULL from either side of +', () => {
    expect(addOrConcat(null, 1)).toBeNull();
    expect(addOrConcat(undefined, 1)).toBeNull();
    expect(addOrConcat(1, null)).toBeNull();
    expect(addOrConcat(1, undefined)).toBeNull();
    // Beside a string too: NULL is not "" to concatenate.
    expect(addOrConcat(null, 'a')).toBeNull();
    expect(addOrConcat(undefined, 'a')).toBeNull();
    expect(addOrConcat('a', null)).toBeNull();
    expect(addOrConcat('a', undefined)).toBeNull();
  });

  // Operands of unknown static type are read as fields are.
  it('adds two fields that look numeric, and concatenates two fields otherwise', () => {
    expect(addOrConcat('2', 3)).toBe(5);
    expect(addOrConcat('2', '3')).toBe(5);
    expect(addOrConcat('a', 'b')).toBe('ab');
    // Whichever side is not numeric turns the sum into a concatenation.
    expect(addOrConcat('5', 'a')).toBe('5a');
    expect(addOrConcat('a', '5')).toBe('a5');
  });

  it('concatenates the text of both sides beside a side that is statically text (#522)', () => {
    expect(addOrConcat('5', '1', 'string', 'string')).toBe('51');
    expect(addOrConcat('5', '1', 'string', 'dynamic')).toBe('51');
    expect(addOrConcat('5', '1', 'dynamic', 'string')).toBe('51');
  });

  // #446 and #522 corrected the old reading, which concatenated a number
  // beside text ("a3").
  it('adds beside a side that is statically a number, NULL for a field that is not numeric', () => {
    expect(addOrConcat('2', 3, 'dynamic', 'number')).toBe(5);
    expect(addOrConcat(3, '2', 'number', 'dynamic')).toBe(5);
    expect(addOrConcat('a', 3, 'dynamic', 'number')).toBeNull();
    expect(addOrConcat(3, 'a', 'number', 'dynamic')).toBeNull();
    expect(addOrConcat(['5', '6'], 1, 'dynamic', 'number')).toBeNull();
  });

  it('is NULL for static text beside a static number, a type error in Splunk (#522)', () => {
    expect(addOrConcat('5', 1, 'string', 'number')).toBeNull();
    expect(addOrConcat(1, '5', 'number', 'string')).toBeNull();
  });

  it('reads a multivalue with one value as that value', () => {
    expect(addOrConcat(['5'], 1, 'dynamic', 'number')).toBe(6);
    expect(addOrConcat('a', ['b'])).toBe('ab');
  });

  it.each([
    ['-', 7, 2, 5],
    ['*', 7, 2, 14],
    ['/', 7, 2, 3.5],
    ['%', 7, 2, 1],
    ['/', 7, 0, null],
    ['%', 7, 0, null],
    ['/', 0, 5, 0],
    ['%', 0, 5, 0],
  ] as const)('%s on %d and %d is %s', (op, a, b, out) => {
    expect(arith(a, b, op)).toBe(out);
  });

  it('propagates NULL and non-numeric operands', () => {
    expect(arith(null, 1, '-')).toBeNull();
    expect(arith(1, 'x', '*')).toBeNull();
  });
});

describe('compare', () => {
  it('is NULL when either side is NULL', () => {
    for (const [l, r] of [
      [null, 1],
      [undefined, 1],
      [1, null],
      [1, undefined],
      // Against a string too: NULL is not "".
      [null, ''],
      [undefined, ''],
      ['', null],
      ['', undefined],
    ] as const) {
      expect(compare(l, r, '==')).toBeNull();
    }
  });

  it.each([
    ['==', 2, 2, true],
    ['=', 2, 2, true],
    ['==', 2, 3, false],
    ['!=', 2, 3, true],
    ['!=', 2, 2, false],
    ['!=', 3, 2, true],
    ['<', 2, 3, true],
    ['<', 3, 3, false],
    ['<', 4, 3, false],
    ['>', 4, 3, true],
    ['>', 3, 3, false],
    ['>', 2, 3, false],
    ['<=', 3, 3, true],
    ['<=', 2, 3, true],
    ['<=', 4, 3, false],
    ['>=', 3, 3, true],
    ['>=', 4, 3, true],
    ['>=', 2, 3, false],
    ['~~', 1, 1, false],
  ] as const)('%s on %d and %d is %s', (op, l, r, out) => {
    expect(compare(l, r, op)).toBe(out);
  });

  // Operands of unknown static type are read as fields are.
  it('compares two fields as numbers when both look numeric, and as text otherwise', () => {
    // Numerically 10 > 9; as text "10" < "9".
    expect(compare('10', '9', '>')).toBe(true);
    expect(compare(10, '9', '<')).toBe(false);
    expect(compare('10', 'x9', '<')).toBe(true);
    expect(compare('10', 'abc', '>')).toBe(false);
    expect(compare('abc', '10', '==')).toBe(false);
  });

  // #446 and #522 corrected the old reading, under which a non-numeric string
  // against a number was compared as text ("abc" > 10 was true).
  it('reads a field as a number against a static number, NULL when it is not numeric (#522)', () => {
    expect(compare('10', 9, '>', 'dynamic', 'number')).toBe(true);
    expect(compare(10, '10.0', '==', 'number', 'dynamic')).toBe(true);
    expect(compare(9, 10, '<', 'number', 'number')).toBe(true);
    expect(compare('abc', 5, '<', 'dynamic', 'number')).toBeNull();
    expect(compare(5, 'abc', '!=', 'number', 'dynamic')).toBeNull();
    expect(compare(true, 1, '==', 'dynamic', 'number')).toBeNull();
  });

  it('compares a field as its text against static text (#522)', () => {
    expect(compare('10', '9', '>', 'dynamic', 'string')).toBe(false);
    expect(compare('9', '10', '<', 'string', 'dynamic')).toBe(false);
    expect(compare('10', '10.0', '==', 'dynamic', 'string')).toBe(false);
    expect(compare('10', '10', '==', 'dynamic', 'string')).toBe(true);
    expect(compare('10', '9', '>', 'string', 'string')).toBe(false);
    expect(compare('5', '1', '>', 'string', 'string')).toBe(true);
  });

  it('is NULL for static text against a static number, a type error in Splunk (#522)', () => {
    expect(compare('10', 9, '>', 'string', 'number')).toBeNull();
    expect(compare(9, '9', '==', 'number', 'string')).toBeNull();
  });
});

describe('minMax', () => {
  it('orders numbers numerically, below every string', () => {
    expect(minMax([10, 9, '3'], 'max')).toBe(10);
    expect(minMax([10, 9, '3'], 'min')).toBe('3');
    expect(minMax(['b', 5, 'a'], 'max')).toBe('b');
    expect(minMax(['b', 5, 'a'], 'min')).toBe(5);
    expect(minMax(['a', 5], 'min')).toBe(5);
    expect(minMax(['b', 'a', 'c'], 'min')).toBe('a');
    expect(minMax(['b', 'a', 'c'], 'max')).toBe('c');
  });

  it('keeps the first of equal candidates', () => {
    expect(minMax(['1', 1], 'max')).toBe('1');
    expect(minMax(['1', 1], 'min')).toBe('1');
  });

  it('skips NULLs, flattens multivalues, and is NULL with nothing left', () => {
    expect(minMax([null, 3, ['7', '1']], 'max')).toBe('7');
    expect(minMax([null, 3, ['7', '1']], 'min')).toBe('1');
    expect(minMax([null], 'min')).toBeNull();
    expect(minMax([], 'max')).toBeNull();
  });
});

describe('the same rules, through expressions', () => {
  it('reads a number condition as true unless it is 0', () => {
    expect(value('if(0, "t", "f")')).toBe('f');
    expect(value('if(2, "t", "f")')).toBe('t');
    expect(value('if("false", "t", "f")')).toBe('f');
    expect(value('if(missing, "t", "f")')).toBe('f');
  });

  it('divides by zero to NULL', () => {
    expect(value('10 / 0')).toBeNull();
    expect(value('10 % 0')).toBeNull();
    expect(value('10 / 4')).toBe(2.5);
    expect(value('10 % 4')).toBe(2);
  });

  it('reads a multivalue field by its first value for arithmetic', () => {
    expect(value('n * 2', { n: ['3', '4'] })).toBe(6);
  });
});
