// ---------------------------------------------------------------------------
// evalCoercion.test.ts
// One string → number reading for eval, and the boolean-assignment error.
//
// Doc-derived: Splunk's eval reads numbers in decimal (tonumber()
// takes an explicit base for anything else), substr() takes a start and a
// length, and assigning a comparison to a field is the documented error
// "Fields cannot be assigned a boolean result". The assertions are narrow.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { evaluateExpression } from '../processors/eval/evaluator';
import { applyIngestEval } from '../transforms/ingestEval';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(fields: Record<string, string> = {}): SplunkEvent {
  return makeEvent('raw', { fields });
}

const value = (expr: string, fields: Record<string, string> = {}) =>
  evaluateExpression(expr, event(fields), undefined, 0);

describe('eval reads strings as decimal numbers only (#358)', () => {
  // A non-numeric string beside a number is NULL under + and every
  // comparison since #446, which corrected the old readings: `"0x10" + 1` was
  // the concatenation "0x101", and `" " == 0` was false.
  it('agrees between + and * on a hex-looking string: neither is a number', () => {
    expect(value('"0x10" + 1')).toBeNull();
    expect(value('"0x10" * 1')).toBeNull();
    expect(value('"0x10" + "1"')).toBe('0x101'); // two strings concatenate
  });

  it('does not read a blank string as 0', () => {
    expect(value('isnum(" ")')).toBe(false);
    expect(value('" " == 0')).toBeNull();
    expect(value('" " * 2')).toBeNull();
  });

  it('does not read binary, octal-prefixed or other infinity spellings', () => {
    for (const s of ['0b11', '0o7', '1_000', 'inf', 'nan', 'infinity', 'INFINITY', '+Infinity']) {
      expect(value(`isnum("${s}")`), s).toBe(false);
      expect(value(`tonumber("${s}")`), s).toBeNull();
    }
  });

  it('reads the text of a non-finite number as that number, except in tonumber() (#446)', () => {
    for (const s of ['Infinity', '-Infinity', 'NaN']) {
      expect(value(`isnum("${s}")`), s).toBe(true);
      expect(value(`tonumber("${s}")`), s).toBeNull();
    }
  });

  it('makes isnum() and tonumber() agree on decimal forms', () => {
    for (const [s, n] of [
      ['.5', 0.5],
      ['+5', 5],
      ['1e3', 1000],
      ['-2.5E-1', -0.25],
      ['5.', 5],
      [' 7 ', 7],
    ] as const) {
      expect(value(`isnum("${s}")`), s).toBe(true);
      expect(value(`tonumber("${s}")`), s).toBe(n);
      expect(value(`"${s}" * 1`), s).toBe(n);
    }
  });

  // A field holding numeric text is read as a number against one. A string
  // literal against a number is a type error, NULL here, since #522 and #446
  // corrected the old reading, under which `"1e3" == 1000` was true.
  it('compares a numeric field numerically', () => {
    expect(value('x == 1000', { x: '1e3' })).toBe(true);
    expect(value('"1e3" == 1000')).toBeNull();
    expect(value('".5" < "5"')).toBe(true);
  });

  it('keeps an explicit base for tonumber()', () => {
    expect(value('tonumber("ff", 16)')).toBe(255);
    expect(value('tonumber("0A4", 16)')).toBe(164);
    expect(value('tonumber("101", 2)')).toBe(5);
    expect(value('tonumber("12", 2)')).toBeNull();
  });
});

describe('substr() with a negative or zero length (#358)', () => {
  it('returns "" rather than reading backwards', () => {
    expect(value('substr("hello", 3, -1)')).toBe('');
    expect(value('substr("hello", 3, 0)')).toBe('');
  });

  it('still takes a length forward from the start', () => {
    expect(value('substr("hello", 2, 3)')).toBe('ell');
    expect(value('substr("hello", -3)')).toBe('llo');
    expect(value('substr("hello", -3, 2)')).toBe('ll');
  });
});

// Captured, not doc-derived: the reference leaves a start of 0, and a negative
// start past the beginning, undocumented. Run on a local Splunk, 2026-09-28:
//   | makeresults | eval s="hello"
//   | eval a=substr(s,0,3), b=substr(s,0,1), c=substr(s,0), d=substr(s,-10,3), e=substr(s,-5,2)
// gave a="hel", b="h", c="hello", d=NULL, e="he".
describe('substr() start boundaries, checked against Splunk (#397)', () => {
  it('reads a start of 0 as 1', () => {
    expect(value('substr("hello", 0, 3)')).toBe('hel');
    expect(value('substr("hello", 0, 1)')).toBe('h');
    expect(value('substr("hello", 0)')).toBe('hello');
  });

  it('is NULL for a negative start before the first character', () => {
    expect(value('substr("hello", -10, 3)')).toBeNull();
    expect(value('substr("hello", -6)')).toBeNull();
  });

  it('takes a negative start that lands on the first character', () => {
    expect(value('substr("hello", -5, 2)')).toBe('he');
  });
});

describe('assigning a boolean result (#358)', () => {
  const evalDir = (className: string, expr: string): ConfDirective => ({
    key: `EVAL-${className}`,
    value: expr,
    line: 2,
    directiveType: 'EVAL',
    className,
  });

  it('EVAL- writes no field and reports the error', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = applyEvalExpressions(
      [event({ a: '1', b: '1' })],
      [evalDir('x', 'a==b')],
      runCtx(FIXED_NOW, diagnostics),
    )[0]!;
    expect(out.fields['x']).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'error', directiveKey: 'EVAL-x' });
    expect(diagnostics[0]!.message).toMatch(/Fields cannot be assigned a boolean result/);
  });

  it('leaves an if() over the same test working', () => {
    const out = applyEvalExpressions(
      [event({ a: '1', b: '1' })],
      [evalDir('x', 'if(a==b, "same", "diff")')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(out.fields['x']).toBe('same');
  });

  it('INGEST_EVAL writes no field and reports the error', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const dirs: ConfDirective[] = [
      { key: 'INGEST_EVAL', value: 'x=a==b, y="kept"', line: 1, directiveType: 'INGEST_EVAL' },
    ];
    const out = applyIngestEval([event({ a: '1', b: '2' })], dirs, runCtx(FIXED_NOW, diagnostics))[0]!;
    expect(out.fields['x']).toBeUndefined();
    expect(out.fields['y']).toBe('kept');
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/^INGEST_EVAL x: Fields cannot be assigned a boolean result/);
  });
});
