// ---------------------------------------------------------------------------
// evalCoercion.test.ts
// One string → number reading for eval, and the boolean-assignment error.
//
// Doc-derived, not captured: Splunk's eval reads numbers in decimal (tonumber()
// takes an explicit base for anything else), substr() takes a start and a
// length, and assigning a comparison to a field is the documented error
// "Fields cannot be assigned a boolean result". No fidelity fixture covers
// eval, so the assertions are narrow.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { evaluateExpression } from '../processors/eval/evaluator';
import { applyIngestEval } from '../transforms/ingestEval';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(fields: Record<string, string> = {}): SplunkEvent {
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

const value = (expr: string, fields: Record<string, string> = {}) => evaluateExpression(expr, event(fields), undefined, 0);

describe('eval reads strings as decimal numbers only (#358)', () => {
  it('agrees between + and * on a hex-looking string: neither is a number', () => {
    expect(value('"0x10" + 1')).toBe('0x101'); // concatenation, as for any non-number
    expect(value('"0x10" * 1')).toBeNull();
  });

  it('does not read a blank string as 0', () => {
    expect(value('isnum(" ")')).toBe(false);
    expect(value('" " == 0')).toBe(false);
    expect(value('" " * 2')).toBeNull();
  });

  it('does not read binary, octal-prefixed or Infinity spellings', () => {
    for (const s of ['0b11', '0o7', 'Infinity', '1_000']) {
      expect(value(`isnum("${s}")`), s).toBe(false);
      expect(value(`tonumber("${s}")`), s).toBeNull();
    }
  });

  it('makes isnum() and tonumber() agree on decimal forms', () => {
    for (const [s, n] of [['.5', 0.5], ['+5', 5], ['1e3', 1000], ['-2.5E-1', -0.25], ['5.', 5], [' 7 ', 7]] as const) {
      expect(value(`isnum("${s}")`), s).toBe(true);
      expect(value(`tonumber("${s}")`), s).toBe(n);
      expect(value(`"${s}" * 1`), s).toBe(n);
    }
  });

  it('compares numeric strings numerically', () => {
    expect(value('"1e3" == 1000')).toBe(true);
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

describe('assigning a boolean result (#358)', () => {
  const evalDir = (className: string, expr: string): ConfDirective =>
    ({ key: `EVAL-${className}`, value: expr, line: 2, directiveType: 'EVAL', className });

  it('EVAL- writes no field and reports the error', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = applyEvalExpressions([event({ a: '1', b: '1' })], [evalDir('x', 'a==b')], diagnostics)[0]!;
    expect(out.fields['x']).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'error', directiveKey: 'EVAL-x' });
    expect(diagnostics[0]!.message).toMatch(/Fields cannot be assigned a boolean result/);
  });

  it('leaves an if() over the same test working', () => {
    const out = applyEvalExpressions([event({ a: '1', b: '1' })], [evalDir('x', 'if(a==b, "same", "diff")')])[0]!;
    expect(out.fields['x']).toBe('same');
  });

  it('INGEST_EVAL writes no field and reports the error', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const dirs: ConfDirective[] = [
      { key: 'INGEST_EVAL', value: 'x=a==b, y="kept"', line: 1, directiveType: 'INGEST_EVAL' },
    ];
    const out = applyIngestEval([event({ a: '1', b: '2' })], dirs, diagnostics)[0]!;
    expect(out.fields['x']).toBeUndefined();
    expect(out.fields['y']).toBe('kept');
    expect(diagnostics.filter((d) => d.level === 'error')).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/^INGEST_EVAL x: Fields cannot be assigned a boolean result/);
  });
});
