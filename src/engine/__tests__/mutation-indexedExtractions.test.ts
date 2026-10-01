// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins an INDEXED_EXTRACTIONS behaviour the suite executed without asserting.
import { describe, it, expect } from 'vitest';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { validateRegex } from '../../utils/splunkRegex';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

const directive = (key: string, value: string): ConfDirective => ({ key, value, line: 1, directiveType: key });

/** Run INDEXED_EXTRACTIONS = `mode` over one event per line, with `conf` as further directives. */
function extract(
  mode: string,
  lines: (string | SplunkEvent)[],
  conf: Record<string, string> = {},
  diagnostics?: ValidationDiagnostic[],
): SplunkEvent[] {
  return applyIndexedExtractions(
    lines.map((l) => (typeof l === 'string' ? makeEvent(l) : l)),
    [directive('INDEXED_EXTRACTIONS', mode), ...Object.entries(conf).map(([k, v]) => directive(k, v))],
    runCtx(FIXED_NOW, diagnostics),
  );
}

const fieldsOf = (events: SplunkEvent[]) => events.map((e) => e.fields);

describe('INDEXED_EXTRACTIONS — the mode', () => {
  it.each([
    ['csv', ','],
    ['tsv', '\t'],
    ['psv', '|'],
  ])('reads %s, and names the format on its trace step', (mode, sep) => {
    const [e, ...rest] = extract(mode, [`a${sep}b`, `1${sep}2`]);
    expect(rest).toEqual([]);
    expect(e?.fields).toEqual({ a: '1', b: '2' });
    expect(e?.processingTrace.at(-1)).toEqual({
      processor: `INDEXED_EXTRACTIONS(${mode})`,
      phase: 'index-time',
      description: `Extracted 2 fields from ${mode.toUpperCase()}`,
      fieldsAdded: ['a', 'b'],
    });
  });

  it('leaves the events alone for a format it does not know', () => {
    const input = [makeEvent('a,b'), makeEvent('1,2')];
    expect(applyIndexedExtractions(input, [directive('INDEXED_EXTRACTIONS', 'yaml')], runCtx(FIXED_NOW))).toBe(input);
  });
});

describe('INDEXED_EXTRACTIONS = json', () => {
  it.each(['42', '"text"', 'null', 'true'])('returns the event %s, a JSON scalar, unchanged', (raw) => {
    const input = makeEvent(raw);
    expect(extract('json', [input])[0]).toBe(input);
  });

  it('keeps the fields the event already had and describes its step', () => {
    const [e] = extract('json', [makeEvent('{"a":1,"b":"x"}', { fields: { pre: 'kept' } })]);
    expect(e?.fields).toEqual({ pre: 'kept', a: '1', b: 'x' });
    expect(e?.processingTrace.at(-1)).toEqual({
      processor: 'INDEXED_EXTRACTIONS(json)',
      phase: 'index-time',
      description: 'Extracted 2 JSON fields',
      fieldsAdded: ['a', 'b'],
    });
  });

  it('reports one invalid event in the singular', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extract('json', ['{"a":'], {}, diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.message).toMatch(
      /^INDEXED_EXTRACTIONS = json: 1 event not valid JSON — JSON fields skipped \(/,
    );
    expect(diagnostics[0]?.suggestion).toBe('Check for unquoted values, trailing commas, or placeholders like <ID>.');
  });
});

describe('FIELD_DELIMITER and FIELD_QUOTE — the tokens they accept', () => {
  it.each([
    ['fs', '\x1c'],
    ['gs', '\x1d'],
    ['rs', '\x1e'],
    ['us', '\x1f'],
    ['\\t', '\t'],
    ['\\x3b', ';'],
    ['"|"', '|'],
  ])('reads FIELD_DELIMITER = %s', (value, sep) => {
    expect(fieldsOf(extract('csv', [`a${sep}b`, `1${sep}2`], { FIELD_DELIMITER: value }))).toEqual([
      { a: '1', b: '2' },
    ]);
  });

  it('reads FIELD_DELIMITER = ws as a run of whitespace', () => {
    expect(fieldsOf(extract('csv', ['a  b', '1 \t 2'], { FIELD_DELIMITER: 'ws' }))).toEqual([{ a: '1', b: '2' }]);
  });

  it('keeps the default delimiter when the value names no character', () => {
    expect(fieldsOf(extract('csv', ['a,b', '1,2'], { FIELD_DELIMITER: '""' }))).toEqual([{ a: '1', b: '2' }]);
  });

  it('reads FIELD_QUOTE = none as no quote character, not the letter n', () => {
    expect(fieldsOf(extract('csv', ['name,b', '"x,y'], { FIELD_QUOTE: 'none' }))).toEqual([{ name: '"x', b: 'y' }]);
  });
});

describe('FIELD_NAMES — the list', () => {
  it('trims the inside of a quoted name', () => {
    expect(fieldsOf(extract('csv', ['1,2'], { FIELD_NAMES: '" a ", b' }))).toEqual([{ a: '1', b: '2' }]);
  });

  // #449 corrected this: an empty entry was skipped, shifting `b` onto the
  // second column. Each entry names its own column, so the empty one leaves
  // the second column unnamed and `b` names the third.
  it('leaves the column of an empty entry unnamed', () => {
    expect(fieldsOf(extract('csv', ['1,2,3'], { FIELD_NAMES: 'a,,b' }))).toEqual([{ a: '1', b: '3' }]);
  });

  it('names a value past the end of the list by its column', () => {
    expect(fieldsOf(extract('csv', ['1,2,3'], { FIELD_NAMES: 'a,b' }))).toEqual([
      { a: '1', b: '2', EXTRA_FIELD_3: '3' },
    ]);
  });

  it('is ignored when it names nothing, so the header line still names the fields', () => {
    expect(fieldsOf(extract('csv', ['a,b', '1,2'], { FIELD_NAMES: ' , ' }))).toEqual([{ a: '1', b: '2' }]);
  });
});

describe('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS — the characters it keeps', () => {
  it('keeps each character it names and no other', () => {
    const [f] = fieldsOf(extract('csv', ['a.b c-d', 'v'], { HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: '.-' }));
    expect(f).toEqual({ 'a.b_c-d': 'v' });
  });

  it('stops at the end of ASCII', () => {
    const [f] = fieldsOf(extract('csv', ['a\u0080b', 'v'], { HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: '\u0080' }));
    expect(f).toEqual({ a_b: 'v' });
  });
});

describe('the regex-valued attributes', () => {
  it('treats an empty pattern as unset', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    expect(fieldsOf(extract('csv', ['a,b', '1,-'], { MISSING_VALUE_REGEX: '' }, diagnostics))).toEqual([
      { a: '1', b: '-' },
    ]);
    expect(diagnostics).toEqual([]);
  });

  it('says nothing about a pattern that compiles', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extract('csv', ['a,b', '1,-'], { MISSING_VALUE_REGEX: '^-$' }, diagnostics);
    expect(diagnostics).toEqual([]);
  });

  it.each([
    ['FIELD_HEADER_REGEX', 'The header was located as if it were unset.'],
    ['MISSING_VALUE_REGEX', 'No value was treated as missing.'],
    ['PREAMBLE_REGEX', 'No preamble lines were skipped.'],
  ])('warns that %s does not compile, and what happened instead', (key, consequence) => {
    const diagnostics: ValidationDiagnostic[] = [];
    extract('csv', ['a,b', '1,2'], { [key]: '(' }, diagnostics);
    expect(diagnostics).toEqual([
      {
        level: 'warning',
        message: `${key} (() does not compile (${validateRegex('(') ?? ''}). ${consequence}`,
        file: 'props.conf',
        line: 1,
        directiveKey: key,
      },
    ]);
  });
});

describe('locating the header and the data', () => {
  it('skips every leading preamble line, whatever follows', () => {
    const events = extract('csv', ['# one', '# two', 'a,b', '1,2', '3,4'], { PREAMBLE_REGEX: '^#' });
    expect(fieldsOf(events)).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  // #449 corrected this: the input came back unextracted. Every line falls
  // before a header past the end of the input, and none is indexed.
  it('indexes nothing when HEADER_FIELD_LINE_NUMBER is past the input', () => {
    const input = [makeEvent('a,b'), makeEvent('1,2')];
    const events = applyIndexedExtractions(
      input,
      [directive('INDEXED_EXTRACTIONS', 'csv'), directive('HEADER_FIELD_LINE_NUMBER', '5')],
      runCtx(FIXED_NOW),
    );
    expect(events).toEqual([]);
  });

  it('extracts no field for an unnamed column or an empty value', () => {
    const [e] = extract('csv', ['a,,c', '1,2,']);
    expect(e?.fields).toEqual({ a: '1' });
    expect(e?.processingTrace.at(-1)?.fieldsAdded).toEqual(['a']);
  });

  it('strips every leading underscore from a header name', () => {
    expect(fieldsOf(extract('csv', ['__id,b', '1,2']))).toEqual([{ id: '1', b: '2' }]);
  });
});

// #444 corrected two of these. They read that a w3c row carries only its
// columns; without TIMESTAMP_FIELDS, w3c reads its timestamp from the date and
// time columns, so a row with neither has `timestamp=none` and a trace step
// after the extraction's.
describe('INDEXED_EXTRACTIONS = w3c', () => {
  it('reads #Fields names separated by any run of spaces', () => {
    expect(fieldsOf(extract('w3c', ['#Fields: a  b', '1 2']))).toEqual([{ a: '1', b: '2', timestamp: 'none' }]);
  });

  it('leaves the events alone when there is no #Fields line', () => {
    const input = [makeEvent('#Version: 1.0'), makeEvent('1 2')];
    expect(applyIndexedExtractions(input, [directive('INDEXED_EXTRACTIONS', 'w3c')], runCtx(FIXED_NOW))).toBe(input);
  });

  it('skips "-" and empty values, and describes its step', () => {
    const [e, ...rest] = extract('w3c', ['#Fields: a b c d', '1 "" - 4']);
    expect(rest).toEqual([]);
    expect(e?.fields).toEqual({ a: '1', d: '4', timestamp: 'none' });
    expect(e?.processingTrace.at(-2)).toEqual({
      processor: 'INDEXED_EXTRACTIONS(w3c)',
      phase: 'index-time',
      description: 'Extracted 2 W3C fields',
      fieldsAdded: ['a', 'd'],
    });
  });

  it('keeps an event with data below a directive line', () => {
    const events = extract('w3c', ['#Fields: a b', '#Remark: merged\n1 2']);
    expect(events.map((e) => e._raw)).toEqual(['#Remark: merged\n1 2']);
  });
});
