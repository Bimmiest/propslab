import { describe, it, expect } from 'vitest';
import { applyEvalExpressions } from '../processors/evalProcessor';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(fields: Record<string, string> = {}, raw = 'raw'): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function evalDir(className: string, value: string): ConfDirective {
  return { key: `EVAL-${className}`, value, line: 1, directiveType: 'EVAL', className };
}

describe('applyEvalExpressions — dotted (nested JSON) field names', () => {
  it('treats an unquoted dotted name as concatenation, NOT a field reference', () => {
    // `event.field` is `event . field` (concat of two missing fields) → empty,
    // matching Splunk. It must NOT resolve to the value of the `event.field` field.
    const result = applyEvalExpressions(
      [event({ 'event.field': 'NESTED' })],
      [evalDir('x', 'event.field')],
    )[0]!;
    expect(result.fields['x']).not.toBe('NESTED');
  });

  it('resolves a single-quoted dotted field reference', () => {
    const result = applyEvalExpressions(
      [event({ 'event.field': 'NESTED' })],
      [evalDir('x', "'event.field'")],
    )[0]!;
    expect(result.fields['x']).toBe('NESTED');
  });

  it('warns when an unquoted dotted name matches an extracted field', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    applyEvalExpressions([event({ 'event.field': 'NESTED' })], [evalDir('x', 'event.field')], diagnostics);
    const warn = diagnostics.find((d) => d.message.includes('event.field'));
    expect(warn).toBeDefined();
    expect(warn!.level).toBe('warning');
    expect(warn!.suggestion).toBe("Use 'event.field' instead of event.field.");
  });

  it('does NOT warn for the correctly-quoted form', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    applyEvalExpressions([event({ 'event.field': 'NESTED' })], [evalDir('x', "'event.field'")], diagnostics);
    expect(diagnostics).toHaveLength(0);
  });
});

describe('applyEvalExpressions — arithmetic', () => {
  it('adds two numbers', () => {
    const result = applyEvalExpressions([event({ a: '3', b: '4' })], [evalDir('sum', 'a + b')])[0]!;
    // Fields are always stored as strings
    expect(result.fields['sum']).toBe('7');
  });

  it('multiplies', () => {
    const result = applyEvalExpressions([event({ x: '6' })], [evalDir('doubled', 'x * 2')])[0]!;
    expect(result.fields['doubled']).toBe('12');
  });

  it('string concat with .', () => {
    const result = applyEvalExpressions([event({ a: 'hello' })], [evalDir('msg', 'a . " world"')])[0]!;
    expect(result.fields['msg']).toBe('hello world');
  });

  // SEM-8: + concatenates non-numeric strings rather than coercing to 0.
  it('+ concatenates two non-numeric strings', () => {
    const result = applyEvalExpressions([event({ a: 'foo', b: 'bar' })], [evalDir('c', 'a + b')])[0]!;
    expect(result.fields['c']).toBe('foobar');
  });

  // SEM-8: NULL propagates through arithmetic (null + 5 = null, not 5).
  it('propagates NULL through + (missing field)', () => {
    const result = applyEvalExpressions([event({})], [evalDir('c', 'missing + 5')])[0]!;
    expect(result.fields['c']).toBeUndefined(); // null result → field not set
  });

  it('propagates NULL through * and unary minus', () => {
    const r1 = applyEvalExpressions([event({})], [evalDir('c', 'missing * 2')])[0]!;
    expect(r1.fields['c']).toBeUndefined();
    const r2 = applyEvalExpressions([event({})], [evalDir('c', '-missing')])[0]!;
    expect(r2.fields['c']).toBeUndefined();
  });
});

describe('applyEvalExpressions — numeric predicates', () => {
  it('isnum() is false for non-numeric strings', () => {
    const r = applyEvalExpressions([event({ a: 'abc' })], [evalDir('n', 'isnum(a)')])[0]!;
    expect(r.fields['n']).toBe('false');
  });

  it('isnum() is true for numeric strings', () => {
    const r = applyEvalExpressions([event({ a: '3.14' })], [evalDir('n', 'isnum(a)')])[0]!;
    expect(r.fields['n']).toBe('true');
  });

  it('isint() is false for non-numeric and non-integer input', () => {
    const r1 = applyEvalExpressions([event({ a: 'abc' })], [evalDir('n', 'isint(a)')])[0]!;
    expect(r1.fields['n']).toBe('false');
    const r2 = applyEvalExpressions([event({ a: '5.5' })], [evalDir('n', 'isint(a)')])[0]!;
    expect(r2.fields['n']).toBe('false');
    const r3 = applyEvalExpressions([event({ a: '5' })], [evalDir('n', 'isint(a)')])[0]!;
    expect(r3.fields['n']).toBe('true');
  });

  it('round() rounds halves away from zero', () => {
    const r = applyEvalExpressions([event({ a: '-2.5' })], [evalDir('n', 'round(a)')])[0]!;
    expect(r.fields['n']).toBe('-3');
  });
});

describe('applyEvalExpressions — function fidelity', () => {
  it('typeof returns Number / String / Bool / Invalid', () => {
    const r = applyEvalExpressions(
      [event({})],
      [evalDir('t', 'typeof(12) . "," . typeof("hi") . "," . typeof(1==1) . "," . typeof(missing)')],
    )[0]!;
    expect(r.fields['t']).toBe('Number,String,Bool,Invalid');
  });

  it('like() is case-sensitive', () => {
    const hit = applyEvalExpressions([event({ a: 'Error' })], [evalDir('m', 'if(like(a, "Error"), "y", "n")')])[0]!;
    expect(hit.fields['m']).toBe('y');
    const miss = applyEvalExpressions([event({ a: 'error' })], [evalDir('m', 'if(like(a, "Error"), "y", "n")')])[0]!;
    expect(miss.fields['m']).toBe('n');
  });

  it('mvindex supports negative indices and NULL-on-out-of-range', () => {
    const r = applyEvalExpressions(
      [event({})],
      [evalDir('last', 'mvindex(split("a,b,c", ","), -1)')],
    )[0]!;
    expect(r.fields['last']).toBe('c');
    const oor = applyEvalExpressions(
      [event({})],
      [evalDir('x', 'mvindex(split("a,b", ","), 9)')],
    )[0]!;
    expect(oor.fields['x']).toBeUndefined(); // null → field deleted
  });

  it('mvzip stops at the shorter field (no padding)', () => {
    const r = applyEvalExpressions(
      [event({})],
      [evalDir('z', 'mvjoin(mvzip(split("a,b,c", ","), split("1,2", ",")), "|")')],
    )[0]!;
    expect(r.fields['z']).toBe('a,1|b,2');
  });

  it('mvcount returns NULL for no values and 1 for a single value', () => {
    // No values → null → field not set.
    const none = applyEvalExpressions([event({})], [evalDir('c', 'mvcount(missing)')])[0]!;
    expect(none.fields['c']).toBeUndefined();
    // Single value → 1.
    const one = applyEvalExpressions([event({ a: 'x' })], [evalDir('c', 'mvcount(a)')])[0]!;
    expect(one.fields['c']).toBe('1');
    // Multivalue → count.
    const many = applyEvalExpressions([event({})], [evalDir('c', 'mvcount(split("a,b,c", ","))')])[0]!;
    expect(many.fields['c']).toBe('3');
  });

  it('isbool and isstr report the value type like typeof', () => {
    const r = applyEvalExpressions(
      [event({ a: 'hi' })],
      [evalDir('t', 'isstr(a) . "," . isstr(1==1) . "," . isbool(1==1) . "," . isbool("x")')],
    )[0]!;
    expect(r.fields['t']).toBe('true,false,true,false');
  });

  it('max() treats strings as greater than numbers; min() picks the number', () => {
    const mx = applyEvalExpressions([event({})], [evalDir('m', 'max(5, "apple", 10)')])[0]!;
    expect(mx.fields['m']).toBe('apple');
    const mn = applyEvalExpressions([event({})], [evalDir('m', 'min(5, "apple", 10)')])[0]!;
    expect(mn.fields['m']).toBe('5');
  });

  it('tostring duration zero-pads hours and rolls over days', () => {
    const r = applyEvalExpressions([event({})], [evalDir('d', 'tostring(615, "duration")')])[0]!;
    expect(r.fields['d']).toBe('00:10:15');
    const r2 = applyEvalExpressions([event({})], [evalDir('d', 'tostring(90061, "duration")')])[0]!;
    expect(r2.fields['d']).toBe('1+01:01:01');
  });

  it('tostring commas keeps thousands separators and 2-dp precision for fractions', () => {
    const r = applyEvalExpressions([event({})], [evalDir('c', 'tostring(1000000.1278, "commas")')])[0]!;
    expect(r.fields['c']).toBe('1,000,000.13');
  });

  // SEM-8: integers get no forced ".00".
  it('tostring commas shows no decimals for an integer', () => {
    const r = applyEvalExpressions([event({})], [evalDir('c', 'tostring(12345, "commas")')])[0]!;
    expect(r.fields['c']).toBe('12,345');
  });

  // SEM-8: expanded strftime token coverage (%b month abbr, %p AM/PM, %Y).
  it('strftime supports %b/%p/%Y tokens', () => {
    // 1705312800 = 2024-01-15T10:00:00Z. Asserts only timezone-independent tokens.
    const r = applyEvalExpressions([event({})], [evalDir('d', 'strftime(1705312800, "%Y %b")')])[0]!;
    expect(r.fields['d']).toBe('2024 Jan');
  });

  it('random() returns an integer in [0, 2^31)', () => {
    const r = applyEvalExpressions([event({})], [evalDir('r', 'random()')])[0]!;
    const n = Number(r.fields['r']);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThanOrEqual(0);
    expect(n).toBeLessThan(2147483648);
  });
});

describe('applyEvalExpressions — replace() ReDoS guard', () => {
  it('returns original string for a ReDoS-risky pattern', () => {
    // (a+)+ is the classic ReDoS pattern
    const result = applyEvalExpressions(
      [event({}, 'aaaaaab')],
      [evalDir('safe', 'replace(_raw, "(a+)+", "x")')]
    )[0]!;
    // safeRegex rejects the pattern — original _raw returned unchanged
    expect(result.fields['safe']).toBe('aaaaaab');
  });

  it('performs valid replace()', () => {
    const result = applyEvalExpressions(
      [event({}, '2024-01-15')],
      [evalDir('redacted', 'replace(_raw, "\\\\d{4}", "YYYY")')]
    )[0]!;
    expect(result.fields['redacted']).toBe('YYYY-01-15');
  });
});

describe('applyEvalExpressions — crypto stubs', () => {
  it('md5() returns not-simulated placeholder', () => {
    const result = applyEvalExpressions([event()], [evalDir('h', 'md5("test")')])[0]!;
    expect(result.fields['h']).toBe('[md5() not simulated]');
  });

  it('sha256() returns not-simulated placeholder', () => {
    const result = applyEvalExpressions([event()], [evalDir('h', 'sha256("test")')])[0]!;
    expect(result.fields['h']).toBe('[sha256() not simulated]');
  });
});

describe('applyEvalExpressions — string functions', () => {
  it('upper() uppercases', () => {
    const result = applyEvalExpressions([event({ s: 'hello' })], [evalDir('u', 'upper(s)')])[0]!;
    expect(result.fields['u']).toBe('HELLO');
  });

  it('lower() lowercases', () => {
    const result = applyEvalExpressions([event({ s: 'HELLO' })], [evalDir('l', 'lower(s)')])[0]!;
    expect(result.fields['l']).toBe('hello');
  });

  it('len() returns string length', () => {
    const result = applyEvalExpressions([event({ s: 'abcde' })], [evalDir('n', 'len(s)')])[0]!;
    expect(result.fields['n']).toBe('5');
  });

  it('if() selects true branch', () => {
    const result = applyEvalExpressions(
      [event({ x: '10' })],
      [evalDir('r', 'if(x > 5, "big", "small")')]
    )[0]!;
    expect(result.fields['r']).toBe('big');
  });
});

describe('applyEvalExpressions — KV key extraction with hyphens', () => {
  it('eval expressions do not break when field names have hyphens via _raw', () => {
    // This test verifies the pipeline does not crash; eval does not rename fields
    const ev = event({}, 'x-forwarded-for=1.2.3.4');
    const result = applyEvalExpressions([ev], [evalDir('raw_copy', '_raw')])[0]!;
    expect(result.fields['raw_copy']).toBe('x-forwarded-for=1.2.3.4');
  });
});

describe('applyEvalExpressions — IN / NOT IN operator', () => {
  it('IN returns true when field value is in the list', () => {
    const r = applyEvalExpressions(
      [event({ eventName: 'DeleteUser' })],
      [evalDir('hit', 'eventName IN ("DeleteUser","UpdateUser","CreateUser")')]
    )[0]!;
    expect(r.fields['hit']).toBe('true');
  });

  it('IN returns false when field value is not in the list', () => {
    const r = applyEvalExpressions(
      [event({ eventName: 'ListBuckets' })],
      [evalDir('hit', 'eventName IN ("DeleteUser","UpdateUser","CreateUser")')]
    )[0]!;
    expect(r.fields['hit']).toBe('false');
  });

  it('NOT IN returns true when value is absent from list', () => {
    const r = applyEvalExpressions(
      [event({ eventName: 'ListBuckets' })],
      [evalDir('hit', 'eventName NOT IN ("DeleteUser","UpdateUser")')]
    )[0]!;
    expect(r.fields['hit']).toBe('true');
  });

  it('NOT IN returns false when value is present in list', () => {
    const r = applyEvalExpressions(
      [event({ eventName: 'DeleteUser' })],
      [evalDir('hit', 'eventName NOT IN ("DeleteUser","UpdateUser")')]
    )[0]!;
    expect(r.fields['hit']).toBe('false');
  });

  it('IN works with numeric comparison', () => {
    const r = applyEvalExpressions(
      [event({ code: '200' })],
      [evalDir('ok', 'code IN (200, 201, 204)')]
    )[0]!;
    expect(r.fields['ok']).toBe('true');
  });

  it('IN inside case() — CloudTrail-style pattern', () => {
    const r = applyEvalExpressions(
      [event({ eventName: 'ListAliases', 'userIdentity.userName': 'alice' })],
      [evalDir('src_user_name', `case(eventName IN ("AssumeRoleWithSAML","AssumeRoleWithWebIdentity","ListAliases"),'userIdentity.userName',eventName="AssumeRole","assumed")`)]
    )[0]!;
    expect(r.fields['src_user_name']).toBe('alice');
  });

  it('standalone NOT before non-IN expression still works', () => {
    const r = applyEvalExpressions(
      [event({ x: '0' })],
      [evalDir('r', 'if(NOT x, "yes", "no")')]
    )[0]!;
    expect(r.fields['r']).toBe('yes');
  });
});

describe('applyEvalExpressions — lazy evaluation (SEM-8)', () => {
  // The untaken branch of if() must not run — so its stub warning must not fire.
  it('if() does not evaluate (or warn about) the untaken branch', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions(
      [event({ x: '1' })],
      [evalDir('r', 'if(x == 1, "yes", md5("never"))')],
      diagnostics,
    )[0]!;
    expect(r.fields['r']).toBe('yes');
    // md5() is a stub; it sits on the false branch and must not be reached.
    expect(diagnostics.some((d) => d.message.includes('md5'))).toBe(false);
  });

  it('case() stops at the first matching predicate', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions(
      [event({ x: '1' })],
      [evalDir('r', 'case(x == 1, "first", true, sha256("never"))')],
      diagnostics,
    )[0]!;
    expect(r.fields['r']).toBe('first');
    expect(diagnostics.some((d) => d.message.includes('sha256'))).toBe(false);
  });

  it('coalesce() stops at the first non-null and does not evaluate later args', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions(
      [event({ a: 'present' })],
      // Probed with a stub that warns when evaluated. This used cidrmatch()
      // until #291 simulated it, after which the assertion held vacuously.
      [evalDir('r', 'coalesce(a, searchmatch("x"))')],
      diagnostics,
    )[0]!;
    expect(r.fields['r']).toBe('present');
    expect(diagnostics.some((d) => d.message.includes('searchmatch'))).toBe(false);
  });

  it('OR short-circuits when the left operand is true', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions(
      [event({ x: '1' })],
      [evalDir('r', 'if(x == 1 OR searchmatch("y"), "hit", "miss")')],
      diagnostics,
    )[0]!;
    expect(r.fields['r']).toBe('hit');
    expect(diagnostics.some((d) => d.message.includes('searchmatch'))).toBe(false);
  });

  it('AND short-circuits when the left operand is false', () => {
    const diagnostics: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions(
      [event({ x: '0' })],
      [evalDir('r', 'if(x == 1 AND searchmatch("y"), "hit", "miss")')],
      diagnostics,
    )[0]!;
    expect(r.fields['r']).toBe('miss');
    expect(diagnostics.some((d) => d.message.includes('searchmatch'))).toBe(false);
  });
});

describe('applyEvalExpressions — complex nested case() with OR', () => {
  it('parses case() with deeply nested OR expressions and single-quoted field names', () => {
    const ev = event(
      {
        'additionalEventData.MFAUsed': 'No',
        eventName: 'ConsoleLogin',
        'userIdentity.type': 'AssumedRole',
        'userIdentity.sessionContext.attributes.mfaAuthenticated': 'false',
      },
      'test'
    );
    
    const expr = `case((('additionalEventData.MFAUsed'="Yes" AND eventName="ConsoleLogin") OR eventName="CheckMfa"), "MFA", ('additionalEventData.MFAUsed'="No" AND eventName="ConsoleLogin") OR ((eventName="AssumeRole" OR eventName="ListAliases") AND 'userIdentity.type'="AssumedRole" AND 'userIdentity.sessionContext.attributes.mfaAuthenticated'="false"), "SFA")`;
    
    const result = applyEvalExpressions([ev], [evalDir('auth_method', expr)])[0]!;
    expect(result.fields['auth_method']).toBe('SFA');
  });
});

// #9: the lexer folded a `-` after ANY paren into a negative literal, and the
// parser never checked for leftover tokens — so `len(x) - 1` silently became
// `len(x)` and malformed input was accepted.
describe('applyEvalExpressions — parser correctness (#9)', () => {
  it('subtracts after a closing paren instead of lexing a negative literal', () => {
    const r = applyEvalExpressions([event({ x: 'hello' })], [evalDir('n', 'len(x) - 1')])[0]!;
    expect(r.fields['n']).toBe('4'); // len("hello") = 5, minus 1
  });

  it('subtracts after a parenthesised expression', () => {
    const r = applyEvalExpressions([event({ a: '10' })], [evalDir('n', '(a) - 1')])[0]!;
    expect(r.fields['n']).toBe('9');
  });

  it('still folds a genuine negative literal at the start / after an operator', () => {
    const r1 = applyEvalExpressions([event({})], [evalDir('n', '-5 * 2')])[0]!;
    expect(r1.fields['n']).toBe('-10');
    const r2 = applyEvalExpressions([event({ a: '5' })], [evalDir('n', 'a - -1')])[0]!;
    expect(r2.fields['n']).toBe('6');
  });

  it('reports an error on leftover tokens rather than silently truncating', () => {
    const diags: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions([event({})], [evalDir('n', '1 + 2 foo')], diags)[0]!;
    expect(r.fields['n']).toBeUndefined();
    expect(diags.some((d) => d.level === 'error')).toBe(true);
  });

  it('rejects a number with two decimal points as malformed', () => {
    const diags: import('../types').ValidationDiagnostic[] = [];
    const r = applyEvalExpressions([event({})], [evalDir('n', '1.2.3')], diags)[0]!;
    expect(r.fields['n']).toBeUndefined();
    expect(diags.some((d) => d.level === 'error')).toBe(true);
  });
});

// #10: non-numeric values coerced to 0 diverged from Splunk NULL semantics.
describe('applyEvalExpressions — numeric NULL semantics (#10)', () => {
  it('does not treat a non-numeric string as 0 in comparison', () => {
    const r = applyEvalExpressions([event({ a: 'abc' })], [evalDir('n', 'if(a == 0, "eq", "ne")')])[0]!;
    expect(r.fields['n']).toBe('ne');
  });

  it('still compares numeric strings numerically', () => {
    const r = applyEvalExpressions([event({ a: '5' })], [evalDir('n', 'if(a == 5, "eq", "ne")')])[0]!;
    expect(r.fields['n']).toBe('eq');
  });

  it('propagates NULL through arithmetic on a non-numeric operand', () => {
    const r = applyEvalExpressions([event({ a: 'abc' })], [evalDir('n', 'a * 2')])[0]!;
    expect(r.fields['n']).toBeUndefined(); // null → field not set
  });

  it('returns NULL from a math function given non-numeric input', () => {
    const r = applyEvalExpressions([event({})], [evalDir('n', 'abs("foo")')])[0]!;
    expect(r.fields['n']).toBeUndefined();
  });

  it('passes a non-numeric value through tostring(...) unchanged', () => {
    const r = applyEvalExpressions([event({})], [evalDir('n', 'tostring("abc", "commas")')])[0]!;
    expect(r.fields['n']).toBe('abc');
  });

  it('binds NOT below comparison: NOT 1 = 2 is NOT (1 = 2)', () => {
    const r = applyEvalExpressions([event({})], [evalDir('n', 'if(NOT 1 = 2, "Y", "N")')])[0]!;
    expect(r.fields['n']).toBe('Y');
  });
});

describe('applyEvalExpressions — string escapes reach regex functions intact (#54)', () => {
  it('match() honours a single-backslash class', () => {
    const result = applyEvalExpressions(
      [event({}, 'abc123')],
      [evalDir('m', 'match(_raw, "\\d+")')],
    )[0]!;
    expect(result.fields['m']).toBe('true');
  });

  it('still accepts the double-backslash form', () => {
    const result = applyEvalExpressions(
      [event({}, 'abc123')],
      [evalDir('m', 'match(_raw, "\\\\d+")')],
    )[0]!;
    expect(result.fields['m']).toBe('true');
  });

  it('unescapes \\" and \\\\ only', () => {
    const result = applyEvalExpressions([event()], [evalDir('s', '"a\\"b\\\\c\\d"')])[0]!;
    expect(result.fields['s']).toBe('a"b\\c\\d');
  });
});

describe('applyEvalExpressions — replace() backreferences (#54)', () => {
  it('swaps groups with \\1 / \\2 (the docs example)', () => {
    const result = applyEvalExpressions(
      [event({ date: '1/14/2017' })],
      [evalDir('us', 'replace(date, "^(\\d{1,2})/(\\d{1,2})/", "\\2/\\1/")')],
    )[0]!;
    expect(result.fields['us']).toBe('14/1/2017');
  });

  it('treats \\0 as the whole match', () => {
    const result = applyEvalExpressions(
      [event({}, 'abc')],
      [evalDir('w', 'replace(_raw, "b", "[\\0]")')],
    )[0]!;
    expect(result.fields['w']).toBe('a[b]c');
  });

  it('does not apply JS $-substitutions', () => {
    const result = applyEvalExpressions(
      [event({}, 'abc')],
      [evalDir('d', 'replace(_raw, "b", "$1$&")')],
    )[0]!;
    expect(result.fields['d']).toBe('a$1$&c');
  });
});

describe('applyEvalExpressions — strftime %z / %Z (#75.4)', () => {
  it('emits a numeric offset rather than the literal specifier', () => {
    const result = applyEvalExpressions([event()], [evalDir('t', 'strftime(1705312800, "%Y-%m-%dT%H:%M:%S%z")')])[0]!;
    expect(result.fields['t']).not.toContain('%z');
    expect(result.fields['t']).toMatch(/[+-]\d{4}$/);
  });

  it('emits a zone name for %Z', () => {
    const result = applyEvalExpressions([event()], [evalDir('t', 'strftime(1705312800, "%Z")')])[0]!;
    expect(result.fields['t']).not.toBe('%Z');
    expect(String(result.fields['t']).length).toBeGreaterThan(0);
  });
});

describe('applyEvalExpressions — strftime with an out-of-range epoch', () => {
  // An epoch past the Date range gives an Invalid Date, whose accessors all
  // return NaN — including the ones indexing the month/day name tables. The
  // engine already refused this input, but only incidentally: %Z's
  // Intl.formatToParts call threw "Invalid time value" while the token table was
  // being built. It is now rejected up front, so the field is still dropped and
  // the diagnostic names strftime rather than reading like an internal fault.
  //
  // Spelled out in full rather than as 1e20: the tokenizer has no exponent form,
  // so `1e20` lexes as `1` then the identifier `e20` and never reaches strftime.
  const HUGE = '99999999999999999999';

  it.each(['%b', '%B', '%a', '%A', '%F'])('reports an error and drops the field for %s', (token) => {
    const diagnostics: ValidationDiagnostic[] = [];
    const result = applyEvalExpressions([event()], [evalDir('t', `strftime(${HUGE}, "${token}")`)], diagnostics)[0]!;
    expect(result.fields['t']).toBeUndefined();
    expect(diagnostics.map((d) => d.message)).toEqual(['EVAL-t: strftime(): timestamp is out of range']);
  });

  it('never renders NaN or an echoed specifier into the field', () => {
    const result = applyEvalExpressions([event()], [evalDir('t', `strftime(${HUGE}, "%F %b")`)])[0]!;
    expect(result.fields['t'] ?? '').not.toMatch(/NaN|%[bF]/);
  });

  it('still formats a normal epoch', () => {
    const result = applyEvalExpressions([event()], [evalDir('t', 'strftime(1705312800, "%b")')])[0]!;
    expect(result.fields['t']).toBe('Jan');
  });
});

/** Evaluate one expression against a field bag; undefined when no field is written. */
function evalWith(expr: string, fields: Record<string, string>): string | string[] | undefined {
  return applyEvalExpressions([event(fields)], [evalDir('out', expr)])[0]!.fields['out'];
}

describe('#165 — true() as a case() fallback', () => {
  it('takes the trailing true() branch when no earlier test matches', () => {
    const out = evalWith('case(status < 300, "ok", status < 500, "client", true(), "server")', {
      status: '503',
    });
    expect(out).toBe('server');
  });

  it('still prefers an earlier matching branch over the fallback', () => {
    const out = evalWith('case(status < 300, "ok", true(), "other")', { status: '200' });
    expect(out).toBe('ok');
  });

  it('evaluates false() as false, so its branch is skipped', () => {
    expect(evalWith('case(false(), "no", true(), "yes")', {})).toBe('yes');
  });

  it('treats if(true(), …) the same way', () => {
    expect(evalWith('if(true(), "taken", "not")', {})).toBe('taken');
  });
});

describe('#168 — null propagates through concatenation', () => {
  it('produces no value when the left side is a missing field', () => {
    expect(evalWith('absent_field . "-suffix"', { user: 'alice' })).toBeUndefined();
  });

  it('produces no value when the right side is a missing field', () => {
    expect(evalWith('"prefix-" . absent_field', { user: 'alice' })).toBeUndefined();
  });

  it('still concatenates when both sides exist', () => {
    expect(evalWith('user . "-suffix"', { user: 'alice' })).toBe('alice-suffix');
  });

  it('keeps an empty-string field distinct from a missing one', () => {
    // A field that exists but is empty is not null, so it concatenates.
    expect(evalWith('empty . "-suffix"', { empty: '' })).toBe('-suffix');
  });

  it('leaves the isnull() guard meaning what it says', () => {
    expect(evalWith('if(isnull(absent_field), "missing", "present")', {})).toBe('missing');
  });
});

describe('#211 — null propagates into function arguments', () => {
  // #168 fixed the operators; the functions kept coercing an absent field to ""
  // first, so `EVAL-ulen = len(user)` wrote 0 on every event without a `user`.
  // 0 is the damaging case precisely because it looks like a real answer.
  it('writes no field for len() of a missing field', () => {
    expect(evalWith('len(user)', {})).toBeUndefined();
  });

  it.each([
    ['upper(user)'],
    ['lower(user)'],
    ['trim(user)'],
    ['ltrim(user)'],
    ['rtrim(user)'],
    ['substr(user, 1, 3)'],
    ['replace(user, "a", "b")'],
    ['urldecode(user)'],
    ['split(user, ",")'],
    ['mvjoin(user, ",")'],
    ['tostring(user)'],
    ['strftime(user, "%F")'],
  ])('writes no field for %s when user is absent', (expr) => {
    expect(evalWith(expr, {})).toBeUndefined();
  });

  it('keeps an empty-but-present field distinct from a missing one', () => {
    // The field exists, so it is "" and not null: len("") is genuinely 0.
    expect(evalWith('len(user)', { user: '' })).toBe('0');
    expect(evalWith('upper(user)', { user: '' })).toBe('');
  });

  it('still computes over a field that is present', () => {
    expect(evalWith('len(user)', { user: 'alice' })).toBe('5');
    expect(evalWith('upper(user)', { user: 'alice' })).toBe('ALICE');
  });

  it('leaves coalesce() able to supply the default it exists for', () => {
    expect(evalWith('coalesce(user, "anonymous")', {})).toBe('anonymous');
    expect(evalWith('len(coalesce(user, "anonymous"))', {})).toBe('9');
  });

  it('does not propagate through the type predicates, which report on absence', () => {
    // These answer a question about the value rather than computing from it, so
    // they must keep returning a value the surrounding if()/case() can branch on.
    expect(evalWith('if(isnull(user), "missing", "present")', {})).toBe('missing');
    expect(evalWith('typeof(user)', {})).toBe('Invalid');
    // match() and like() were listed here too. Since #343 they yield NULL for a
    // NULL subject, as the comparison operators do; NULL is falsy in if(), so
    // the guard below still takes its else branch.
    expect(evalWith('if(match(user, "^a"), "yes", "no")', {})).toBe('no');
    expect(evalWith('if(like(user, "a%"), "yes", "no")', {})).toBe('no');
  });

  it('drops the whole expression when a missing field feeds a longer chain', () => {
    expect(evalWith('upper(trim(user))', {})).toBeUndefined();
    expect(evalWith('len(user) + 1', {})).toBeUndefined();
    expect(evalWith('"user=" . upper(user)', {})).toBeUndefined();
  });
});
