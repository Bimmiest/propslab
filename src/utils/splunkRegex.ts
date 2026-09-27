/**
 * Utilities for working with Splunk regex patterns.
 */

/** Escape a literal string for use inside a RegExp. */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert Splunk Python-style (?P<name>...) named groups to JS (?<name>...) syntax. */
export function convertSplunkToJsRegex(pattern: string): string {
  return pattern.replace(/\(\?P<(\w+)>/g, '(?<$1>');
}

/** Inline flag letters JS can represent (i = ignore-case, m = multiline, s = dotall). */
const JS_REPRESENTABLE_INLINE_FLAGS = 'ims';
/** All PCRE inline mode-modifier letters we recognise as a flag group (others are dropped). */
const PCRE_INLINE_FLAG_LETTERS = 'imsxuUJADX';
/**
 * A whole inline flag group such as `(?i)`, `(?ims)`, `(?-i)` or `(?i-s)`,
 * anchored at the scan position; with `:` in place of `)` it opens a scoped
 * group, `(?i:…)`.
 */
const INLINE_FLAG_GROUP = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?\)/;
const SCOPED_FLAG_GROUP = /^\(\?([a-zA-Z]*)(?:-([a-zA-Z]*))?:/;
/** A bounded quantifier (`{2}`, `{2,}`, `{2,5}`), anchored at the scan position. */
const BOUNDED_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/** PCRE `\h` (horizontal whitespace), as JS class members. */
const PCRE_HSPACE = '\\t \\xa0\\u1680\\u180e\\u2000-\\u200a\\u202f\\u205f\\u3000';
/** PCRE `\v` (vertical whitespace), as JS class members. JS `\v` is only VT. */
const PCRE_VSPACE = '\\n\\x0b\\f\\r\\x85\\u2028\\u2029';

/**
 * POSIX bracket classes, as JS class members. ASCII only, which is what PCRE
 * gives them without the UCP option.
 */
const POSIX_CLASSES: Record<string, string> = {
  alpha: 'a-zA-Z',
  digit: '0-9',
  alnum: 'a-zA-Z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: '\\t\\n\\x0b\\f\\r ',
  blank: ' \\t',
  xdigit: '0-9A-Fa-f',
  punct: '!-\\/:-@\\[-`{-~',
  word: '\\w',
  cntrl: '\\x00-\\x1f\\x7f',
  print: ' -~',
  graph: '!-~',
  ascii: '\\x00-\\x7f',
};

/** Escapes that mean the same in PCRE and JS, inside a class or out. */
const SHARED_ESCAPE_LETTERS = 'dDwWsStnrf';

/**
 * Whether this runtime accepts scoped modifier groups, `(?i:…)` (ES2025).
 *
 * Probed rather than assumed from the build target: the `es2022` target says
 * nothing about the RegExp parser, which ships with the JS engine. V8 enables
 * them by default from Node 24 / Chrome 125 and Firefox from 132, but Node 22
 * has them only behind `--js-regexp-modifiers`, and an older Safari may lack
 * them. Emitting `(?i:…)` where the parser rejects it would turn a pattern that
 * worked approximately into one `safeRegex` refuses outright, so the translator
 * falls back to the old whole-pattern hoist there — and says so in `warnings`.
 */
export const SUPPORTS_SCOPED_MODIFIERS: boolean = (() => {
  try {
    new RegExp('(?i:a)');
    return true;
  } catch {
    return false;
  }
})();

export interface PcreTranslation {
  source: string;
  flags: string;
  /**
   * Places where the JS form only approximates the PCRE meaning. Not errors —
   * the pattern still compiles — but its matches may differ from Splunk's.
   */
  warnings: string[];
  /**
   * Set when the pattern uses PCRE syntax the translator cannot express and
   * that JS would otherwise accept with a different meaning (`\G`, `\p{L}`,
   * an unknown POSIX class). `safeRegex` refuses such a pattern and
   * `validateRegex` reports this reason, rather than letting it match
   * something Splunk would not.
   */
  error?: string;
}

export interface PcreTranslationOptions {
  /**
   * Rewrite a mid-pattern `(?i)` into a scoped `(?i:…)` group. Defaults to
   * {@link SUPPORTS_SCOPED_MODIFIERS}; exposed so both paths can be tested on
   * any runtime.
   */
  scopedModifiers?: boolean;
}

/** PCRE extended-mode whitespace (outside a character class). */
function isExtendedWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
}

/** A code point as a JS escape; an astral one as a grouped surrogate pair. */
function codePointEscape(cp: number): string {
  const unit = (u: number) => `\\u${u.toString(16).padStart(4, '0')}`;
  if (cp <= 0xffff) return unit(cp);
  const off = cp - 0x10000;
  return `(?:${unit(0xd800 + (off >> 10))}${unit(0xdc00 + (off & 0x3ff))})`;
}

/** Escape a literal character for use as a class member. */
function escapeClassMember(c: string): string {
  return /[\\\]^[-]/.test(c) ? `\\${c}` : c;
}

type EscapeResult = { text: string; length: number } | { error: string };

/**
 * Translate a character escape both contexts share — one that names a single
 * character, so it is valid inside a class and out — or return null when the
 * escape at `i` is not one.
 */
function translateCharEscape(pattern: string, i: number, inClass: boolean): EscapeResult | null {
  const next = pattern.charAt(i + 1);
  if (!next) return null;
  switch (next) {
    case 'e':
      return { text: '\\x1b', length: 2 };
    case 'a':
      return { text: '\\x07', length: 2 };
    case 'x': {
      const braced = /^\{([0-9a-fA-F]+)\}/.exec(pattern.slice(i + 2));
      if (braced) {
        const cp = parseInt(braced[1]!, 16);
        // Without the `u` flag an astral character is two code units, which
        // a class cannot hold as one member.
        if (cp > 0x10ffff || (inClass && cp > 0xffff)) {
          return { error: `\\x{${braced[1]!}} is not supported in the preview.` };
        }
        return { text: codePointEscape(cp), length: 2 + braced[0].length };
      }
      // PCRE takes one or two hex digits; JS needs exactly two.
      const hex = /^[0-9a-fA-F]{1,2}/.exec(pattern.slice(i + 2));
      if (!hex) return { error: '\\x without hex digits is not supported in the preview.' };
      return { text: `\\x${hex[0].padStart(2, '0')}`, length: 2 + hex[0].length };
    }
    case 'c':
      // JS only takes a letter after \c; PCRE any printable ASCII.
      if (/[A-Za-z]/.test(pattern.charAt(i + 2))) return { text: pattern.slice(i, i + 3), length: 3 };
      return { error: `\\c${pattern.charAt(i + 2)} is not supported in the preview.` };
    default:
      if (SHARED_ESCAPE_LETTERS.includes(next) || /[0-9]/.test(next)) return { text: pattern.slice(i, i + 2), length: 2 };
      return null;
  }
}

/**
 * Translate the subset of PCRE (Splunk regex) syntax that the JS engine does not
 * accept, or accepts with a different meaning, into an equivalent JS form,
 * returning the rewritten source plus any flags that must be applied. Without
 * this, common Splunk patterns throw at compile time and `safeRegex` returns
 * null, silently producing no extraction — or worse, compile and match
 * something else (`\A` is a literal `A` to JS).
 *
 * Handled:
 *  - `(?P<name>…)` / `(?'name'…)` / `(?P=name)` / `\k'name'` / `\g{N}` → JS
 *    named groups and backreferences
 *  - leading inline flag groups `(?i)`, `(?ims)`, `(?-i)` → merged into (or
 *    removed from) the flags, which is exact: a leading group governs the whole
 *    pattern
 *  - a mid-pattern flag group `a(?i)b` → a scoped group `a(?i:b)` running to the
 *    end of the enclosing group. PCRE carries the option into that group's later
 *    alternatives too, but one scoped group spanning a `|` would capture the
 *    alternation (`a(?i)b|c` would become "a, then b or c"), so each alternative
 *    is wrapped separately: `a(?i:b)|(?i:c)`. Negative letters (`(?-i)`,
 *    `(?i-s)`) become `(?-i:…)` the same way. Where the runtime lacks scoped
 *    groups a positive flag is hoisted to the whole pattern, and a negative one
 *    dropped, with a warning — and a written `(?i:…)` group gets the same
 *    fallback rather than being refused by the compiler.
 *  - a leading `(?x)` → extended mode applied here, since JS has no `x` flag:
 *    unescaped whitespace and `#…` comments outside character classes are removed
 *  - `(?#…)` comments → removed
 *  - atomic groups `(?>…)`        → non-capturing `(?:…)` (loses atomicity only)
 *  - possessive quantifiers `a++`, `\d*+`, `x?+`, `{2,3}+` → greedy equivalents
 *  - anchors `\A`, `\z`, `\Z` → `^` (a lookbehind if `m` may be on), `(?![\s\S])`,
 *    `(?=\n?(?![\s\S]))`
 *  - `\h`, `\H`, `\v`, `\V`, `\R`, `\N`, `\e`, `\a`, `\x{…}`, `\xh` and `\Q…\E`
 *    literals, inside a class or out
 *  - POSIX classes inside brackets, `[[:digit:]]`, `[[:^alpha:]]`
 *
 * The rewrite is one left-to-right scan that tracks escapes and character
 * classes, because every construct above is syntax only OUTSIDE a class: `[*+]`
 * is "a star or a plus", not a possessive star, and `\\++` is an escaped
 * backslash followed by a possessive plus. Regex-replace passes over the raw
 * source could not tell those apart.
 *
 * Refused, with `error` set: any other letter escape (`\G`, `\K`, `\X`,
 * `\p{…}`, …), unknown POSIX class names and collating elements, and relative
 * or subroutine `\g` forms. Constructs JS itself rejects — conditionals
 * `(?(…)…)`, recursion — are left for the compiler to report.
 */
export function translatePcreToJs(
  pattern: string,
  flags = '',
  options: PcreTranslationOptions = {},
): PcreTranslation {
  const scopedModifiers = options.scopedModifiers ?? SUPPORTS_SCOPED_MODIFIERS;
  const warnings: string[] = [];
  let error: string | undefined;
  const refuse = (message: string) => {
    error ??= message;
  };
  let extraFlags = '';
  /** Flags a leading `(?-x)` switched off for the whole pattern. */
  const removedFlags = new Set<string>();
  let extended = false;

  const addFlags = (letters: string) => {
    for (const c of letters) {
      if (!JS_REPRESENTABLE_INLINE_FLAGS.includes(c)) continue;
      removedFlags.delete(c);
      if (!extraFlags.includes(c)) extraFlags += c;
    }
  };
  const flagIsOn = (c: string) => (flags.includes(c) || extraFlags.includes(c)) && !removedFlags.has(c);
  // Anything else (`(?Q)`) is not a flag group — left for the compiler to reject.
  const isFlagGroup = (on: string, off: string | undefined) =>
    (on !== '' || !!off) && [...on + (off ?? '')].every((c) => PCRE_INLINE_FLAG_LETTERS.includes(c));
  /** The JS modifier spelling (`i`, `-i`, `i-s`) of a PCRE flag group, `''` if none applies. */
  const jsModifiers = (on: string, off: string) => {
    const js = (letters: string) => [...new Set(letters)].filter((l) => JS_REPRESENTABLE_INLINE_FLAGS.includes(l));
    const offJs = js(off);
    const onJs = js(on).filter((l) => !offJs.includes(l)); // PCRE applies `-` last
    return onJs.join('') + (offJs.length ? `-${offJs.join('')}` : '');
  };
  /**
   * A flag group JS cannot scope: hoist its positive letters to the whole
   * pattern, and say which of its negative letters stay in force.
   */
  const unscopedFlags = (spelling: string, on: string, off: string) => {
    const onJs = [...new Set(on)].filter((l) => JS_REPRESENTABLE_INLINE_FLAGS.includes(l) && !off.includes(l));
    if (onJs.length) {
      addFlags(onJs.join(''));
      warnings.push(
        `Mid-pattern (?${onJs.join('')}) was applied to the whole pattern: this browser does not support scoped modifier groups, so text before it is matched with the same flags.`,
      );
    }
    const stillOn = [...new Set(off)].filter((l) => JS_REPRESENTABLE_INLINE_FLAGS.includes(l) && flagIsOn(l));
    if (stillOn.length) {
      warnings.push(
        `${spelling} could not switch off ${stillOn.join('')}: this browser does not support scoped modifier groups, so text after it is matched with the flag still on.`,
      );
    }
  };
  const warnMidPatternX = (on: string, off: string) => {
    if (on.includes('x') || off.includes('x')) {
      warnings.push(
        '(?x) is only applied at the start of a pattern; mid-pattern it is ignored, so whitespace after it is read as it would be without it.',
      );
    }
  };

  // `\A` is the absolute start. JS `^` is that only while `m` is off, so where
  // a flag group may turn `m` on, a lookbehind stands in for it.
  const mayBeMultiline = flags.includes('m') || /\(\?[a-zA-Z]*m/.test(pattern);
  const absoluteStart = mayBeMultiline ? '(?<![\\s\\S])' : '^';

  // Index just past any extended-mode whitespace and `#…` comments at `from`.
  const skipIgnorable = (from: number): number => {
    let i = from;
    while (i < pattern.length) {
      const c = pattern.charAt(i);
      if (isExtendedWhitespace(c)) {
        i++;
      } else if (c === '#') {
        const nl = pattern.indexOf('\n', i);
        i = nl < 0 ? pattern.length : nl + 1;
      } else {
        break;
      }
    }
    return i;
  };

  /** The text between `\Q` at `from` and the next `\E` (or the end), and the index past it. */
  const quoted = (from: number): { text: string; next: number } => {
    const end = pattern.indexOf('\\E', from + 2);
    return end < 0
      ? { text: pattern.slice(from + 2), next: pattern.length }
      : { text: pattern.slice(from + 2, end), next: end + 2 };
  };

  /**
   * Translate the character class opening at `start`. Returns the JS text and
   * the index past the class, or null when it is unterminated.
   *
   * Members are copied verbatim unless PCRE reads them differently. A negated
   * member set (`\H`, `[:^alpha:]`) cannot sit inside a JS class without the
   * `v` flag, so a class holding one becomes an equivalent group:
   * `[a\H]` → `(?:[a]|[^\t …])`, and `[^a\H]` → `(?![a])[\t …]`.
   */
  const translateClass = (start: number): { text: string; next: number } | null => {
    let j = start + 1;
    const negated = pattern[j] === '^';
    if (negated) j++;
    let members = '';
    const complements: string[] = [];
    // A `]` straight after `[` or `[^` is a literal member in PCRE (`[]a]` is
    // "`]` or `a`") but ends the class in JS — an empty class `[]`, or "any
    // character" `[^]` — so it is escaped (#341).
    if (pattern[j] === ']') {
      members += '\\]';
      j++;
    }
    while (j < pattern.length) {
      const c = pattern.charAt(j);
      if (c === ']') break;
      if (c === '[') {
        const posix = /^\[:(\^?)([a-z]+):\]/.exec(pattern.slice(j));
        if (posix) {
          const set = POSIX_CLASSES[posix[2]!];
          if (set === undefined) refuse(`Unknown POSIX class [:${posix[2]!}:].`);
          else if (posix[1]) complements.push(set);
          else members += set;
          j += posix[0].length;
          continue;
        }
        if (/^\[([.=])[^\]]*\1\]/.test(pattern.slice(j))) {
          refuse('POSIX collating elements ([.x.], [=x=]) are not supported.');
        }
        members += c;
        j++;
        continue;
      }
      if (c !== '\\') {
        members += c;
        j++;
        continue;
      }
      if (j + 1 >= pattern.length) return null;
      const next = pattern.charAt(j + 1);
      if (next === 'Q') {
        const q = quoted(j);
        members += [...q.text].map(escapeClassMember).join('');
        j = q.next;
        continue;
      }
      if (next === 'E') {
        j += 2; // a stray \E is ignored
        continue;
      }
      if (next === 'h' || next === 'v') {
        members += next === 'h' ? PCRE_HSPACE : PCRE_VSPACE;
        j += 2;
        continue;
      }
      if (next === 'H' || next === 'V') {
        complements.push(next === 'H' ? PCRE_HSPACE : PCRE_VSPACE);
        j += 2;
        continue;
      }
      if (next === 'b') {
        members += '\\b'; // backspace, in both
        j += 2;
        continue;
      }
      const esc = translateCharEscape(pattern, j, true);
      if (esc && 'error' in esc) refuse(esc.error);
      if (esc && 'text' in esc) {
        members += esc.text;
        j += esc.length;
        continue;
      }
      if (/[A-Za-z]/.test(next)) refuse(`\\${next} inside a character class is not supported in the preview.`);
      members += pattern.slice(j, j + 2);
      j += 2;
    }
    if (j >= pattern.length) return null;

    if (complements.length === 0) return { text: `[${negated ? '^' : ''}${members}]`, next: j + 1 };
    if (!negated) {
      const alts = [...(members ? [`[${members}]`] : []), ...complements.map((set) => `[^${set}]`)];
      return { text: `(?:${alts.join('|')})`, next: j + 1 };
    }
    // Neither a member nor outside any complement: inside every complemented set.
    const last = complements.pop()!;
    const text = (members ? `(?![${members}])` : '') + complements.map((set) => `(?=[${set}])`).join('') + `[${last}]`;
    return { text: `(?:${text})`, next: j + 1 };
  };

  /** Translate the escape at `i`, outside a class. */
  const translateEscape = (i: number): EscapeResult => {
    const next = pattern.charAt(i + 1);
    const rest = pattern.slice(i + 2);
    switch (next) {
      case 'A':
        return { text: absoluteStart, length: 2 };
      case 'z':
        return { text: '(?![\\s\\S])', length: 2 };
      case 'Z':
        return { text: '(?=\\n?(?![\\s\\S]))', length: 2 };
      case 'h':
        return { text: `[${PCRE_HSPACE}]`, length: 2 };
      case 'H':
        return { text: `[^${PCRE_HSPACE}]`, length: 2 };
      case 'v':
        return { text: `[${PCRE_VSPACE}]`, length: 2 };
      case 'V':
        return { text: `[^${PCRE_VSPACE}]`, length: 2 };
      case 'R':
        return { text: `(?:\\r\\n|[${PCRE_VSPACE}])`, length: 2 };
      case 'N':
        return /^\{/.test(rest) ? { error: '\\N{…} is not supported.' } : { text: '[^\\n]', length: 2 };
      case 'b':
      case 'B':
        return { text: pattern.slice(i, i + 2), length: 2 };
      case 'k': {
        const name = /^(?:<(\w+)>|'(\w+)'|\{(\w+)\})/.exec(rest);
        if (!name) return { error: '\\k must be followed by a group name.' };
        return { text: `\\k<${name[1] ?? name[2] ?? name[3]!}>`, length: 2 + name[0].length };
      }
      case 'g': {
        const ref = /^(?:(\d+)|\{(\d+)\}|\{([A-Za-z_]\w*)\})/.exec(rest);
        if (!ref) return { error: 'Relative (\\g{-1}) and subroutine (\\g<…>) references are not supported.' };
        const number = ref[1] ?? ref[2];
        return { text: number !== undefined ? `\\${number}` : `\\k<${ref[3]!}>`, length: 2 + ref[0].length };
      }
      default: {
        const esc = translateCharEscape(pattern, i, false);
        if (esc) return esc;
        // Every other letter escape is either PCRE-only (`\G`, `\K`, `\X`,
        // `\p{…}`) or an error in PCRE, while JS would read it as the letter.
        if (/[A-Za-z]/.test(next)) return { error: `\\${next} is not supported in the preview.` };
        // An escaped non-letter is that character in both — and a trailing
        // lone `\` is left for the compiler to reject.
        return { text: pattern.slice(i, i + 2), length: Math.max(1, Math.min(2, pattern.length - i)) };
      }
    }
  };

  // Leading flag groups govern the whole pattern, which a JS flag expresses
  // exactly. Once `(?x)` is seen, whitespace between later leading groups is
  // already insignificant, so `(?x) (?i)` is still two leading groups.
  let i = 0;
  for (;;) {
    if (extended) i = skipIgnorable(i);
    const m = INLINE_FLAG_GROUP.exec(pattern.slice(i));
    if (!m || !isFlagGroup(m[1]!, m[2])) break;
    const off = m[2] ?? '';
    addFlags([...m[1]!].filter((l) => !off.includes(l)).join(''));
    for (const l of off) if (JS_REPRESENTABLE_INLINE_FLAGS.includes(l)) removedFlags.add(l);
    if (m[1]!.includes('x')) extended = true;
    if (off.includes('x')) extended = false;
    i += m[0].length;
  }

  // One frame per open group. `scoped` lists the `(?flags:` wrappers that
  // mid-pattern flag groups opened in it, so a `|` or the group's closing `)`
  // can close them (and, after a `|`, reopen them for the next alternative).
  const frames: { scoped: string[] }[] = [{ scoped: [] }];
  const current = () => frames[frames.length - 1]!;
  let out = '';
  // True right after a quantifier, where a `+` makes it possessive and a `?` lazy.
  let afterQuantifier = false;

  while (i < pattern.length) {
    const c = pattern.charAt(i);
    const wasAfterQuantifier: boolean = afterQuantifier;
    afterQuantifier = false;

    if (c === '\\') {
      if (pattern.charAt(i + 1) === 'Q') {
        // Everything up to `\E` is literal, extended-mode whitespace included.
        const q = quoted(i);
        out += escapeRegex(q.text);
        i = q.next;
        continue;
      }
      if (pattern.charAt(i + 1) === 'E') {
        i += 2; // a stray \E is ignored
        continue;
      }
      const esc = translateEscape(i);
      if ('error' in esc) {
        refuse(esc.error);
        out += pattern.slice(i, i + 2);
        i += 2;
      } else {
        out += esc.text;
        i += esc.length;
      }
      continue;
    }

    if (c === '[') {
      // PCRE's `x` does not touch whitespace inside a class.
      const cls = translateClass(i);
      if (!cls) {
        out += pattern.slice(i); // unterminated — the compiler reports it
        break;
      }
      out += cls.text;
      i = cls.next;
      continue;
    }

    if (extended && (isExtendedWhitespace(c) || c === '#')) {
      i = skipIgnorable(i);
      afterQuantifier = wasAfterQuantifier; // ignorable text does not end a quantifier
      continue;
    }

    if (c === '*' || c === '+' || c === '?') {
      if (wasAfterQuantifier && c === '+') {
        i++; // possessive → greedy
        continue;
      }
      out += c;
      i++;
      // A `?` straight after a quantifier is its lazy marker, which ends it.
      afterQuantifier = !wasAfterQuantifier;
      continue;
    }

    if (c === '{') {
      const bound = BOUNDED_QUANTIFIER.exec(pattern.slice(i));
      if (bound) {
        out += bound[0];
        i += bound[0].length;
        afterQuantifier = true;
      } else {
        out += c; // a literal brace
        i++;
      }
      continue;
    }

    if (c === '(') {
      const rest = pattern.slice(i);
      const named = /^\(\?(?:P<(\w+)>|'(\w+)')/.exec(rest);
      if (named) {
        out += `(?<${named[1] ?? named[2]!}>`;
        i += named[0].length;
        frames.push({ scoped: [] });
        continue;
      }
      const backref = /^\(\?P=(\w+)\)/.exec(rest);
      if (backref) {
        out += `\\k<${backref[1]!}>`;
        i += backref[0].length;
        continue;
      }
      if (rest.startsWith('(?#')) {
        const end = pattern.indexOf(')', i);
        i = end < 0 ? pattern.length : end + 1;
        afterQuantifier = wasAfterQuantifier;
        continue;
      }
      if (rest.startsWith('(?>')) {
        out += '(?:'; // JS has no atomic groups
        i += 3;
        frames.push({ scoped: [] });
        continue;
      }
      const flagGroup = INLINE_FLAG_GROUP.exec(rest);
      if (flagGroup && isFlagGroup(flagGroup[1]!, flagGroup[2])) {
        const [spelling, on = '', off = ''] = flagGroup;
        i += spelling.length;
        warnMidPatternX(on, off);
        const js = jsModifiers(on, off);
        if (!js) continue;
        if (scopedModifiers) {
          out += `(?${js}:`;
          current().scoped.push(js);
        } else {
          unscopedFlags(spelling, on, off);
        }
        continue;
      }
      const scopedGroup = SCOPED_FLAG_GROUP.exec(rest);
      if (scopedGroup && isFlagGroup(scopedGroup[1]!, scopedGroup[2])) {
        const [spelling, on = '', off = ''] = scopedGroup;
        i += spelling.length;
        warnMidPatternX(on, off);
        const js = jsModifiers(on, off);
        if (js && scopedModifiers) {
          out += `(?${js}:`;
        } else {
          out += '(?:';
          if (js) unscopedFlags(`${spelling}…)`, on, off);
        }
        frames.push({ scoped: [] });
        continue;
      }
      // Any other group: copy the `(` and its `?` introducer, so the `?` is not
      // read as a quantifier, and let the scan continue into the body.
      const open = rest.startsWith('(?') ? '(?' : '(';
      out += open;
      i += open.length;
      frames.push({ scoped: [] });
      continue;
    }

    if (c === ')') {
      out += ')'.repeat(current().scoped.length) + ')';
      if (frames.length > 1) frames.pop();
      else current().scoped = []; // unbalanced — the compiler reports it
      i++;
      continue;
    }

    if (c === '|') {
      const { scoped } = current();
      out += ')'.repeat(scoped.length) + '|' + scoped.map((f) => `(?${f}:`).join('');
      i++;
      continue;
    }

    out += c;
    i++;
  }

  // Close wrappers still open at the end of the pattern, innermost group first.
  for (let f = frames.length - 1; f >= 0; f--) out += ')'.repeat(frames[f]!.scoped.length);

  let mergedFlags = [...flags].filter((c) => !removedFlags.has(c)).join('');
  for (const c of extraFlags) {
    if (!mergedFlags.includes(c)) mergedFlags += c;
  }

  return { source: out, flags: mergedFlags, warnings, ...(error === undefined ? {} : { error }) };
}

/**
 * Best-effort detection of patterns that exhibit catastrophic backtracking on
 * long input. These are rejected before compiling so they never execute. It is
 * the first line of defence, not the only one: the pipeline and the live regex
 * testers (RegexTab / ExtractNameDialog, via `regexMatchWorker.ts`) run user
 * patterns in Web Workers that a watchdog terminates. It still matters there —
 * a refused pattern fails fast with a reason instead of stalling the preview
 * until the watchdog fires — and it is all that stands between a pattern and a
 * main-thread caller such as the editor's hover providers.
 *
 * This is a heuristic, not a complete ReDoS analysis. It catches:
 *  1. A repeated group whose body is *ambiguous* — the body contains an
 *     unbounded `*`/`+` that nothing inside the body reliably terminates, so a
 *     given input can be split across iterations in exponentially many ways.
 *     Examples: `(a+)+`, `(\w+)*`, `(.+)+`, `(?:\d*)*`, `(.*,){20}`.
 *  2. Two adjacent unbounded quantifiers on the SAME atom. Examples: `a*a*`,
 *     `\d+\d+` — and by extension long runs like `a*a*a*a*c`.
 *
 * Rule 1 checks ambiguity rather than the mere *presence* of an inner
 * quantifier, because "repeated group containing a quantifier" also describes a
 * large family of safe, idiomatic Splunk patterns — `(\d+\.){3}\d+` (IPv4),
 * `^(?:[^ ]* ){2}` (the docs' own TIME_PREFIX recipe), `(?:[^,]*,)+` (CSV).
 * Rejecting those silently disabled valid config, which is worse than the hang
 * the heuristic exists to prevent. A repetition is only ambiguous when the
 * repeated atom can also match whatever follows it inside the body: `\d+` before
 * a literal `\.` is unambiguous (a digit is never a dot), while `.*` before `,`
 * is ambiguous (a dot matches a comma).
 *
 * It does NOT catch alternation-overlap forms such as `(a|aa)+`: flagging those
 * without also rejecting benign alternations like `(foo|bar)+` needs a real
 * overlap analysis. Such patterns remain covered by the worker watchdogs, but a
 * main-thread caller must bound its input rather than rely on this check alone.
 */
const REDOS_NESTED_GROUP = /\((?:[^()\\]|\\.)*[*+][^()]*\)(?:[*+]|\{\d+,?\d*\})/;
// The atom must start on an even run of backslashes: in `\d+d+` the second `d`
// is a literal, not a repeat of `\d`, while in `\\d+d+` both are literals.
const REDOS_ADJACENT_QUANTIFIER = /(?<!\\)(?:\\\\)*(\\?[A-Za-z0-9.])[*+]\1[*+]/;

/**
 * Above this source length the structural analysis is skipped in favour of the
 * cheap presence-only check. Conf regexes are far shorter than this; the cap
 * only bounds the scanner's worst-case cost on pathological input.
 */
const REDOS_ANALYSIS_MAX_LENGTH = 2000;
/** Nesting depth beyond which the analysis gives up and assumes the worst. */
const REDOS_ANALYSIS_MAX_DEPTH = 20;

/** A single regex atom together with its quantifier, as produced by `scanAtoms`. */
interface RegexAtom {
  /** Atom source without its quantifier — e.g. `\d`, `[^ ]`, `(?:ab)`, `x`. */
  source: string;
  /** Quantifier as written (`''`, `*`, `+`, `?`, `{2,}`, …); lazy/possessive suffix stripped. */
  quantifier: string;
  /** True for `(`…`)` constructs, whose language this analysis treats as opaque. */
  isGroup: boolean;
  /** True for anchors, word boundaries and lookarounds — they consume no input. */
  isZeroWidth: boolean;
}

/** Characters sampled when testing whether two atoms' languages intersect. */
const PROBE_CHARS: string[] = (() => {
  const chars = ['\t', '\n', '\r'];
  for (let c = 0x20; c <= 0x7e; c++) chars.push(String.fromCharCode(c));
  chars.push('é', '中'); // one accented Latin and one CJK char
  return chars;
})();

/** Index of the `]` closing the character class that starts at `start`, or -1. */
function findClassEnd(source: string, start: number): number {
  let i = start + 1;
  if (source[i] === '^') i++;
  if (source[i] === ']') i++; // a leading `]` is a literal (PCRE; translatePcreToJs escapes it, #341)
  for (; i < source.length; i++) {
    if (source[i] === '\\') { i++; continue; }
    if (source[i] === ']') return i;
  }
  return -1;
}

/** Index of the `)` closing the group that starts at `start`, or -1. */
function findGroupEnd(source: string, start: number): number {
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      const end = findClassEnd(source, i);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split on `|` at the top level (outside groups and character classes), so each
 * alternative can be analysed independently.
 */
function splitTopLevelAlternatives(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source.charAt(i);
    if (c === '\\') { i++; continue; }
    if (c === '[') {
      const end = findClassEnd(source, i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '(') {
      const end = findGroupEnd(source, i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (c === '|') {
      parts.push(source.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(source.slice(start));
  return parts;
}

/**
 * Break a regex branch into atoms. Returns null when the source contains
 * something this analysis cannot reason about (unbalanced constructs,
 * backreferences), which callers treat as "assume risky".
 */
function scanAtoms(source: string): RegexAtom[] | null {
  const atoms: RegexAtom[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source.charAt(i);
    let atomSource: string;
    let isGroup = false;
    let isZeroWidth = false;

    if (c === '\\') {
      if (i + 1 >= source.length) return null;
      const next = source.charAt(i + 1);
      if (next >= '1' && next <= '9') return null; // backreference — unknown language
      if (next === 'b' || next === 'B') isZeroWidth = true;
      atomSource = source.slice(i, i + 2);
      i += 2;
    } else if (c === '[') {
      const end = findClassEnd(source, i);
      if (end < 0) return null;
      atomSource = source.slice(i, end + 1);
      i = end + 1;
    } else if (c === '(') {
      const end = findGroupEnd(source, i);
      if (end < 0) return null;
      atomSource = source.slice(i, end + 1);
      isGroup = true;
      isZeroWidth = /^\(\?(?:=|!|<=|<!)/.test(atomSource);
      i = end + 1;
    } else if (c === ')') {
      return null; // unbalanced
    } else if (c === '^' || c === '$') {
      atomSource = c;
      isZeroWidth = true;
      i += 1;
    } else {
      atomSource = c;
      i += 1;
    }

    let quantifier = '';
    if (i < source.length) {
      const q = source.charAt(i);
      if (q === '*' || q === '+' || q === '?') {
        quantifier = q;
        i += 1;
      } else if (q === '{') {
        const bound = /^\{\d+(?:,\d*)?\}/.exec(source.slice(i));
        if (bound) {
          quantifier = bound[0];
          i += bound[0].length;
        }
      }
      // A trailing `?` (lazy) or `+` (possessive) does not change the language.
      if (quantifier && (source[i] === '?' || source[i] === '+')) i += 1;
    }

    atoms.push({ source: atomSource, quantifier, isGroup, isZeroWidth });
  }
  return atoms;
}

/** The inner source of a group atom, or null for constructs with no body to analyse. */
function groupBody(groupSource: string): string | null {
  const inner = groupSource.slice(1, -1);
  // `?ims-x:` is a scoped modifier group, which `translatePcreToJs` emits for a
  // mid-pattern `(?i)`. It has a body like any other group; treating it as
  // body-less would let `a(?i)(x+)+` past the check once it became `a(?i:(x+)+)`.
  const prefix = /^\?(?::|[a-zA-Z]*(?:-[a-zA-Z]+)?:|<[A-Za-z_]\w*>|'[A-Za-z_]\w*'|P<[A-Za-z_]\w*>|=|!|<=|<!|>)/.exec(inner);
  if (prefix) return inner.slice(prefix[0].length);
  if (inner.startsWith('?')) return null; // inline flags or an unrecognised construct
  return inner;
}

/** True when the quantifier repeats its atom more than once. */
function isRepetition(quantifier: string): boolean {
  if (quantifier === '*' || quantifier === '+') return true;
  const bound = /^\{(\d+)(?:,(\d*))?\}$/.exec(quantifier);
  if (!bound) return false;
  const max = bound[2] === undefined ? Number(bound[1]) : bound[2] === '' ? Infinity : Number(bound[2]);
  return max > 1;
}

/** True when the quantifier allows unbounded repetition. */
function isUnbounded(quantifier: string): boolean {
  return quantifier === '*' || quantifier === '+' || /^\{\d+,\}$/.test(quantifier);
}

/** True when the atom (with its quantifier) can match the empty string. */
function matchesEmpty(atom: RegexAtom): boolean {
  return atom.quantifier === '*' || atom.quantifier === '?' || /^\{0[,}]/.test(atom.quantifier);
}

/**
 * True when two single-character atoms can match a common character — i.e. the
 * repeated atom could also consume its own terminator, which is the condition
 * that makes a repetition ambiguous. Unparseable atoms report an overlap so the
 * caller stays conservative.
 */
function charSetsOverlap(a: string, b: string): boolean {
  let ra: RegExp;
  let rb: RegExp;
  try {
    ra = new RegExp(`^(?:${a})$`, 's');
    rb = new RegExp(`^(?:${b})$`, 's');
  } catch {
    return true;
  }
  return PROBE_CHARS.some((c) => ra.test(c) && rb.test(c));
}

/**
 * Scan forward from `from` for an atom that bounds a repetition of `repeated`.
 *
 * Returns `'bounded'` when a mandatory, non-overlapping atom is found (the
 * repetition cannot run past it, so the split is unique), `'ambiguous'` when an
 * atom the repetition could also consume is found, and `'open'` when the run
 * ends without either.
 */
function findBoundary(
  repeated: RegexAtom,
  atoms: RegexAtom[],
  from: number,
  to: number,
): 'bounded' | 'ambiguous' | 'open' {
  for (let j = from; j < to; j++) {
    const next = atoms[j];
    // Zero-width assertions consume nothing and so cannot bound the repetition.
    if (next === undefined || next.isZeroWidth) continue;
    // An opaque group — no overlap analysis available, so assume the worst.
    if (next.isGroup) return 'ambiguous';
    // The repeated atom can also match what follows: the split is ambiguous.
    if (charSetsOverlap(repeated.source, next.source)) return 'ambiguous';
    // An optional atom does not bound the repetition, but a mandatory one does.
    if (!matchesEmpty(next)) return 'bounded';
  }
  return 'open';
}

/**
 * True when a repeated group's body is ambiguous: it holds an unbounded
 * quantifier that nothing reliably terminates, so one input can be split across
 * iterations in many ways.
 */
function branchIsAmbiguous(atoms: RegexAtom[]): boolean {
  for (const [i, atom] of atoms.entries()) {
    if (!isUnbounded(atom.quantifier)) continue;
    // A repeated group inside a repeated group is the classic `(a+)+` shape;
    // its language is opaque here, so assume the worst.
    if (atom.isGroup) return true;

    const forward = findBoundary(atom, atoms, i + 1, atoms.length);
    if (forward === 'ambiguous') return true;
    if (forward === 'bounded') continue;

    // Nothing later in the body bounds the repetition, so the boundary is the
    // group's own start: the next iteration begins at the body's first atom.
    // `(?:\d+[a-z]+)+` is unambiguous — a letter run can never be re-read as the
    // leading digits — while `(?:\w+=\S+\s*)+` is not, because `\S+` can eat the
    // next iteration's `\w+`.
    if (findBoundary(atom, atoms, 0, i + 1) !== 'bounded') return true;
  }
  return false;
}

/** Walk `source`, reporting whether any repeated group in it has an ambiguous body. */
function hasAmbiguousRepetition(source: string, depth: number): boolean {
  if (depth > REDOS_ANALYSIS_MAX_DEPTH) return true;

  for (const branch of splitTopLevelAlternatives(source)) {
    const atoms = scanAtoms(branch);
    if (!atoms) return true;

    for (const atom of atoms) {
      if (!atom.isGroup) continue;
      const body = groupBody(atom.source);
      if (body === null) continue; // inline flags — nothing to analyse

      if (isRepetition(atom.quantifier) && !atom.isZeroWidth) {
        for (const bodyBranch of splitTopLevelAlternatives(body)) {
          const bodyAtoms = scanAtoms(bodyBranch);
          if (!bodyAtoms) return true;
          if (branchIsAmbiguous(bodyAtoms)) return true;
        }
      }

      if (hasAmbiguousRepetition(body, depth + 1)) return true;
    }
  }
  return false;
}

/**
 * Memo of the risk verdict, keyed on the pattern source.
 *
 * The VERDICT is cached, not the compiled `RegExp`: a cached RegExp would be
 * shared across unrelated call sites, and a shared `g`-flagged regex carries
 * `lastIndex` between them — a much harder bug than the cost this avoids.
 * Compilation is cheap and the engine caches it internally; the structural
 * analysis below is the expensive part, and it is a pure function of the source.
 *
 * Bounded so a long session over pathological input cannot grow it without
 * limit. A Map preserves insertion order, so evicting the first key is FIFO.
 */
const REDOS_VERDICT_CACHE_LIMIT = 500;
const redosVerdictCache = new Map<string, boolean>();

export function hasReDoSRisk(pattern: string): boolean {
  const cached = redosVerdictCache.get(pattern);
  if (cached !== undefined) return cached;

  const verdict = computeReDoSRisk(pattern);
  if (redosVerdictCache.size >= REDOS_VERDICT_CACHE_LIMIT) {
    const oldest = redosVerdictCache.keys().next().value;
    if (oldest !== undefined) redosVerdictCache.delete(oldest);
  }
  redosVerdictCache.set(pattern, verdict);
  return verdict;
}

function computeReDoSRisk(pattern: string): boolean {
  if (REDOS_ADJACENT_QUANTIFIER.test(pattern)) return true;
  if (pattern.length > REDOS_ANALYSIS_MAX_LENGTH) return REDOS_NESTED_GROUP.test(pattern);
  return hasAmbiguousRepetition(pattern, 0);
}

/**
 * Safely compile a regex pattern, returning null on invalid patterns
 * or patterns with known ReDoS risk.
 */
export function safeRegex(pattern: string, flags?: string): RegExp | null {
  const { source, flags: mergedFlags, error } = translatePcreToJs(pattern, flags ?? '');
  if (error !== undefined || hasReDoSRisk(source)) return null;
  try {
    return new RegExp(source, mergedFlags);
  } catch {
    return null;
  }
}

/**
 * Validate a regex pattern string.
 *
 * @returns An error message describing why the pattern is invalid, or `null`
 *          if the pattern compiles successfully.
 */
export function validateRegex(pattern: string): string | null {
  const { source, flags, error } = translatePcreToJs(pattern);
  if (error !== undefined) return error;
  // Compiled first: the structural scanner assumes the worst of a pattern it
  // cannot parse, so an unclosed group was reported as a ReDoS risk rather
  // than as the syntax error it is. Compiling never executes the pattern.
  try {
    new RegExp(source, flags);
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      return e.message;
    }
    return String(e);
  }
  if (hasReDoSRisk(source)) {
    return 'Pattern contains a structure prone to catastrophic backtracking (ReDoS risk).';
  }
  return null;
}
