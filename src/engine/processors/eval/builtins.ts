// The non-branching eval functions: every builtin whose arguments are all
// evaluated before it runs, plus the helpers only they use (regex compilation
// and its failure message, CIDR matching, replace()'s backreference syntax).
// The branching functions (if/case/validate/coalesce) live in the evaluator,
// because they decide which argument nodes to evaluate at all.

import type { SplunkEvent } from '../../types';
import { safeRegex, validateRegex, type RegexMatch, type SplunkRegex } from '../../../utils/splunkRegex';
import { formatStrftime } from '../../../utils/strftime';
import {
  type EvalValue,
  isNumericValue,
  minMax,
  numArg,
  parseDecimal,
  strArg,
  toMv,
  toNum,
  toStr,
} from './values';

export interface EvalCtx {
  event: SplunkEvent;
  /** Epoch ms standing in for the current time — injected, never read from the clock here. */
  now: number;
  onStubWarning?: ((fn: string) => void) | undefined;
  /** A regex argument would not compile; the caller turns it into a diagnostic. */
  onRegexError?: ((fn: string, pattern: string) => void) | undefined;
}

/**
 * What an eval function does with a pattern it cannot compile, per function.
 * Each still returns a value — that is what made the failure silent — so the
 * warning has to say which value, or it reads as if the EVAL did nothing.
 */
const REGEX_FAILURE_RESULT: Readonly<Record<string, string>> = {
  replace: 'returned its input unchanged',
  match: 'evaluated to false',
  like: 'evaluated to false',
  mvfind: 'evaluated to null',
};

/** The shared tail of an eval regex-failure warning, for EVAL- and INGEST_EVAL alike. */
export function regexFailureMessage(fn: string, pattern: string): string {
  const why = validateRegex(pattern) ?? 'invalid regex';
  return `${fn}() pattern "${pattern}" could not be compiled (${why}), so it ${REGEX_FAILURE_RESULT[fn] ?? 'failed'}.`;
}

/** Compile an eval regex argument, reporting a pattern that will not compile. */
function evalRegex(ctx: EvalCtx, fn: string, pattern: string): SplunkRegex | null {
  const regex = safeRegex(pattern);
  if (regex === null) ctx.onRegexError?.(fn, pattern);
  return regex;
}

type Builtin = (args: EvalValue[], ctx: EvalCtx) => EvalValue;

/** A function of one string argument that propagates NULL. */
const onString = (f: (s: string) => EvalValue): Builtin => (args) => {
  const s = strArg(args[0]);
  return s === null ? null : f(s);
};

/** A function of one numeric argument; a non-numeric (or NULL) argument yields NULL. */
const onNumber = (f: (n: number) => EvalValue): Builtin => (args) => {
  const n = numArg(args[0]);
  return n === null ? null : f(n);
};

/** An unsimulated function: warn, then return `result(args)`. */
const stub = (name: string, result: (args: EvalValue[]) => EvalValue): Builtin => (args, ctx) => {
  ctx.onStubWarning?.(name);
  return result(args);
};

function substr(args: EvalValue[]): EvalValue {
  const s = strArg(args[0]);
  if (s === null) return null;
  const start = toNum(args[1]);
  // Checked against Splunk (#397): a start of 0 reads as 1, and a negative
  // start that reaches back past the first character is NULL, not clamped.
  if (start < -s.length) return null;
  const startIdx = start > 0 ? start - 1 : start < 0 ? s.length + start : 0;
  const len = args[2] !== undefined ? toNum(args[2]) : undefined;
  // slice, not substring: substring swaps reversed bounds, so a negative
  // length read backwards from the start instead of giving nothing.
  if (len === undefined) return s.slice(startIdx);
  return len > 0 ? s.slice(startIdx, startIdx + len) : '';
}

function trimFrom(side: 'left' | 'right'): Builtin {
  return (args) => {
    const s = strArg(args[0]);
    if (s === null) return null;
    const chars = args[1] !== undefined ? toStr(args[1]) : ' \t\n\r';
    if (side === 'left') {
      let i = 0;
      while (i < s.length && chars.includes(s.charAt(i))) i++;
      return s.substring(i);
    }
    let i = s.length - 1;
    while (i >= 0 && chars.includes(s.charAt(i))) i--;
    return s.substring(0, i + 1);
  };
}

// String — an absent argument propagates NULL rather than being coerced to
// "". `len(nonexistent)` is null, not 0; a plausible-looking 0 is worse than
// no field at all, because nothing about it says the field was missing.
// The type predicates (isnull, isnotnull, typeof, isnum, ...) deliberately
// do not propagate: they answer a question about the value, including its
// absence. The matching predicates (like, match, cidrmatch) do, as the
// comparison operators do.
const STRING_BUILTINS: Record<string, Builtin> = {
  nullif: (args) => toStr(args[0]) === toStr(args[1]) ? null : args[0] ?? null,
  lower: onString((s) => s.toLowerCase()),
  upper: onString((s) => s.toUpperCase()),
  len: onString((s) => s.length),
  substr,
  replace: (args, ctx) => {
    const s = strArg(args[0]);
    if (s === null) return null;
    const regex = evalRegex(ctx, 'replace', toStr(args[1]));
    if (!regex) return s;
    return regex.replace(s, splunkReplacement(toStr(args[2])), true);
  },
  trim: onString((s) => s.trim()),
  ltrim: trimFrom('left'),
  rtrim: trimFrom('right'),
  urldecode: onString((s) => {
    try { return decodeURIComponent(s); }
    catch { return s; }
  }),
  split: (args) => {
    const s = strArg(args[0]);
    if (s === null) return null;
    return s.split(toStr(args[1]));
  },
  mvjoin: (args) => {
    if (args[0] === null || args[0] === undefined) return null;
    return toMv(args[0]).join(toStr(args[1]));
  },
};

function tonumber(args: EvalValue[]): EvalValue {
  const val = toStr(args[0]).trim();
  const base = args[1] !== undefined ? Math.floor(toNum(args[1])) : 10;
  if (base === 10) return parseDecimal(val);
  const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
  if (!new RegExp(`^[${validChars}]+$`, 'i').test(val)) return null;
  const n = parseInt(val, base);
  return isNaN(n) ? null : n;
}

function formatDuration(val: number): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const total = Math.floor(Math.abs(val));
  const days = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const sign = val < 0 ? '-' : '';
  const hms = `${pad(h)}:${pad(m)}:${pad(s)}`;
  return days > 0 ? `${sign}${days}+${hms}` : `${sign}${hms}`;
}

function tostring(args: EvalValue[]): EvalValue {
  if (args[0] === null || args[0] === undefined) return null;
  const val = numArg(args[0]);
  // The numeric formats only apply to numeric input; a non-numeric value is
  // passed through unchanged rather than coerced to 0 (tostring("abc","commas") → "abc").
  if (args[1] !== undefined && val !== null) {
    const format = toStr(args[1]);
    if (format === 'hex') return '0x' + Math.floor(val).toString(16);
    if (format === 'commas') {
      // Thousands separators, up to two decimals. Splunk shows no decimals
      // for integers (e.g. 12,345) but keeps fractional precision (rounded
      // to 2 places) when present.
      return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
    }
    if (format === 'duration') return formatDuration(val);
  }
  return toStr(args[0]);
}

const TYPE_BUILTINS: Record<string, Builtin> = {
  tonumber,
  tostring,
  typeof: (args) => {
    // Splunk returns "Number" | "String" | "Bool" | "Invalid"
    // (a null / nonexistent field is "Invalid", not a separate null type).
    if (args[0] === null || args[0] === undefined) return 'Invalid';
    if (typeof args[0] === 'number') return 'Number';
    if (typeof args[0] === 'boolean') return 'Bool';
    if (Array.isArray(args[0])) return 'MultiValue';
    return 'String';
  },
  isnull: (args) => args[0] === null || args[0] === undefined,
  isnotnull: (args) => args[0] !== null && args[0] !== undefined,
  isint: (args) => isNumericValue(args[0]) && Number.isInteger(numArg(args[0])),
  isnum: (args) => isNumericValue(args[0]),
  // Informational functions mirror `typeof`'s type model: they report the
  // value's actual type rather than what it could be coerced to.
  isbool: (args) => typeof args[0] === 'boolean',
  isstr: (args) => typeof args[0] === 'string',
};

// Math — a non-numeric (or NULL) argument yields NULL rather than 0.
const MATH_BUILTINS: Record<string, Builtin> = {
  abs: onNumber(Math.abs),
  ceiling: onNumber(Math.ceil),
  ceil: onNumber(Math.ceil),
  floor: onNumber(Math.floor),
  round: (args) => {
    const val = numArg(args[0]);
    if (val === null) return null;
    const decimals = args[1] !== undefined ? numArg(args[1]) ?? 0 : 0;
    const factor = Math.pow(10, decimals);
    // Splunk rounds halves away from zero; JS Math.round rounds toward +∞.
    const scaled = val * factor;
    return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / factor;
  },
  sqrt: onNumber(Math.sqrt),
  pow: (args) => {
    const base = numArg(args[0]);
    const exp = numArg(args[1]);
    return base === null || exp === null ? null : Math.pow(base, exp);
  },
  log: (args) => {
    const val = numArg(args[0]);
    const base = args[1] !== undefined ? numArg(args[1]) : 10;
    return val === null || base === null ? null : Math.log(val) / Math.log(base);
  },
  ln: onNumber(Math.log),
  exp: onNumber(Math.exp),
  pi: () => Math.PI,
  min: (args) => minMax(args, 'min'),
  max: (args) => minMax(args, 'max'),
  random: () => Math.floor(Math.random() * 2147483648), // 0 .. 2^31-1, like Splunk
  // Precision control — not simulated. Both return the value unrounded, which
  // is the one stub shape that looks like a correct answer rather than an
  // obvious placeholder: `sigfig(3.14159)` showing `3.14159` reads as a
  // working computation. So they warn, like every other unsimulated function.
  exact: stub('exact', (args) => numArg(args[0])),
  sigfig: stub('sigfig', (args) => numArg(args[0])),
};

function mvindex(args: EvalValue[]): EvalValue {
  const mv = toMv(args[0]);
  const n = mv.length;
  // Splunk mvindex is 0-based; negative indices count from the end (-1 = last).
  const norm = (idx: number) => (idx < 0 ? n + idx : idx);
  const start = norm(toNum(args[1]));
  const end = args[2] !== undefined ? norm(toNum(args[2])) : start;
  // Out-of-range or inverted ranges yield NULL.
  if (start < 0 || start >= n || end < 0 || end >= n || end < start) return null;
  return start === end ? mv[start] ?? null : mv.slice(start, end + 1);
}

function mvzip(args: EvalValue[]): EvalValue {
  const a = toMv(args[0]);
  const b = toMv(args[1]);
  const delim = args[2] !== undefined ? toStr(args[2]) : ',';
  // Splunk mvzip behaves like a zip: it stops at the shorter field rather
  // than padding out to the longer one.
  const len = Math.min(a.length, b.length);
  const result: string[] = [];
  for (let i = 0; i < len; i++) {
    result.push(a[i]! + delim + b[i]!);
  }
  return result;
}

const MULTIVALUE_BUILTINS: Record<string, Builtin> = {
  mvcount: (args) => {
    // Splunk: a single value → 1, multiple → count, no values → NULL (not 0).
    const m = toMv(args[0]);
    return m.length === 0 ? null : m.length;
  },
  mvindex,
  mvfilter: stub('mvfilter', (args) => toMv(args[0])),
  mvappend: (args) => args.flatMap(toMv),
  mvdedup: (args) => [...new Set(toMv(args[0]))],
  mvfind: (args, ctx) => {
    const mv = toMv(args[0]);
    const regex = evalRegex(ctx, 'mvfind', toStr(args[1]));
    if (!regex) return null;
    const idx = mv.findIndex((v) => regex.test(v));
    return idx >= 0 ? idx : null;
  },
  mvsort: (args) => [...toMv(args[0])].sort(),
  mvzip,
};

const CRYPTO_BUILTINS: Record<string, Builtin> = {
  // Crypto — not simulated (crypto.subtle is async; eval is sync).
  // Return a visible placeholder so the field is set and users see the stub rather than a silent deletion.
  md5: stub('md5', () => '[md5() not simulated]'),
  sha1: stub('sha1', () => '[sha1() not simulated]'),
  sha256: stub('sha256', () => '[sha256() not simulated]'),
  sha512: stub('sha512', () => '[sha512() not simulated]'),
};

const TIME_BUILTINS: Record<string, Builtin> = {
  now: (_args, ctx) => Math.floor(ctx.now / 1000),
  time: (_args, ctx) => Math.floor(ctx.now / 1000),
  strftime: (args) => {
    // A non-numeric or absent epoch is NULL rather than 1970 — coercing to 0
    // renders a confident, wrong timestamp for a field that isn't there.
    const epoch = numArg(args[0]);
    if (epoch === null) return null;
    return formatStrftime(new Date(epoch * 1000), toStr(args[1]));
  },
  strptime: stub('strptime', (args) => strArg(args[0])),
  relative_time: stub('relative_time', (args) => toNum(args[0])),
};

function like(args: EvalValue[], ctx: EvalCtx): EvalValue {
  // NULL in, NULL out, the same as `=`: `x LIKE "%"` parses to this call, and
  // an absent field is not "", so `like(missing, "%")` is NULL, not true. NULL
  // is falsy in if()/case(), so a guard still takes its else.
  const value = strArg(args[0]);
  const likePattern = strArg(args[1]);
  if (value === null || likePattern === null) return null;
  // Escape regex metacharacters first, then translate SQL-style wildcards.
  // A run of `%` collapses to ONE `.*`: it means the same thing, and
  // `.*.*` backtracks for nothing.
  const pattern = likePattern
    .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
    .replace(/%+/g, '.*')
    .replace(/_/g, '.');
  // Splunk's like() is case-sensitive. Compiled through evalRegex so that a
  // pattern that fails is reported like replace()/match()/mvfind() are,
  // rather than failing without a word; the message quotes the regex like()
  // built, since that is what failed to compile.
  const regex = evalRegex(ctx, 'like', `^${pattern}$`);
  return regex ? regex.test(value) : false;
}

const OTHER_BUILTINS: Record<string, Builtin> = {
  null: () => null,
  // `true()`/`false()` parse as calls, not as the bare boolean literals the
  // parser already handles — and `true()` is the idiomatic way to write the
  // trailing default branch of a case(), which must fire for precisely the
  // inputs the author wrote a fallback for.
  true: () => true,
  false: () => false,
  like,
  match: (args, ctx) => {
    // NULL propagates, as for like() and the comparison operators: matching an
    // absent field against `^$` or `.*` is NULL, not true.
    const subject = strArg(args[0]);
    const regexText = strArg(args[1]);
    if (subject === null || regexText === null) return null;
    const regex = evalRegex(ctx, 'match', regexText);
    return regex ? regex.test(subject) : false;
  },
  cidrmatch: (args) => {
    // NULL propagates, as for match() and like(). That differs from false
    // only under NOT: `NOT cidrmatch(...)` on an event without the field is
    // NULL, not true.
    const range = strArg(args[0]);
    const ip = strArg(args[1]);
    return range === null || ip === null ? null : cidrMatch(range, ip);
  },
  searchmatch: stub('searchmatch', () => false),
};

/**
 * Every non-branching function by name. A Map rather than an object so a
 * function named after an Object.prototype member (`toString`) is unknown,
 * not inherited.
 */
const BUILTINS = new Map<string, Builtin>(Object.entries({
  ...STRING_BUILTINS,
  ...TYPE_BUILTINS,
  ...MATH_BUILTINS,
  ...MULTIVALUE_BUILTINS,
  ...CRYPTO_BUILTINS,
  ...TIME_BUILTINS,
  ...OTHER_BUILTINS,
}));

/** Non-branching functions: all arguments are already evaluated. */
export function evalBuiltin(fn: string, args: EvalValue[], ctx: EvalCtx): EvalValue {
  const builtin = BUILTINS.get(fn);
  if (builtin !== undefined) return builtin(args, ctx);
  // Unknown or not-yet-simulated function — surface a warning rather than
  // silently returning null (which looks like the field just didn't compute).
  ctx.onStubWarning?.(fn);
  return null;
}

// ── Helpers ─────────────────────────────────────────────

/** Dotted-quad IPv4 as four bytes, or null. Each octet 0-255, no leading sign. */
function parseIPv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const bytes = m.slice(1).map(Number);
  return bytes.every((b) => b <= 255) ? bytes : null;
}

/**
 * IPv6 as sixteen bytes, or null. Accepts `::` compression and a trailing
 * dotted-quad (`::ffff:10.0.0.1`); rejects a zone suffix (`%eth0`), which
 * names an interface rather than an address.
 */
function parseIPv6(text: string): number[] | null {
  if (!text.includes(':') || text.includes('%')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const groups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    const pieces = part.split(':');
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes('.')) {
        const v4 = parseIPv4(piece);
        if (!v4) return null;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      out.push(parseInt(piece, 16));
    }
    return out;
  };
  const head = groups(halves[0] ?? '');
  const tail = halves.length === 2 ? groups(halves[1] ?? '') : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  // `::` must stand for at least one group; without it there must be exactly eight.
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const words = [...head, ...new Array<number>(missing).fill(0), ...tail];
  return words.flatMap((w) => [w >> 8, w & 0xff]);
}

/**
 * cidrmatch(): whether `ip` falls inside `cidr`. IPv4 and IPv6 are both
 * understood, and never match each other — an IPv4-mapped IPv6 address is an
 * IPv6 address here, as it is on the wire. A bare address with no `/prefix` is
 * a single-host range. Anything malformed on either side is false, not an
 * error, which is how Splunk's own predicate behaves on a bad argument.
 */
function cidrMatch(cidr: string, ip: string): boolean {
  const slash = cidr.indexOf('/');
  const netText = slash === -1 ? cidr : cidr.slice(0, slash);
  const net = parseIPv4(netText) ?? parseIPv6(netText);
  if (!net) return false;
  const width = net.length * 8;
  let prefix = width;
  if (slash !== -1) {
    const prefixText = cidr.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixText)) return false;
    prefix = Number(prefixText);
    if (prefix > width) return false;
  }
  const addr = net.length === 4 ? parseIPv4(ip) : parseIPv6(ip);
  if (!addr) return false;
  for (let bit = 0; bit < prefix; bit += 8) {
    const remaining = Math.min(8, prefix - bit);
    const mask = (0xff << (8 - remaining)) & 0xff;
    const i = bit / 8;
    if (((net[i] ?? 0) & mask) !== ((addr[i] ?? 0) & mask)) return false;
  }
  return true;
}

/**
 * Expand a Splunk `replace()` replacement string against one match.
 *
 * `\N` is capture group N and `\0` the whole match; `\\` is a backslash; any
 * other backslash, and every `$`, is literal. A digit run longer than the
 * pattern has groups takes the longest leading run that names one, the rest
 * being literal digits (`\10` with one group is group 1, then `0`).
 */
function splunkReplacement(replacement: string): (match: RegexMatch) => string {
  return (match) => {
    let out = '';
    for (let i = 0; i < replacement.length; i++) {
      const c = replacement.charAt(i);
      if (c !== '\\' || i + 1 >= replacement.length) {
        out += c;
        continue;
      }
      const next = replacement.charAt(i + 1);
      if (next >= '0' && next <= '9') {
        let digits = '';
        while (i + 1 < replacement.length && replacement.charAt(i + 1) >= '0' && replacement.charAt(i + 1) <= '9') {
          digits += replacement.charAt(i + 1);
          i++;
        }
        let len = digits.length;
        while (len > 0 && Number(digits.slice(0, len)) >= match.length) len--;
        out += len === 0 ? `\\${digits}` : (match[Number(digits.slice(0, len))] ?? '') + digits.slice(len);
        continue;
      }
      out += next === '\\' ? '\\' : `\\${next}`;
      i++;
    }
    return out;
  };
}
