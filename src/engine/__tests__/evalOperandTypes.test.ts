// How `+` and the comparison operators read their operands (#522, #446).
//
// Splunk types an operand statically where it can: a string literal, a `.`
// concatenation and a function that always produces text are text; a number
// literal, arithmetic and a numeric function are a number. A field is typed at
// run time: a value that looks numeric is a number, anything else text. A
// function that passes an operand through (if, coalesce, mvindex, ...) keeps
// that operand's nature. Text against a number is a type error in Splunk,
// which the simulator answers with NULL.
import { describe, it, expect } from 'vitest';
import { evaluateExpression } from '../processors/eval/evaluator';
import { runPipeline } from '../pipeline';
import { makeEvent } from '../../test/makeEvent';
import { FIXED_NOW } from './runCtx';

/** Extracted fields, as the comparisons below name them. */
const FIELDS = { a: '10', b: '9', c: 'abc', e: '1e3', s: 'xyz', five: '5', one: '1', inf: 'inf' };

const value = (expr: string) => evaluateExpression(expr, makeEvent('raw', { fields: FIELDS }), undefined, 0);

const cases = (rows: readonly (readonly [string, unknown])[]) =>
  it.each(rows)('%s is %j', (expr, out) => {
    expect(value(expr)).toBe(out);
  });

describe('typeof() of a field follows its value; of anything else, its static type', () => {
  cases([
    ['typeof(a)', 'Number'],
    ['typeof(e)', 'Number'],
    ['typeof(c)', 'String'],
    ['typeof(10)', 'Number'],
    ['typeof("10")', 'String'],
    ['typeof(tostring(10))', 'String'],
    ['typeof(a . "")', 'String'],
    ['typeof(if(true(), a, 0))', 'Number'],
    ['typeof(coalesce(missing, e))', 'Number'],
    ['typeof(coalesce(missing, c))', 'String'],
  ]);
});

describe('a field against a static number is read as a number', () => {
  cases([
    ['a > 9', true],
    ['a == 10.0', true],
    ['e == 1000', true],
    ['9 < a', true],
    ['a > abs(-9)', true],
    ['a == round(10.2)', true],
    ['a IN (10)', true],
    // Not numeric: NULL for every operator.
    ['5 < c', null],
    ['c == 5', null],
    ['c != 5', null],
    ['s > len("ab")', null],
    ['c IN (5)', false],
  ]);
});

describe('a field against static text is compared as its text', () => {
  cases([
    ['"9" < a', false],
    ['a > tostring(9)', false],
    ['a == "10.0"', false],
    ['a == "10"', true],
    ['e == "1000"', false],
    ['a > "abc"', false],
    ['c > "abb"', true],
    ['a == upper("10")', true],
    ['a == a . ""', true],
    ['a IN ("10.0")', false],
    ['a IN ("10")', true],
  ]);
});

describe('two fields compare as numbers when both look numeric, as text otherwise', () => {
  cases([
    ['b < a', true],
    ['a > b', true],
    ['b < e', true],
    ['a > c', false],
    ['c == a', false],
    ['if(true(), a, 0) > b', true],
    ['coalesce(missing, a) > b', true],
  ]);

  it('so a threshold held in a field works in a props.conf EVAL', () => {
    const props =
      '[st]\nSHOULD_LINEMERGE = false\n' +
      'EXTRACT-kv = bytes=(?<bytes>\\d+) threshold=(?<threshold>\\d+)\n' +
      'EVAL-size = if(bytes > threshold, "big", "small")\n';
    const { result } = runPipeline(
      'bytes=10 threshold=9\nbytes=8 threshold=9',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      props,
      '',
      { perEventPipeline: false, captureOffsets: false, now: FIXED_NOW },
    );
    expect(result.events.map((e) => e.fields['size'])).toEqual(['big', 'small']);
  });
});

describe('literals compare by their own types', () => {
  cases([
    ['"10" > "9"', false],
    ['10 > 9', true],
    // Text against a number is a type error in Splunk: NULL here.
    ['"10" > 9', null],
    ['"abc" == 5', null],
    ['(a . "") > 9', null],
    ['tostring(9) == 9', null],
    ['len("ab") == "2"', null],
  ]);
});

describe('an expression has the static type of what it computes', () => {
  cases([
    // Negation and arithmetic other than + are numbers, so a field against
    // them is read as a number.
    ['a > -(-9)', true],
    ['c == -(-9)', null],
    ['c == b * 1', null],
    ['c == a * b', null],
    // + of two strings is text, of anything with a number a number, and of
    // two fields neither until they are added.
    ['("1" + "0") == 10', null],
    ['c == b + 1', null],
    ['c == a + b', false],
    ['a + b > b', true],
  ]);
});

describe('+ follows the same typing', () => {
  cases([
    // Beside static text: concatenation of the text.
    ['a + "x"', '10x'],
    ['"x" + c', 'xabc'],
    ['"5" + "1"', '51'],
    ['a + tostring(1)', '101'],
    // Beside a static number: addition, NULL for a field that is not numeric.
    ['a + 1', 11],
    ['e + 0', 1000],
    ['c + 1', null],
    ['1 + c', null],
    ['inf + 1', null],
    ['s + len("ab")', null],
    // Two fields: addition when both look numeric, concatenation otherwise.
    ['a + b', 19],
    ['five + one', 6],
    ['five + c', '5abc'],
    // Text beside a number is a type error in Splunk: NULL here.
    ['"5" + 1', null],
    ['"abc" + 1', null],
  ]);
});

describe('assignment keeps a field as its text', () => {
  it('writes e as "1e3", while e + 0 is 1000 and e . "" is the text', () => {
    const props =
      '[st]\nSHOULD_LINEMERGE = false\nEXTRACT-e = e=(?<e>\\S+)\n' +
      'EVAL-x = e\nEVAL-t = typeof(e)\nEVAL-sum = e + 0\nEVAL-text = e . ""\nEVAL-tt = typeof(e . "")\n';
    const { result } = runPipeline('e=1e3', { index: 'main', host: 'h', source: 's', sourcetype: 'st' }, props, '', {
      perEventPipeline: false,
      captureOffsets: false,
      now: FIXED_NOW,
    });
    expect(result.events[0]!.fields).toMatchObject({ x: '1e3', t: 'Number', sum: '1000', text: '1e3', tt: 'String' });
  });
});
