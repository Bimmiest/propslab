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
 * The one string → number coercion eval uses: arithmetic, comparisons,
 * isnum()/isint() and tonumber() without a base all read a string through
 * this, so they can never disagree about whether it is a number. Decimal
 * only — JS `Number()` also accepts `0x10`, `0b11`, `Infinity` and a blank
 * string (as 0), none of which Splunk reads as a number. Surrounding
 * whitespace is tolerated, as `Number()` did.
 */
export function parseDecimal(s: string): number | null {
  const t = s.trim();
  if (!DECIMAL_NUMBER.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
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
 * adds when both operands are numeric, and otherwise CONCATENATES strings
 * (`"a" + "b"` → "ab"). `.` is the dedicated concat operator, but `+` falls back
 * to concatenation rather than coercing strings to 0.
 */
export function addOrConcat(l: EvalArg, r: EvalArg): EvalValue {
  if (l === null || l === undefined || r === null || r === undefined) return null;
  const a = numericValue(l);
  const b = numericValue(r);
  if (a !== null && b !== null) return a + b;
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
  return parseDecimal(v);
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
  return typeof v === 'string' ? parseDecimal(v) : null;
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
 * Comparison of two single values: numerically when BOTH are numeric (a number
 * or a string that parses cleanly as one), otherwise as strings. This avoids
 * coercing a non-numeric operand to 0 — `"abc" == 0` must be false.
 */
function compareScalars(left: EvalValue, right: EvalValue, op: string): boolean {
  const leftNum = numericValue(left);
  const rightNum = numericValue(right);
  const bothNumeric = leftNum !== null && rightNum !== null;

  const l = bothNumeric ? leftNum : toStr(left);
  const r = bothNumeric ? rightNum : toStr(right);

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
  // NOT IN and with `NOT (f == "a")`.
  if (Array.isArray(left) || Array.isArray(right)) {
    const lefts = Array.isArray(left) ? left : [left];
    const rights = Array.isArray(right) ? right : [right];
    if (lefts.length === 0 || rights.length === 0) return null;
    const positive = op === '!=' ? '==' : op;
    const any = lefts.some((l) => rights.some((r) => compareScalars(l, r, positive)));
    return op === '!=' ? !any : any;
  }
  return compareScalars(left, right, op);
}
