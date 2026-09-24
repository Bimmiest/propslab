// The non-branching eval functions: every builtin whose arguments are all
// evaluated before it runs, plus the helpers only they use (regex compilation
// and its failure message, CIDR matching, replace()'s backreference syntax).
// The branching functions (if/case/validate/coalesce) live in the evaluator,
// because they decide which argument nodes to evaluate at all.

import type { SplunkEvent } from '../../types';
import { safeRegex, validateRegex } from '../../../utils/splunkRegex';
import { formatStrftime } from '../../../utils/strftime';
import {
  type EvalValue,
  isNumericValue,
  minMax,
  numArg,
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
  const why = validateRegex(pattern) ?? 'rejected as ReDoS-prone';
  return `${fn}() pattern "${pattern}" could not be compiled (${why}), so it ${REGEX_FAILURE_RESULT[fn] ?? 'failed'}.`;
}

/** Compile an eval regex argument, reporting a pattern that will not compile. */
function evalRegex(ctx: EvalCtx, fn: string, pattern: string, flags?: string): RegExp | null {
  const regex = safeRegex(pattern, flags);
  if (regex === null) ctx.onRegexError?.(fn, pattern);
  return regex;
}

/** Non-branching functions: all arguments are already evaluated. */
export function evalBuiltin(fn: string, args: EvalValue[], ctx: EvalCtx): EvalValue {
  switch (fn) {
    case 'nullif': return toStr(args[0]) === toStr(args[1]) ? null : args[0] ?? null;

    // String — an absent argument propagates NULL rather than being coerced to
    // "". `len(nonexistent)` is null, not 0; a plausible-looking 0 is worse than
    // no field at all, because nothing about it says the field was missing (#211).
    // The type predicates (isnull, isnotnull, typeof, isnum, ...) deliberately
    // do not propagate: they answer a question about the value, including its
    // absence. The matching predicates (like, match, cidrmatch) do, as the
    // comparison operators do (#343).
    case 'lower': { const s = strArg(args[0]); return s === null ? null : s.toLowerCase(); }
    case 'upper': { const s = strArg(args[0]); return s === null ? null : s.toUpperCase(); }
    case 'len': { const s = strArg(args[0]); return s === null ? null : s.length; }
    case 'substr': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const start = toNum(args[1]);
      const startIdx = start > 0 ? start - 1 : s.length + start;
      const len = args[2] !== undefined ? toNum(args[2]) : undefined;
      return len !== undefined ? s.substring(startIdx, startIdx + len) : s.substring(startIdx);
    }
    case 'replace': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const regex = evalRegex(ctx, 'replace', toStr(args[1]), 'g');
      if (!regex) return s;
      return s.replace(regex, splunkReplacementToJs(toStr(args[2])));
    }
    case 'trim': { const s = strArg(args[0]); return s === null ? null : s.trim(); }
    case 'ltrim': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const chars = args[1] !== undefined ? toStr(args[1]) : ' \t\n\r';
      let i = 0;
      while (i < s.length && chars.includes(s.charAt(i))) i++;
      return s.substring(i);
    }
    case 'rtrim': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const chars = args[1] !== undefined ? toStr(args[1]) : ' \t\n\r';
      let i = s.length - 1;
      while (i >= 0 && chars.includes(s.charAt(i))) i--;
      return s.substring(0, i + 1);
    }
    case 'urldecode': {
      const s = strArg(args[0]);
      if (s === null) return null;
      try { return decodeURIComponent(s); }
      catch { return s; }
    }
    case 'split': {
      const s = strArg(args[0]);
      if (s === null) return null;
      const delim = toStr(args[1]);
      return s.split(delim);
    }
    case 'mvjoin': {
      if (args[0] === null || args[0] === undefined) return null;
      const v = toMv(args[0]);
      return v.join(toStr(args[1]));
    }

    // Type
    case 'tonumber': {
      const val = toStr(args[0]).trim();
      const base = args[1] !== undefined ? Math.floor(toNum(args[1])) : 10;
      if (base === 10) {
        if (!/^-?\d+(\.\d+)?$/.test(val)) return null;
        return parseFloat(val);
      }
      const validChars = '0123456789abcdefghijklmnopqrstuvwxyz'.slice(0, base);
      if (!new RegExp(`^[${validChars}]+$`, 'i').test(val)) return null;
      const n = parseInt(val, base);
      return isNaN(n) ? null : n;
    }
    case 'tostring': {
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
        if (format === 'duration') {
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
      }
      return toStr(args[0]);
    }
    case 'typeof': {
      // Splunk returns "Number" | "String" | "Bool" | "Invalid"
      // (a null / nonexistent field is "Invalid", not a separate null type).
      if (args[0] === null || args[0] === undefined) return 'Invalid';
      if (typeof args[0] === 'number') return 'Number';
      if (typeof args[0] === 'boolean') return 'Bool';
      if (Array.isArray(args[0])) return 'MultiValue';
      return 'String';
    }
    case 'isnull': return args[0] === null || args[0] === undefined;
    case 'isnotnull': return args[0] !== null && args[0] !== undefined;
    case 'isint': return isNumericValue(args[0]) && Number.isInteger(Number(args[0]));
    case 'isnum': return isNumericValue(args[0]);
    // Informational functions mirror `typeof`'s type model: they report the
    // value's actual type rather than what it could be coerced to.
    case 'isbool': return typeof args[0] === 'boolean';
    case 'isstr': return typeof args[0] === 'string';

    // Math — a non-numeric (or NULL) argument yields NULL rather than 0.
    case 'abs': { const n = numArg(args[0]); return n === null ? null : Math.abs(n); }
    case 'ceiling': case 'ceil': { const n = numArg(args[0]); return n === null ? null : Math.ceil(n); }
    case 'floor': { const n = numArg(args[0]); return n === null ? null : Math.floor(n); }
    case 'round': {
      const val = numArg(args[0]);
      if (val === null) return null;
      const decimals = args[1] !== undefined ? numArg(args[1]) ?? 0 : 0;
      const factor = Math.pow(10, decimals);
      // Splunk rounds halves away from zero; JS Math.round rounds toward +∞.
      const scaled = val * factor;
      return (Math.sign(scaled) * Math.round(Math.abs(scaled))) / factor;
    }
    case 'sqrt': { const n = numArg(args[0]); return n === null ? null : Math.sqrt(n); }
    case 'pow': {
      const base = numArg(args[0]);
      const exp = numArg(args[1]);
      return base === null || exp === null ? null : Math.pow(base, exp);
    }
    case 'log': {
      const val = numArg(args[0]);
      const base = args[1] !== undefined ? numArg(args[1]) : 10;
      return val === null || base === null ? null : Math.log(val) / Math.log(base);
    }
    case 'ln': { const n = numArg(args[0]); return n === null ? null : Math.log(n); }
    case 'exp': { const n = numArg(args[0]); return n === null ? null : Math.exp(n); }
    case 'pi': return Math.PI;
    case 'min': return minMax(args, 'min');
    case 'max': return minMax(args, 'max');
    case 'random': return Math.floor(Math.random() * 2147483648); // 0 .. 2^31-1, like Splunk

    // Precision control — not simulated. Both return the value unrounded, which
    // is the one stub shape that looks like a correct answer rather than an
    // obvious placeholder: `sigfig(3.14159)` showing `3.14159` reads as a
    // working computation. So they warn, like every other unsimulated function.
    case 'exact':
      ctx.onStubWarning?.('exact');
      return numArg(args[0]);
    case 'sigfig':
      ctx.onStubWarning?.('sigfig');
      return numArg(args[0]);

    // Multivalue
    case 'mvcount': {
      // Splunk: a single value → 1, multiple → count, no values → NULL (not 0).
      const m = toMv(args[0]);
      return m.length === 0 ? null : m.length;
    }
    case 'mvindex': {
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
    case 'mvfilter':
      ctx.onStubWarning?.('mvfilter');
      return toMv(args[0]);
    case 'mvappend': return args.flatMap(toMv);
    case 'mvdedup': return [...new Set(toMv(args[0]))];
    case 'mvfind': {
      const mv = toMv(args[0]);
      const regex = evalRegex(ctx, 'mvfind', toStr(args[1]));
      if (!regex) return null;
      const idx = mv.findIndex((v) => regex.test(v));
      return idx >= 0 ? idx : null;
    }
    case 'mvsort': return [...toMv(args[0])].sort();
    case 'mvzip': {
      const a = toMv(args[0]);
      const b = toMv(args[1]);
      const delim = args[2] !== undefined ? toStr(args[2]) : ',';
      // Splunk mvzip behaves like a zip: it stops at the shorter field rather
      // than padding out to the longer one.
      const len = Math.min(a.length, b.length);
      const result: string[] = [];
      for (let i = 0; i < len; i++) {
        result.push(a[i] + delim + b[i]);
      }
      return result;
    }

    // Crypto — not simulated (crypto.subtle is async; eval is sync).
    // Return a visible placeholder so the field is set and users see the stub rather than a silent deletion.
    case 'md5':   ctx.onStubWarning?.('md5');    return '[md5() not simulated]';
    case 'sha1':  ctx.onStubWarning?.('sha1');   return '[sha1() not simulated]';
    case 'sha256': ctx.onStubWarning?.('sha256'); return '[sha256() not simulated]';
    case 'sha512': ctx.onStubWarning?.('sha512'); return '[sha512() not simulated]';

    // Time
    case 'now': return Math.floor(ctx.now / 1000);
    case 'time': return Math.floor(ctx.now / 1000);
    case 'strftime': {
      // A non-numeric or absent epoch is NULL rather than 1970 — coercing to 0
      // renders a confident, wrong timestamp for a field that isn't there.
      const epoch = numArg(args[0]);
      if (epoch === null) return null;
      const format = toStr(args[1]);
      const date = new Date(epoch * 1000);
      return formatStrftime(date, format);
    }
    case 'strptime':
      ctx.onStubWarning?.('strptime');
      return strArg(args[0]);
    case 'relative_time':
      ctx.onStubWarning?.('relative_time');
      return toNum(args[0]);

    // Other
    case 'null': return null;
    // `true()`/`false()` parse as calls, not as the bare boolean literals the
    // parser already handles — and `true()` is the idiomatic way to write the
    // trailing default branch of a case(). Without these it evaluated to null,
    // the branch never fired, and case() fell off the end returning nothing for
    // precisely the inputs the author wrote a fallback for (#165).
    case 'true': return true;
    case 'false': return false;
    case 'like': {
      // NULL in, NULL out, the same as `=` (#343): `x LIKE "%"` parses to this
      // call, and an absent field is not "" — `like(missing, "%")` used to be
      // true. NULL is falsy in if()/case(), so a guard still takes its else.
      const value = strArg(args[0]);
      const likePattern = strArg(args[1]);
      if (value === null || likePattern === null) return null;
      // Escape regex metacharacters first, then translate SQL-style wildcards.
      // A run of `%` collapses to ONE `.*` first. It means the same thing --
      // any number of any-string wildcards in a row match any string -- but
      // `.*.*` is exactly the adjacent-quantifier shape the ReDoS guard refuses,
      // so `like(x, "a%%b")` compiled to nothing and quietly answered false for
      // every event (#303). After the collapse the regex holds only literals,
      // `.` and non-adjacent `.*`, which the guard accepts.
      const pattern = likePattern
        .replace(/[.+*?^${}()|[\]\\]/g, '\\$&')
        .replace(/%+/g, '.*')
        .replace(/_/g, '.');
      // Splunk's like() is case-sensitive. Compiled through evalRegex so that a
      // pattern the guard still refuses is reported like replace()/match()/
      // mvfind() are, rather than failing without a word; the message quotes
      // the regex like() built, since that is what failed to compile.
      const regex = evalRegex(ctx, 'like', `^${pattern}$`);
      return regex ? regex.test(value) : false;
    }
    case 'match': {
      // NULL propagates, as for like() and the comparison operators (#343):
      // matching an absent field against `^$` or `.*` used to answer true.
      const subject = strArg(args[0]);
      const regexText = strArg(args[1]);
      if (subject === null || regexText === null) return null;
      const regex = evalRegex(ctx, 'match', regexText);
      return regex ? regex.test(subject) : false;
    }
    case 'cidrmatch': {
      // NULL propagates, as for match() and like() (#343). It used to answer
      // false for an absent address, which only differs under NOT: `NOT
      // cidrmatch(...)` on an event without the field was true.
      const range = strArg(args[0]);
      const ip = strArg(args[1]);
      return range === null || ip === null ? null : cidrMatch(range, ip);
    }
    case 'searchmatch':
      ctx.onStubWarning?.('searchmatch');
      return false;

    default:
      // Unknown or not-yet-simulated function — surface a warning rather than
      // silently returning null (which looks like the field just didn't compute).
      ctx.onStubWarning?.(fn);
      return null;
  }
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
 * Translate a Splunk `replace()` replacement string into the JS equivalent.
 *
 * Splunk uses PCRE-style `\1` backreferences, while `String.prototype.replace`
 * uses `$1` and additionally treats `$&`, `` $` ``, `$'` and `$$` as
 * substitutions Splunk has no notion of. So `\N` becomes `$N`, `\0` becomes the
 * whole match, and any literal `$` is escaped to survive verbatim.
 */
function splunkReplacementToJs(replacement: string): string {
  let out = '';
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement.charAt(i);
    if (c === '$') {
      out += '$$'; // a literal dollar, not a JS substitution
      continue;
    }
    if (c === '\\' && i + 1 < replacement.length) {
      const next = replacement.charAt(i + 1);
      if (next >= '0' && next <= '9') {
        let digits = '';
        while (i + 1 < replacement.length && replacement.charAt(i + 1) >= '0' && replacement.charAt(i + 1) <= '9') {
          digits += replacement.charAt(i + 1);
          i++;
        }
        // PCRE `\0` is the whole match; JS spells that `$&`.
        out += Number(digits) === 0 ? '$&' : `$${digits}`;
        continue;
      }
      if (next === '\\') {
        out += '\\';
        i++;
        continue;
      }
      out += `\\${next}`;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
