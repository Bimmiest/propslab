// Eval's value model: the types an expression evaluates to, and the coercions
// and comparisons every operator and builtin shares. Nothing here knows about
// syntax, events or functions; it is the arithmetic of Splunk's typeless values.

export type EvalValue = string | number | boolean | null | string[];

/**
 * An argument slot that may not have been supplied. Splunk treats a missing eval
 * argument as NULL, which is exactly what every coercion helper below already
 * does with `undefined` — so builtins can index `args[n]` freely and let the
 * coercion decide, instead of asserting the argument was passed.
 */
export type EvalArg = EvalValue | undefined;

/**
 * Splunk's own wording for assigning a comparison's result to a field
 * (`EVAL-x = a==b`). Both EVAL- and INGEST_EVAL raise it and write nothing.
 */
export const BOOLEAN_ASSIGNMENT_ERROR =
  'Fields cannot be assigned a boolean result. Instead, try if([bool expr], [expr], [expr]).';

/** A decimal number: optional sign, digits with an optional fraction (or a bare fraction), optional exponent. */
const DECIMAL_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * A decimal number in a string, as tonumber() without a base reads it.
 * Decimal only — JS `Number()` also accepts `0x10`, `0b11`, `Infinity` and a
 * blank string (as 0), none of which Splunk reads as a number. Surrounding
 * whitespace is tolerated, as `Number()` did. Arithmetic, comparisons and
 * isnum() read a string through {@link parseNumber}, which adds the text of a
 * non-finite number.
 */
export function parseDecimal(s: string): number | null {
  const t = s.trim();
  if (!DECIMAL_NUMBER.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** The text a field shows for each non-finite number, and only that spelling. */
const NON_FINITE_TEXT: ReadonlyMap<string, number> = new Map([
  ['Infinity', Infinity],
  ['-Infinity', -Infinity],
  ['NaN', NaN],
]);

/**
 * A string read as a number by arithmetic, comparisons, isnum() and the math
 * functions: a decimal ({@link parseDecimal}), or exactly "Infinity",
 * "-Infinity" or "NaN", the text a non-finite result is shown as. So a field
 * holding "Infinity" reads back as the number, while "inf" and "nan" are not
 * numbers. tonumber() reads none of the three (#446).
 */
export function parseNumber(s: string): number | null {
  return NON_FINITE_TEXT.get(s) ?? parseDecimal(s);
}

export function toBool(v: EvalArg): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0 && v !== '0' && v.toLowerCase() !== 'false';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function toNum(v: EvalArg): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return parseDecimal(v) ?? 0;
  if (Array.isArray(v)) return v.length > 0 ? toNum(v[0]) : 0;
  return 0;
}

export function toStr(v: EvalArg): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(' ');
  return String(v);
}

/**
 * The `+` operator. Splunk propagates NULL through arithmetic (null + x = null),
 * adds when both operands are numeric (`"5" + "1"` → 6), and CONCATENATES two
 * strings when either is not (`"5" + "abc"` → "5abc"). `.` is the dedicated
 * concat operator, but `+` falls back to concatenation rather than coercing
 * strings to 0. A number is never concatenated: beside a value that is not
 * numeric it is NULL, so `"abc" + 1` and `"inf" + 1` are NULL (#446).
 */
export function addOrConcat(l: EvalArg, r: EvalArg): EvalValue {
  if (l === null || l === undefined || r === null || r === undefined) return null;
  const a = numericValue(l);
  const b = numericValue(r);
  if (a !== null && b !== null) return a + b;
  if (typeof l === 'number' || typeof r === 'number') return null;
  return toStr(l) + toStr(r);
}

/**
 * String operand for the string functions. Unlike {@link toStr} it does NOT
 * coerce an absent value to "" — it returns null so the caller can propagate
 * NULL the way Splunk does (`len(nonexistent)` is null, not 0).
 *
 * The distinction that makes this work is drawn in {@link getField}: a field
 * that is present and empty evaluates to "", a field that is absent evaluates
 * to null. So `len(empty_field)` is still 0 and only the absent case propagates.
 */
export function strArg(v: EvalArg): string | null {
  if (v === null || v === undefined) return null;
  return toStr(v);
}

/**
 * Numeric operand for arithmetic and math functions. Unlike {@link toNum} it
 * does NOT coerce a non-numeric value to 0 — it returns null so the caller can
 * propagate NULL the way Splunk does (`"abc" * 2` and `abs("foo")` are null, not
 * 0). Booleans still coerce (true→1, false→0), matching Splunk. A number is
 * taken as it is, Infinity and NaN included: they are numbers, not NULL (#446).
 */
export function numArg(v: EvalArg): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length > 0 ? numArg(v[0]) : null;
  return parseNumber(v);
}

/**
 * `-`, `*`, `/`, `%` with NULL propagation (null or non-numeric operand → null).
 * Division by zero is NULL, as the Search Reference's eval page says. Otherwise
 * the result is what floating point gives, special values included: `1e308 * 10`
 * is Infinity and `exp(1000) - exp(1000)` is NaN, numbers that a field shows as
 * "Infinity" and "NaN" (#446; the eval page names them "inf" and "nan").
 */
export function arith(l: EvalArg, r: EvalArg, op: '-' | '*' | '/' | '%'): EvalValue {
  const a = numArg(l);
  const b = numArg(r);
  if (a === null || b === null) return null;
  switch (op) {
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b !== 0 ? a / b : null;
    case '%':
      return b !== 0 ? a % b : null;
  }
}

export function toMv(v: EvalArg): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined) return [];
  return [String(v)];
}

/**
 * True when the value is genuinely numeric — a number, or a string that parses
 * cleanly as one. Used by isnum()/isint(); unlike toNum() it does not coerce
 * non-numeric input to 0 (which made isnum("abc") wrongly return true). Every
 * number counts, Infinity and NaN included, which typeof() calls "Number" (#446).
 */
export function isNumericValue(v: EvalArg): boolean {
  return numericValue(v) !== null;
}

/** The number a genuinely numeric value (see {@link isNumericValue}) stands for, or null. */
function numericValue(v: EvalArg): number | null {
  if (typeof v === 'number') return v;
  return typeof v === 'string' ? parseNumber(v) : null;
}

/**
 * Splunk ordering for min()/max(): numeric values compare numerically, strings
 * compare lexicographically, and any number is considered less than any string.
 * Returns <0 if a<b, >0 if a>b, 0 if equal.
 */
function compareEvalValues(a: EvalArg, b: EvalArg): number {
  const aNum = numericValue(a);
  const bNum = numericValue(b);
  if (aNum !== null && bNum !== null) return aNum - bNum;
  if (aNum !== null) return -1; // number < string
  if (bNum !== null) return 1;
  const as = toStr(a);
  const bs = toStr(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** min()/max() over scalars and multivalue args, using Splunk's mixed-type ordering. */
export function minMax(args: EvalValue[], which: 'min' | 'max'): EvalValue {
  let best: EvalValue | undefined;
  for (const v of args.flatMap((a) => (Array.isArray(a) ? a : [a]))) {
    // NULLs are not candidates: min(null, 3) is 3, and min(null) is NULL.
    if (v === null) continue;
    if (best === undefined) {
      best = v;
      continue;
    }
    const cmp = compareEvalValues(v, best);
    if (which === 'min' ? cmp < 0 : cmp > 0) best = v;
  }
  return best ?? null;
}

/**
 * A value read as a condition under SPL's three-valued logic: NULL stays NULL
 * (neither true nor false), anything else is {@link toBool}'s answer. NOT, AND,
 * OR and XOR combine these; if()/case() and every other consumer that needs a
 * yes or no treat NULL as not-true.
 */
export function toTri(v: EvalArg): boolean | null {
  return v === null || v === undefined ? null : toBool(v);
}

/**
 * Comparison of two single values. Against a number, the other side must be
 * numeric too (a number, or a string that parses as one), and the two compare
 * numerically: `"Infinity" > 5` is true. A value that is not numeric against a
 * number is NULL for every operator, never coerced to 0 or compared as text:
 * `"abc" > 5`, `"abc" == 5` and `"abc" != 5` are NULL (#446). Two strings
 * compare as text, numeric-looking or not: `"5" > "1"` holds and `"5" < "10"`
 * does not (#446).
 */
function compareScalars(left: EvalValue, right: EvalValue, op: string): boolean | null {
  let l: number | string = toStr(left);
  let r: number | string = toStr(right);
  if (typeof left === 'number' || typeof right === 'number') {
    const leftNum = numericValue(left);
    const rightNum = numericValue(right);
    if (leftNum === null || rightNum === null) return null;
    l = leftNum;
    r = rightNum;
  }

  switch (op) {
    case '==':
    case '=':
      return l === r;
    case '!=':
      return l !== r;
    case '<':
      return l < r;
    case '>':
      return l > r;
    case '<=':
      return l <= r;
    case '>=':
      return l >= r;
    default:
      return false;
  }
}

/** The operators a multivalue operand answers against a single value (see {@link compare}). */
const EQUALITY_OPS = new Set(['==', '=', '!=']);

export function compare(left: EvalArg, right: EvalArg, op: string): boolean | null {
  // Any comparison involving NULL is NULL, not a comparison against "", so a
  // guard written to test a field's value (`missing != "a"`) does not fire on
  // events that do not have the field at all. NULL is falsy wherever a condition is read, and
  // isnull()/isnotnull()/coalesce() are how an expression tests for absence.
  if (left === null || left === undefined || right === null || right === undefined) return null;

  // A multivalue operand matches when ANY of its values does (a field with
  // values a and b satisfies `f == "a"`), and never as the space-joined
  // string of them (#475). An operand with no values is NULL. `!=` is the
  // complement of `==` rather than "some value differs", so it agrees with
  // NOT IN and with `NOT (f == "a")` (#522).
  if (Array.isArray(left) || Array.isArray(right)) {
    const lefts = Array.isArray(left) ? left : [left];
    const rights = Array.isArray(right) ? right : [right];
    if (lefts.length === 0 || rights.length === 0) return null;
    // Against a single value, a multivalue is only ever tested for equality
    // with a string. `<`, `>`, `<=` and `>=` are NULL, and so is every
    // operator when the other side is a number: `mv == 5` is NULL where
    // `mv == "5"` matches (#522). Two multivalues keep the any-match rule.
    const single = Array.isArray(left) ? right : left;
    if (!Array.isArray(single) && (typeof single === 'number' || !EQUALITY_OPS.has(op))) return null;
    const positive = op === '!=' ? '==' : op;
    const any = lefts.some((l) => rights.some((r) => compareScalars(l, r, positive) === true));
    return op === '!=' ? !any : any;
  }
  return compareScalars(left, right, op);
}
