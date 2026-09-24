// ---------------------------------------------------------------------------
// evalNullComparison.test.ts
// Comparisons against NULL (#343).
//
// compare() coerced an absent field to "" before comparing, so
// `if(missing=="","y","n")` was "y", `missing!="a"` was true and
// `missing IN ("")` was true: a guard written about a field's value fired on
// every event that did not have the field.
//
// Doc-derived, not captured — no fidelity fixture covers eval. The SPL Search
// Reference treats NULL as unknown: a comparison with a NULL operand is NULL,
// NULL is not true wherever a condition is read (if(), case(), where), and
// isnull()/isnotnull()/coalesce() are how an expression asks about absence.
// Boolean operators follow three-valued logic: NOT NULL is NULL, NULL AND false
// is false, NULL AND true is NULL, NULL OR true is true, NULL OR false is NULL.
// Assertions stay narrow: they pin which branch is taken and whether a field is
// written, not how a NULL renders.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import { evaluateExpression } from '../processors/eval/evaluator';
import { applyIngestEval } from '../transforms/ingestEval';
import { evaluateStopCondition } from '../transforms/stopProcessing';
import type { SplunkEvent, ConfDirective } from '../types';

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

const evalDir = (value: string): ConfDirective =>
  ({ key: 'EVAL-out', value, line: 1, directiveType: 'EVAL', className: 'out' });

/** What `EVAL-out = expr` writes, or undefined when it writes nothing. */
function evalWith(expr: string, fields: Record<string, string> = {}) {
  return applyEvalExpressions([event(fields)], [evalDir(expr)])[0]!.fields['out'];
}

/** The raw eval value, for asserting NULL itself rather than its effect. */
const value = (expr: string, fields: Record<string, string> = {}) => evaluateExpression(expr, event(fields));

describe('comparison operators with a NULL operand (#343)', () => {
  it.each(['=', '==', '!=', '<', '>', '<=', '>='])('missing %s "" is NULL', (op) => {
    expect(value(`missing ${op} ""`)).toBeNull();
    expect(value(`"" ${op} missing`)).toBeNull();
    expect(value(`missing ${op} 0`)).toBeNull();
  });

  it('takes the else branch of if() for the cases in the issue', () => {
    expect(evalWith('if(missing=="","y","n")')).toBe('n');
    expect(evalWith('if(missing!="a","y","n")')).toBe('n');
    expect(evalWith('if(missing IN (""),"y","n")')).toBe('n');
  });

  it('writes no field for a bare comparison against a missing field', () => {
    expect(evalWith('missing != "a"')).toBeUndefined();
    expect(evalWith('missing == missing')).toBeUndefined();
  });

  it('still compares an empty-but-present field as ""', () => {
    // A present field that is empty is not NULL.
    expect(evalWith('if(e=="","y","n")', { e: '' })).toBe('y');
    expect(evalWith('if(e!="a","y","n")', { e: '' })).toBe('y');
  });

  it('skips a NULL test in case() and falls through to the next', () => {
    expect(evalWith('case(missing=="", "empty", true(), "other")')).toBe('other');
  });

  it('leaves isnull()/isnotnull()/coalesce() as the way to test for absence', () => {
    expect(evalWith('if(isnull(missing),"y","n")')).toBe('y');
    expect(evalWith('if(isnotnull(missing),"y","n")')).toBe('n');
    expect(evalWith('if(coalesce(missing,"")=="","y","n")')).toBe('y');
  });
});

describe('LIKE, like() and match() with a NULL argument (#343)', () => {
  it('yields NULL, like the comparison operators', () => {
    expect(value('missing LIKE "%"')).toBeNull();
    expect(value('like(missing, "%")')).toBeNull();
    expect(value('like("a", missing)')).toBeNull();
    expect(value('match(missing, ".*")')).toBeNull();
    expect(value('match("a", missing)')).toBeNull();
  });

  it('is falsy in if(), including under NOT', () => {
    expect(evalWith('if(missing LIKE "%","y","n")')).toBe('n');
    expect(evalWith('if(match(missing, "^$"),"y","n")')).toBe('n');
    expect(evalWith('if(NOT match(missing, "x"),"y","n")')).toBe('n');
  });

  it('still matches an empty-but-present field', () => {
    expect(evalWith('if(e LIKE "%","y","n")', { e: '' })).toBe('y');
    expect(evalWith('if(match(e, "^$"),"y","n")', { e: '' })).toBe('y');
  });
});

describe('IN and in() with a NULL value (#343)', () => {
  it('is NULL for IN, NOT IN and in()', () => {
    expect(value('missing IN ("", "a")')).toBeNull();
    expect(value('missing NOT IN ("a")')).toBeNull();
    expect(value('in(missing, "")')).toBeNull();
  });

  it('treats a NULL list item as simply not matching', () => {
    // Kept narrow: a NULL item does not make the whole answer NULL here.
    expect(value('"a" IN (missing, "a")')).toBe(true);
    expect(value('"a" IN (missing, "b")')).toBe(false);
  });
});

describe('boolean operators under three-valued logic (#343)', () => {
  it.each([
    ['NOT (missing == "a")', null],
    ['(missing == "a") AND false', false],
    ['false AND (missing == "a")', false],
    ['(missing == "a") AND true', null],
    ['true AND (missing == "a")', null],
    ['(missing == "a") OR true', true],
    ['true OR (missing == "a")', true],
    ['(missing == "a") OR false', null],
    ['false OR (missing == "a")', null],
    ['(missing == "a") XOR true', null],
    ['(missing == "a") AND (missing == "b")', null],
  ])('%s is %s', (expr, expected) => {
    expect(value(expr)).toBe(expected);
  });

  it('makes NOT (x == "a") agree with x != "a" on a missing field', () => {
    expect(evalWith('if(NOT (missing == "a"),"y","n")')).toBe('n');
    expect(evalWith('if(missing != "a","y","n")')).toBe('n');
  });

  it('leaves booleans without NULL exactly as before', () => {
    expect(value('true AND false')).toBe(false);
    expect(value('false OR true')).toBe(true);
    expect(value('NOT false')).toBe(true);
    expect(value('true XOR true')).toBe(false);
  });
});

describe('consumers of a NULL condition (#343)', () => {
  it('INGEST_EVAL queue=if(...) takes the else branch on a missing field', () => {
    // Before #343, `level != "INFO"` was true for an event with no `level`,
    // routing it to nullQueue — the event was silently dropped.
    const dirs: ConfDirective[] = [
      { key: 'INGEST_EVAL', value: 'queue=if(level!="INFO","nullQueue","indexQueue")', line: 1, directiveType: 'INGEST_EVAL' },
    ];
    expect(applyIngestEval([event()], dirs)[0]!._meta._queue).toBe('indexQueue');
    expect(applyIngestEval([event({ level: 'DEBUG' })], dirs)[0]!._meta._queue).toBe('nullQueue');
  });

  it('STOP_PROCESSING_IF does not stop on a NULL condition', () => {
    // transforms.conf.spec: "numeric 0 and null are false".
    const dirs: ConfDirective[] = [
      { key: 'STOP_PROCESSING_IF', value: 'level != "INFO"', line: 1, directiveType: 'STOP_PROCESSING_IF' },
    ];
    expect(evaluateStopCondition(event(), dirs, [], 0)?.stop).toBe(false);
    expect(evaluateStopCondition(event({ level: 'DEBUG' }), dirs, [], 0)?.stop).toBe(true);
  });
});
