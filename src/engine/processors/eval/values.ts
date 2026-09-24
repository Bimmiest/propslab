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
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
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
  if (isNumericValue(l) && isNumericValue(r)) return toNum(l) + toNum(r);
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
 * 0). Booleans still coerce (true→1, false→0), matching Splunk.
 */
export function numArg(v: EvalArg): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length > 0 ? numArg(v[0]) : null;
  return isNumericString(v) ? Number(v) : null;
}

/** `-`, `*`, `/`, `%` with NULL propagation (null or non-numeric operand → null). */
export function arith(l: EvalArg, r: EvalArg, op: '-' | '*' | '/' | '%'): EvalValue {
  const a = numArg(l);
  const b = numArg(r);
  if (a === null || b === null) return null;
  switch (op) {
    case '-': return a - b;
    case '*': return a * b;
    case '/': return b !== 0 ? a / b : null;
    case '%': return b !== 0 ? a % b : null;
  }
}

export function toMv(v: EvalArg): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (v === null || v === undefined) return [];
  return [String(v)];
}

function isNumericString(v: EvalArg): boolean {
  if (typeof v !== 'string' || v === '') return false;
  return !isNaN(Number(v));
}

/**
 * True when the value is genuinely numeric — a number, or a string that parses
 * cleanly as one. Used by isnum()/isint(); unlike toNum() it does not coerce
 * non-numeric input to 0 (which made isnum("abc") wrongly return true).
 */
export function isNumericValue(v: EvalArg): boolean {
  if (typeof v === 'number') return Number.isFinite(v);
  return isNumericString(v);
}

/**
 * Splunk ordering for min()/max(): numeric values compare numerically, strings
 * compare lexicographically, and any number is considered less than any string.
 * Returns <0 if a<b, >0 if a>b, 0 if equal.
 */
function compareEvalValues(a: EvalArg, b: EvalArg): number {
  const aNum = isNumericValue(a);
  const bNum = isNumericValue(b);
  if (aNum && bNum) return Number(a) - Number(b);
  if (aNum) return -1; // number < string
  if (bNum) return 1;
  const as = toStr(a);
  const bs = toStr(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** min()/max() over scalars and multivalue args, using Splunk's mixed-type ordering. */
export function minMax(args: EvalValue[], which: 'min' | 'max'): EvalValue {
  let best: EvalValue | undefined;
  for (const v of args.flatMap((a) => (Array.isArray(a) ? a : [a]))) {
    // NULLs are not candidates: min(null, 3) is 3, and min(null) is NULL.
    if (v === null || v === undefined) continue;
    if (best === undefined) { best = v; continue; }
    const cmp = compareEvalValues(v, best);
    if (which === 'min' ? cmp < 0 : cmp > 0) best = v;
  }
  return best ?? null;
}

/**
 * A value read as a condition under SPL's three-valued logic: NULL stays NULL
 * (neither true nor false), anything else is {@link toBool}'s answer. NOT, AND,
 * OR and XOR combine these; if()/case() and every other consumer that needs a
 * yes or no treat NULL as not-true (#343).
 */
export function toTri(v: EvalArg): boolean | null {
  return v === null || v === undefined ? null : toBool(v);
}

export function compare(left: EvalArg, right: EvalArg, op: string): boolean | null {
  // Any comparison involving NULL is NULL, not a comparison against "" (#343).
  // Coercing an absent field to "" made `missing == ""` true and `missing != "a"`
  // true, so a guard written to test a field's value fired on events that do not
  // have the field at all. NULL is falsy wherever a condition is read, and
  // isnull()/isnotnull()/coalesce() are how an expression tests for absence.
  if (left === null || left === undefined || right === null || right === undefined) return null;

  // Splunk eval: compare numerically only when BOTH sides are numeric (a number
  // or a string that parses cleanly as one). Otherwise compare as strings. This
  // avoids coercing a non-numeric operand to 0 — `"abc" == 0` must be false, not
  // true (which is what `0 === toNum("abc")` used to produce).
  const bothNumeric = isNumericValue(left) && isNumericValue(right);

  const l = bothNumeric ? Number(left) : toStr(left);
  const r = bothNumeric ? Number(right) : toStr(right);

  switch (op) {
    case '==': case '=': return l === r;
    case '!=': return l !== r;
    case '<': return l < r;
    case '>': return l > r;
    case '<=': return l <= r;
    case '>=': return l >= r;
    default: return false;
  }
}
