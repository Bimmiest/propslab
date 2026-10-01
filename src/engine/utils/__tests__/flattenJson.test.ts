import { describe, it, expect } from 'vitest';
import { createJsonParser, flattenArray, flattenJson, parseJson, type JsonParse } from '../flattenJson';

type Fields = Record<string, string | string[]>;

/** The fields flattening `value` produces, as the extractors call it. */
function flatten(value: unknown): Fields {
  const fields: Fields = {};
  if (Array.isArray(value)) flattenArray(value, fields, [], '');
  else flattenJson(value as Record<string, unknown>, fields, []);
  return fields;
}

// Every number shape whose JS rendering differs from its text, and two that
// do not (a string that looks like a number, and a plain integer).
const NUMBERS =
  '{"big":9007199254740993,"dec":10.50,"exp":1e3,"expu":1E+3,"huge":123456789012345678901234567890,' +
  '"negz":-0.0,"small":1E-7,"str":"10.50","int":42}';

// Splunk keeps a JSON number as the event wrote it (#448), where JSON.parse
// would round it through a double.
describe('parseJson — a number keeps the text it was written as (#448)', () => {
  it('extracts each number exactly as written', () => {
    expect(flatten(parseJson(NUMBERS))).toEqual({
      big: '9007199254740993',
      dec: '10.50',
      exp: '1e3',
      expu: '1E+3',
      huge: '123456789012345678901234567890',
      negz: '-0.0',
      small: '1E-7',
      str: '10.50',
      int: '42',
    });
  });

  it('reports no depth limit for an object of leaves', () => {
    expect(flattenJson(parseJson(NUMBERS) as Record<string, unknown>, {}, [])).toBe(false);
    expect(flattenJson(parseJson('{"n":null}') as Record<string, unknown>, {}, [])).toBe(false);
  });

  it('keeps numbers as written in arrays, nested objects and arrays of objects', () => {
    const fields = flatten(parseJson('{"vals":[1.50,2e2,"x"],"o":{"n":0.10},"items":[{"id":1.0},{"id":2E0}]}'));
    expect(fields['vals{}']).toEqual(['1.50', '2e2', 'x']);
    expect(fields['o.n']).toBe('0.10');
    expect(fields['items{}.id']).toEqual(['1.0', '2E0']);
  });

  it('keeps numbers as written in a top-level array', () => {
    expect(flatten(parseJson('[1.50,{"a":1e1}]'))).toEqual({ '{}': '1.50', '{}.a': '1e1' });
  });

  it('writes numbers as written when it stringifies an array of arrays', () => {
    const fields = flatten(parseJson('{"m":[[1.50,"a\\"b",true,null],[{"k":1e3,"s":"t"}],[[2E0],[]]]}'));
    expect(fields['m{}']).toEqual(['[1.50,"a\\"b",true,null]', '[{"k":1e3,"s":"t"}]', '[[2E0],[]]']);
  });

  it('still renders booleans as words and null as an empty value', () => {
    expect(flatten(parseJson('{"t":true,"f":false,"n":null,"arr":[false,null,0.0]}'))).toEqual({
      t: 'true',
      f: 'false',
      n: '',
      'arr{}': ['false', '0.0'],
    });
  });

  it('extracts nothing from a value JSON cannot hold', () => {
    const fields: Fields = {};
    const added: string[] = [];
    expect(flattenJson({ f: () => 0, s: Symbol('s') }, fields, added)).toBe(false);
    expect(fields).toEqual({});
    expect(added).toEqual([]);
  });

  it('does not take an object with a `source` key for a number', () => {
    expect(flatten(parseJson('{"o":{"source":"s"}}'))).toEqual({ 'o.source': 's' });
  });

  it('keeps a __proto__ key as an ordinary field', () => {
    const fields = flatten(parseJson('{"__proto__":1.0,"keep":"ok"}'));
    expect(Object.hasOwn(fields, '__proto__')).toBe(true);
    expect(fields['__proto__']).toBe('1.0');
    expect(fields['keep']).toBe('ok');
  });

  it('returns a bare number as a number, which is no container to extract from', () => {
    expect(parseJson('1.50')).toBe(1.5);
    expect(parseJson('"1.50"')).toBe('1.50');
  });

  it('rejects malformed JSON as JSON.parse does', () => {
    expect(() => parseJson('{"a":1,}')).toThrow(SyntaxError);
  });
});

// A runtime without JSON.parse source text access gives a reviver no third
// argument. The parser then falls back to JS numbers, rendered as JS renders them.
describe('createJsonParser — without source text access (#448)', () => {
  const noContext: JsonParse = (text, reviver) =>
    JSON.parse(text, reviver && ((key: string, value: unknown) => reviver(key, value)));
  const ignoresReviver: JsonParse = (text) => JSON.parse(text);

  it.each([
    ['passes the reviver no context', noContext],
    ['never calls the reviver', ignoresReviver],
  ])('renders numbers as JS does when the parser %s', (_label, parse) => {
    expect(flatten(createJsonParser(parse)(NUMBERS))).toEqual({
      big: '9007199254740992',
      dec: '10.5',
      exp: '1000',
      expu: '1000',
      huge: '1.2345678901234568e+29',
      negz: '0',
      small: '1e-7',
      str: '10.50',
      int: '42',
    });
  });

  it('renders numbers in an array of arrays as JS does', () => {
    expect(flatten(createJsonParser(noContext)('{"m":[[1.50,1e3]]}'))['m{}']).toBe('[1.5,1000]');
  });

  /** A parser that records the reviver each call was given. */
  function recording(parse: JsonParse): { parse: JsonParse; revivers: unknown[] } {
    const revivers: unknown[] = [];
    return {
      revivers,
      parse: (text, reviver) => {
        revivers.push(reviver);
        return parse(text, reviver);
      },
    };
  }

  it('checks for source text once, when the parser is created', () => {
    const r = recording((text, reviver) => JSON.parse(text, reviver));
    const parse = createJsonParser(r.parse);
    expect(r.revivers).toHaveLength(1);
    parse('{"a":1}');
    parse('{"b":2}');
    expect(r.revivers).toHaveLength(3);
  });

  it('passes a reviver only to a parser that gives it source text', () => {
    const withText = recording((text, reviver) => JSON.parse(text, reviver));
    createJsonParser(withText.parse)('{"a":1}');
    expect(withText.revivers.at(-1)).toBeTypeOf('function');

    const withoutText = recording(noContext);
    createJsonParser(withoutText.parse)('{"a":1}');
    expect(withoutText.revivers.at(-1)).toBeUndefined();
  });
});
