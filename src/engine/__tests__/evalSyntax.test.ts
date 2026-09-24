// ---------------------------------------------------------------------------
// evalSyntax.test.ts
// The eval lexer dropped characters it did not recognise, so `.5 * 2` lost its
// point and evaluated to 10; an unterminated `"abc` was accepted; the LIKE and
// XOR operators did not parse at all; and `NOT NOT x` threw (#312).
//
// Doc-derived: the SPL eval operator table (`.` concatenation; comparison
// operators including LIKE with SQL wildcards `%` and `_`; boolean operators
// AND, OR, NOT, XOR, with XOR at OR's precedence). No fidelity fixture covers
// eval, so the assertions are narrow.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
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

const evalDir = (className: string, value: string): ConfDirective =>
  ({ key: `EVAL-${className}`, value, line: 1, directiveType: 'EVAL', className });

function run(expr: string, fields: Record<string, string> = {}) {
  const diagnostics: ValidationDiagnostic[] = [];
  const out = applyEvalExpressions([event(fields)], [evalDir('out', expr)], diagnostics)[0]!;
  return { value: out.fields['out'], diagnostics };
}

/** The expression must be refused with an EVAL error diagnostic, not a crash. */
function expectSyntaxError(expr: string, message: RegExp) {
  const { value, diagnostics } = run(expr);
  expect(value).toBeUndefined();
  const errors = diagnostics.filter((d) => d.level === 'error');
  expect(errors).toHaveLength(1);
  expect(errors[0]!.message).toMatch(/^EVAL-out: /);
  expect(errors[0]!.message).toMatch(message);
}

describe('eval numbers with a leading decimal point (#312)', () => {
  it('reads .5 as a number', () => {
    expect(run('.5 * 2').value).toBe('1');
  });

  it('reads .5 after an operator, a comma or an opening paren', () => {
    expect(run('1 + .5').value).toBe('1.5');
    expect(run('round(.25, 1)').value).toBe('0.3');
    expect(run('(.5)').value).toBe('0.5');
  });

  it('still treats . after a value as concatenation', () => {
    expect(run('a.5', { a: 'x' }).value).toBe('x5');
    expect(run('"x".5').value).toBe('x5');
    expect(run('"x".y', { y: 'z' }).value).toBe('xz');
    expect(run('a . b', { a: 'p', b: 'q' }).value).toBe('pq');
  });

  it('still rejects a number with two decimal points', () => {
    expectSyntaxError('1.2.3', /Malformed number: 1\.2\.3/);
    expectSyntaxError('.5.3', /Malformed number/);
  });
});

describe('eval lexer errors (#312)', () => {
  it('reports an unexpected character instead of skipping it', () => {
    expectSyntaxError('1 # 2', /Unexpected character: #/);
  });

  it('reports an unterminated string literal', () => {
    expectSyntaxError('"abc', /Unterminated string literal/);
  });

  it('still accepts an escaped quote inside a terminated literal', () => {
    expect(run('"a\\"b"').value).toBe('a"b');
  });

  it('reports an unterminated quoted field name', () => {
    expectSyntaxError("'abc", /Unterminated quoted field name/);
  });
});

describe('eval LIKE operator (#312)', () => {
  it('matches with % and _ wildcards', () => {
    expect(run('if(a LIKE "f%", 1, 0)', { a: 'foo' }).value).toBe('1');
    expect(run('if(a LIKE "f%", 1, 0)', { a: 'bar' }).value).toBe('0');
    expect(run('if(a LIKE "f_o", 1, 0)', { a: 'foo' }).value).toBe('1');
    expect(run('if(a LIKE "f_o", 1, 0)', { a: 'fooo' }).value).toBe('0');
  });

  it('is case-insensitive as a keyword and case-sensitive as a match', () => {
    expect(run('if(a like "F%", 1, 0)', { a: 'Foo' }).value).toBe('1');
    expect(run('if(a Like "F%", 1, 0)', { a: 'foo' }).value).toBe('0');
  });

  it('shares like()\'s handling of a run of %', () => {
    // like() collapses `%%` so the ReDoS guard accepts it (#303); the operator
    // must not reintroduce that bug.
    expect(run('if(a LIKE "a%%b", 1, 0)', { a: 'axxb' }).value).toBe('1');
  });

  it('binds tighter than AND / OR and looser than concatenation', () => {
    expect(run('if(a LIKE "f%" AND b LIKE "%r", 1, 0)', { a: 'foo', b: 'bar' }).value).toBe('1');
    expect(run('if(a LIKE "f" . "%", 1, 0)', { a: 'foo' }).value).toBe('1');
  });

  it('negates under NOT', () => {
    expect(run('if(NOT a LIKE "f%", 1, 0)', { a: 'foo' }).value).toBe('0');
  });

  it('leaves the like() function working', () => {
    expect(run('if(like(a, "f%"), 1, 0)', { a: 'foo' }).value).toBe('1');
    expect(run('if(LIKE(a, "f%"), 1, 0)', { a: 'foo' }).value).toBe('1');
  });
});

describe('eval XOR operator (#312)', () => {
  it('is true when exactly one side is true', () => {
    expect(run('if(1==1 XOR 1==2, 1, 0)').value).toBe('1');
    expect(run('if(1==2 XOR 1==1, 1, 0)').value).toBe('1');
    expect(run('if(1==1 XOR 1==1, 1, 0)').value).toBe('0');
    expect(run('if(1==2 xor 1==2, 1, 0)').value).toBe('0');
  });

  it('binds looser than AND', () => {
    // true XOR (true AND false) = true; (true XOR true) AND false would be false.
    expect(run('if(1==1 XOR 1==1 AND 1==2, 1, 0)').value).toBe('1');
  });

  it('shares OR\'s precedence level, left to right', () => {
    // (true OR false) XOR true = false; true OR (false XOR true) would be true.
    expect(run('if(1==1 OR 1==2 XOR 1==1, 1, 0)').value).toBe('0');
  });
});

describe('eval NOT NOT (#312)', () => {
  it('parses and cancels out', () => {
    expect(run('if(NOT NOT 1==1, 1, 0)').value).toBe('1');
    expect(run('if(NOT NOT NOT 1==1, 1, 0)').value).toBe('0');
    expect(run('if(!!(1==2), 1, 0)').value).toBe('0');
  });
});
