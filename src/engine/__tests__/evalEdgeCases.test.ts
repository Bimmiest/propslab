// Eval edge cases settled by #446: what the math functions and arithmetic give
// when a result is not an ordinary number, which strings + and the comparison
// operators read as numbers, tostring()'s Boolean and radix formats, the
// multivalue functions on NULL, and characters counted as code points. A test
// whose behaviour the Search Reference states says so; the rest cite #446.
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../processors/eval/evaluator';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';
import { makeEvent } from '../../test/makeEvent';
import { FIXED_NOW } from './runCtx';

type Fields = Record<string, string | string[]>;

const value = (expr: string, fields: Fields = {}) =>
  evaluateExpression(expr, makeEvent('raw', { fields }), undefined, 0);

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };

/** The fields of the one event `raw` makes under `[st]` plus `body`, with an optional transforms.conf. */
function fieldsOf(body: string, transforms = '', raw = 'x'): Fields {
  const { result } = runPipeline(raw, META, `[st]\nSHOULD_LINEMERGE = false\n${body}`, transforms, {
    perEventPipeline: false,
    captureOffsets: false,
    now: FIXED_NOW,
  });
  expect(result.events).toHaveLength(1);
  return result.events[0]!.fields;
}

/** The fields an INGEST_EVAL of `assignments` leaves on the event. */
const ingest = (assignments: string, raw = 'x') =>
  fieldsOf('TRANSFORMS-t = t\n', `[t]\nINGEST_EVAL = ${assignments}\n`, raw);

describe('a math function undefined at its argument is NULL (#446)', () => {
  it.each(['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'log(-1)', 'log(0, 10)', 'log(8, 0)', 'round(1.5, 400)'])(
    '%s',
    (expr) => {
      expect(value(expr)).toBeNull();
      expect(value(`isnull(${expr})`)).toBe(true);
      expect(value(`typeof(${expr})`)).toBe('Invalid');
    },
  );

  it('is NULL through arithmetic, not "NaN1"', () => {
    expect(value('sqrt(-1) + 1')).toBeNull();
    expect(value('ln(0) * 2')).toBeNull();
  });

  it('writes no field, and a later assignment that reads it is NULL too', () => {
    expect(fieldsOf('EVAL-r = sqrt(-1)\n')['r']).toBeUndefined();
    const f = ingest('a=sqrt(-1), x=a+1, y=if(isnull(x), "null", "set")');
    expect(f['a']).toBeUndefined();
    expect(f['x']).toBeUndefined();
    expect(f['y']).toBe('null');
  });

  it('computes the logarithm of a positive number in a positive base, base 1 giving an infinity', () => {
    expect(value('ln(1)')).toBe(0);
    expect(value('log(1000)')).toBeCloseTo(3, 12);
    expect(value('log(8, 2)')).toBeCloseTo(3, 12);
    expect(value('log(0.25, 0.5)')).toBeCloseTo(2, 12);
    expect(value('log(1, 2)')).toBe(0);
    expect(value('log(8, -2)')).toBeNull();
    expect(value('log(8, 1)')).toBe(Infinity);
    expect(value('log(0.5, 1)')).toBe(-Infinity);
  });
});

describe('pow() gives what floating point gives (#446)', () => {
  it.each([
    ['pow(0, -1)', Infinity],
    ['pow(0, -0.5)', Infinity],
    ['pow(-8, 0.5)', NaN],
    ['pow(0, 2)', 0],
    ['pow(0, 0)', 1],
    ['pow(2, -1)', 0.5],
  ] as const)('%s is %s', (expr, n) => {
    expect(value(expr)).toBe(n);
    expect(value(`typeof(${expr})`)).toBe('Number');
  });

  it('writes NaN into a field rather than writing no field', () => {
    expect(fieldsOf('EVAL-r = pow(-8, 0.5)\nEVAL-i = pow(0, -1)\n')).toMatchObject({ r: 'NaN', i: 'Infinity' });
  });
});

describe('an overflow is the number Infinity, and arithmetic keeps NaN (#446)', () => {
  it.each([
    ['exp(1000)', Infinity, 'Infinity'],
    ['pow(10, 400)', Infinity, 'Infinity'],
    ['1e308 * 10', Infinity, 'Infinity'],
    ['-1 * exp(1000)', -Infinity, '-Infinity'],
    ['-exp(1000)', -Infinity, '-Infinity'],
    ['exp(1000) - exp(1000)', NaN, 'NaN'],
  ] as const)('%s is %s, a number, shown as %j', (expr, n, shown) => {
    expect(value(expr)).toBe(n);
    expect(value(`typeof(${expr})`)).toBe('Number');
    expect(value(`isnull(${expr})`)).toBe(false);
    expect(value(`isnum(${expr})`)).toBe(true);
    expect(fieldsOf(`EVAL-r = ${expr}\n`)['r']).toBe(shown);
  });

  it('adds an infinity or a NaN as a number, rather than concatenating its name', () => {
    expect(value('exp(1000) + 1')).toBe(Infinity);
    expect(value('1 + exp(1000)')).toBe(Infinity);
    expect(value('(exp(1000) - exp(1000)) + 1')).toBe(NaN);
  });

  it('passes an infinity on through the math functions', () => {
    expect(value('abs(-1 * exp(1000))')).toBe(Infinity);
    expect(value('floor(exp(1000))')).toBe(Infinity);
    expect(value('round(exp(1000))')).toBe(Infinity);
    expect(value('round(-1 * exp(1000), 2)')).toBe(-Infinity);
  });

  it('compares an infinity numerically', () => {
    // As strings, "-Infinity" sorts after "-5".
    expect(value('-1 * exp(1000) < -5')).toBe(true);
    expect(value('exp(1000) == exp(1000)')).toBe(true);
  });

  it('compares NaN as unequal to everything, itself included, and as neither greater nor less', () => {
    const nan = '(exp(1000) - exp(1000))';
    expect(value(`${nan} == ${nan}`)).toBe(false);
    expect(value(`${nan} != ${nan}`)).toBe(true);
    expect(value(`${nan} > 1`)).toBe(false);
    expect(value(`${nan} < 1`)).toBe(false);
  });

  // Doc-derived (Search Reference, eval command): division by zero results in a null field.
  it('still divides by zero to NULL', () => {
    expect(value('exp(1000) / 0')).toBeNull();
    expect(value('exp(1000) % 0')).toBeNull();
  });
});

describe('tostring() (#446)', () => {
  // Doc-derived (Search Reference, tostring): "If the value is a Boolean value,
  // it returns the corresponding string value, "True" or "False"", and
  // tostring(15,"hex") is "0xF". The pipeline writes them as they are.
  it('writes a Boolean as True or False, and hex in upper case', () => {
    const f = fieldsOf('EVAL-t = tostring(1==1)\nEVAL-f = tostring(1==2)\nEVAL-h = tostring(15, "hex")\n');
    expect(f).toMatchObject({ t: 'True', f: 'False', h: '0xF' });
  });

  it("writes a negative integer in hex as its 64-bit two's complement", () => {
    expect(value('tostring(-255, "hex")')).toBe('0xFFFFFFFFFFFFFF01');
    expect(value('tostring(-1, "hex")')).toBe('0xFFFFFFFFFFFFFFFF');
    expect(value('tostring(0, "hex")')).toBe('0x0');
    expect(value('tostring(4096, "hex")')).toBe('0x1000');
  });

  it('writes a non-negative integer in binary with no prefix', () => {
    // Doc-derived (Search Reference, tostring): tostring(9,"binary") is "1001".
    expect(value('tostring(9, "binary")')).toBe('1001');
    expect(value('tostring(0, "binary")')).toBe('0');
    expect(value('tostring(-9, "binary")')).toBeNull();
  });

  it('is NULL for hex or binary of a number with a fraction', () => {
    expect(value('tostring(15.7, "hex")')).toBeNull();
    expect(value('tostring(9.5, "binary")')).toBeNull();
    expect(value('tostring(exp(1000), "hex")')).toBeNull();
    expect(fieldsOf('EVAL-h = tostring(15.7, "hex")\n')['h']).toBeUndefined();
  });

  it('passes a non-numeric value through the numeric formats', () => {
    expect(value('tostring("abc", "binary")')).toBe('abc');
    expect(value('tostring("abc", "duration")')).toBe('abc');
  });

  it('writes an infinity as its text, grouped as if digits by "commas", as seconds by "duration"', () => {
    expect(value('tostring(exp(1000))')).toBe('Infinity');
    expect(value('tostring(exp(1000), "commas")')).toBe('In,fin,ity');
    expect(value('tostring(-1 * exp(1000), "commas")')).toBe('-In,fin,ity');
    expect(value('tostring(exp(1000), "duration")')).toBe('00:00:Infinity');
    expect(value('tostring("Infinity", "commas")')).toBe('In,fin,ity');
    expect(fieldsOf('EVAL-c = tostring(exp(1000), "commas")\n')['c']).toBe('In,fin,ity');
  });

  it('wraps an integer past 64 bits in hex', () => {
    expect(value('tostring(pow(2, 64) + 5, "hex")')).toBe('0x0');
  });
});

describe('the text of a non-finite number reads as that number (#446)', () => {
  it.each([
    ['s + 1', 'Infinity', Infinity],
    ['s * 2', 'Infinity', Infinity],
    ['s + 1', '-Infinity', -Infinity],
    ['s + 1', 'NaN', NaN],
    ['abs(s)', '-Infinity', Infinity],
  ] as const)('%s with s = %j is %s', (expr, s, n) => {
    expect(value(expr, { s })).toBe(n);
    expect(value(`typeof(${expr})`, { s })).toBe('Number');
  });

  it('in comparisons and isnum(), but not in tonumber()', () => {
    expect(value('s > 5', { s: 'Infinity' })).toBe(true);
    expect(value('isnum(s)', { s: 'Infinity' })).toBe(true);
    expect(value('isnum(s)', { s: 'NaN' })).toBe(true);
    expect(value('tonumber(s)', { s: 'Infinity' })).toBeNull();
    expect(value('tonumber(s)', { s: 'NaN' })).toBeNull();
  });

  it('only in that exact spelling', () => {
    for (const s of ['inf', 'nan', 'infinity', '-inf']) {
      expect(value('s + 1', { s }), s).toBeNull();
      expect(value('isnum(s)', { s }), s).toBe(false);
      expect(value('tonumber(s)', { s }), s).toBeNull();
    }
  });

  it('so an infinity written to a field reads back as a number', () => {
    const f = ingest('a=exp(1000), b=a+1, t=typeof(a+1)');
    expect(f).toMatchObject({ a: 'Infinity', b: 'Infinity', t: 'Number' });
  });
});

describe('+ adds numbers, concatenates strings, and is NULL for a number beside text (#446)', () => {
  it.each([
    ['"5" + "1"', 6],
    ['"5" + 1', 6],
    ['1 + "5"', 6],
    ['"1e3" + 1', 1001],
    ['"abc" + "def"', 'abcdef'],
    ['"5" + "abc"', '5abc'],
    ['"abc" + 1', null],
    ['1 + "abc"', null],
    ['"inf" + 1', null],
  ] as const)('%s is %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('writes no field for a number beside text', () => {
    const f = fieldsOf('EVAL-r = _raw + 1\nEVAL-c = _raw + "1"\n', '', 'abc');
    expect(f['r']).toBeUndefined();
    expect(f['c']).toBe('abc1');
  });
});

describe('comparisons between strings and numbers (#446)', () => {
  it.each([
    ['"abc" > 5', null],
    ['"abc" == 5', null],
    ['"abc" != 5', null],
    ['5 < "abc"', null],
    ['"5" > "1"', true],
    ['"5" < "10"', false],
    ['"10" < "5"', true],
    ['"5" == "5.0"', false],
    ['"5" == 5.0', true],
    ['"10" > 5', true],
    ['"Infinity" > 5', true],
  ] as const)('%s is %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('takes the else branch of if() for a NULL comparison', () => {
    expect(value('if("abc" != 5, "y", "n")')).toBe('n');
    expect(value('if(NOT ("abc" == 5), "y", "n")')).toBe('n');
  });
});

describe('the multivalue functions on NULL (#446)', () => {
  it.each([
    'mvappend(missing, missing)',
    'mvdedup(missing)',
    'mvsort(missing)',
    'mvzip(missing, missing)',
    'mvzip(mv, missing)',
    'mvzip(missing, mv)',
    'mvcount(missing)',
    'mvindex(missing, 0)',
    'mvjoin(missing, ",")',
    'mvfilter(missing != "a")',
    'split("", "")',
  ])('%s is NULL, not an empty multivalue', (expr) => {
    expect(value(expr, { mv: ['a', 'b'] })).toBeNull();
  });

  it('appends only the values there are', () => {
    expect(value('mvappend(missing, "a")')).toEqual(['a']);
    expect(value('mvappend(missing, mv, missing)', { mv: ['a', 'b'] })).toEqual(['a', 'b']);
  });

  it('writes no field, so isnull() holds afterwards', () => {
    const f = fieldsOf('EVAL-m = mvappend(missing, other)\nEVAL-d = mvdedup(missing)\nEVAL-z = mvzip(_raw, missing)\n');
    expect(f['m']).toBeUndefined();
    expect(f['d']).toBeUndefined();
    expect(f['z']).toBeUndefined();
    const g = ingest('m=mvsort(missing), n=if(isnull(m), "null", "set"), a=mvappend(missing, "a")');
    expect(g['m']).toBeUndefined();
    expect(g['n']).toBe('null');
    expect(g['a']).toEqual(['a']);
  });
});

describe('characters are counted as code points (#446)', () => {
  // Doc-derived (Search Reference, len): "This function returns a count of the
  // UTF-8 code points in a string."
  it('len() counts code points, not UTF-16 units', () => {
    expect(value('len("😀")')).toBe(1);
    expect(value('len("😀abc")')).toBe(4);
    expect(fieldsOf('EVAL-n = len(_raw)\n', '', 'a😀b')['n']).toBe('3');
  });

  it.each([
    ['substr("😀abc", 2)', 'abc'],
    ['substr("😀abc", 1, 1)', '😀'],
    ['substr("ab😀", -1)', '😀'],
    ['substr("😀a", -2)', '😀a'],
    ['substr("a😀b😀c", 2, 3)', '😀b😀'],
  ])('substr() counts code points: %s = %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

  it('substr() reaching back past the first code point is NULL', () => {
    // Two code points, though three UTF-16 units.
    expect(value('substr("😀a", -3)')).toBeNull();
  });

  it('the trim family never splits a character outside the BMP', () => {
    // 😀 and 😁 share their leading surrogate, but 😁 is not in the set.
    expect(value('trim("😁x😁", "😀")')).toBe('😁x😁');
    expect(value('ltrim("😁x", "😀")')).toBe('😁x');
    expect(value('rtrim("x😁", "😀")')).toBe('x😁');
    expect(value('trim("😀x😀", "😀")')).toBe('x');
    expect(value('upper("😀a")')).toBe('😀A');
    expect(value('lower("😀A")')).toBe('😀a');
  });

  it.each([
    ['split("😀ab", "")', ['\uFFFD', '\uFFFD', '\uFFFD', '\uFFFD', 'a', 'b']],
    ['split("aé", "")', ['a', '\uFFFD', '\uFFFD']],
    ['split("€", "")', ['\uFFFD', '\uFFFD', '\uFFFD']],
    ['split("abc", "")', ['a', 'b', 'c']],
    ['split("a\u007fb", "")', ['a', '\u007f', 'b']],
  ])('split() on "" gives one value per UTF-8 byte: %s', (expr, out) => {
    expect(value(expr)).toEqual(out);
  });
});
