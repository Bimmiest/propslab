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
/** A whole inline flag group such as `(?i)` or `(?ims)`, anchored at the scan position. */
const INLINE_FLAG_GROUP = /^\(\?([a-zA-Z]+)\)/;
/** A bounded quantifier (`{2}`, `{2,}`, `{2,5}`), anchored at the scan position. */
const BOUNDED_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

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

/**
 * Translate the subset of PCRE (Splunk regex) syntax that the JS engine does not
 * accept into an equivalent JS form, returning the rewritten source plus any
 * flags that must be applied. Without this, common Splunk patterns throw at
 * compile time and `safeRegex` returns null, silently producing no extraction.
 *
 * Handled:
 *  - `(?P<name>…)` / `(?P=name)`  → `(?<name>…)` / `\k<name>`
 *  - leading inline flag groups `(?i)`, `(?ims)` → merged into the flags, which
 *    is exact: a leading group governs the whole pattern
 *  - a mid-pattern flag group `a(?i)b` → a scoped group `a(?i:b)` running to the
 *    end of the enclosing group. PCRE carries the option into that group's later
 *    alternatives too, but one scoped group spanning a `|` would capture the
 *    alternation (`a(?i)b|c` would become "a, then b or c"), so each alternative
 *    is wrapped separately: `a(?i:b)|(?i:c)`. Where the runtime lacks scoped
 *    groups the flag is hoisted to the whole pattern, with a warning.
 *  - a leading `(?x)` → extended mode applied here, since JS has no `x` flag:
 *    unescaped whitespace and `#…` comments outside character classes are removed
 *  - atomic groups `(?>…)`        → non-capturing `(?:…)` (loses atomicity only)
 *  - possessive quantifiers `a++`, `\d*+`, `x?+`, `{2,3}+` → greedy equivalents
 *
 * The rewrite is one left-to-right scan that tracks escapes and character
 * classes, because every construct above is syntax only OUTSIDE a class: `[*+]`
 * is "a star or a plus", not a possessive star, and `\\++` is an escaped
 * backslash followed by a possessive plus. Regex-replace passes over the raw
 * source could not tell those apart.
 *
 * Not handled (still throw → null): conditionals `(?(…)…)`, recursion, `\p{…}`
 * outside unicode mode, POSIX classes `[[:alpha:]]`.
 */
export function translatePcreToJs(
  pattern: string,
  flags = '',
  options: PcreTranslationOptions = {},
): PcreTranslation {
  const scopedModifiers = options.scopedModifiers ?? SUPPORTS_SCOPED_MODIFIERS;
  const warnings: string[] = [];
  let extraFlags = '';
  let extended = false;

  const addFlags = (letters: string) => {
    for (const c of letters) {
      if (JS_REPRESENTABLE_INLINE_FLAGS.includes(c) && !extraFlags.includes(c)) extraFlags += c;
    }
  };
  // Anything else (`(?Q)`) is not a flag group — left for the compiler to reject.
  const isFlagGroup = (letters: string) => [...letters].every((c) => PCRE_INLINE_FLAG_LETTERS.includes(c));

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

  // Leading flag groups govern the whole pattern, which a JS flag expresses
  // exactly. Once `(?x)` is seen, whitespace between later leading groups is
  // already insignificant, so `(?x) (?i)` is still two leading groups.
  let i = 0;
  for (;;) {
    if (extended) i = skipIgnorable(i);
    const m = INLINE_FLAG_GROUP.exec(pattern.slice(i));
    if (!m || !isFlagGroup(m[1]!)) break;
    addFlags(m[1]!);
    if (m[1]!.includes('x')) extended = true;
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
      // Copied verbatim, so an escaped `+`, `(`, `[`, `#` or space is never
      // read as syntax. A trailing lone `\` is left for the compiler to reject.
      out += pattern.slice(i, i + 2);
      i += 2;
      continue;
    }

    if (c === '[') {
      const end = findClassEnd(pattern, i);
      if (end < 0) {
        out += pattern.slice(i); // unterminated — the compiler reports it
        break;
      }
      // Verbatim: PCRE's `x` does not touch whitespace inside a class either —
      // except a `]` straight after `[` or `[^`, which PCRE reads as a literal
      // member (`[]a]` is "`]` or `a`") and JS as the end of an empty class
      // (`[]`, never matches) or of "any character" (`[^]`). findClassEnd
      // already skips it when finding the class end; escaping it makes JS
      // read the same class (#341).
      const open = pattern[i + 1] === '^' ? 2 : 1;
      const body = pattern.slice(i + open, end + 1);
      out += pattern.slice(i, i + open) + (body.startsWith(']') ? `\\${body}` : body);
      i = end + 1;
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
      const named = /^\(\?P<(\w+)>/.exec(rest);
      if (named) {
        out += `(?<${named[1]!}>`;
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
      if (rest.startsWith('(?>')) {
        out += '(?:'; // JS has no atomic groups
        i += 3;
        frames.push({ scoped: [] });
        continue;
      }
      const flagGroup = INLINE_FLAG_GROUP.exec(rest);
      if (flagGroup && isFlagGroup(flagGroup[1]!)) {
        const letters = flagGroup[1]!;
        i += flagGroup[0].length;
        if (letters.includes('x')) {
          warnings.push(
            '(?x) is only applied at the start of a pattern; mid-pattern it is ignored, so whitespace after it is matched literally.',
          );
        }
        const js = [...new Set(letters)].filter((l) => JS_REPRESENTABLE_INLINE_FLAGS.includes(l)).join('');
        if (!js) continue;
        if (scopedModifiers) {
          out += `(?${js}:`;
          current().scoped.push(js);
        } else {
          addFlags(js);
          warnings.push(
            `Mid-pattern (?${js}) was applied to the whole pattern: this browser does not support scoped modifier groups, so text before it is matched with the same flags.`,
          );
        }
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

  let mergedFlags = flags;
  for (const c of extraFlags) {
    if (!mergedFlags.includes(c)) mergedFlags += c;
  }

  return { source: out, flags: mergedFlags, warnings };
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
const REDOS_ADJACENT_QUANTIFIER = /(\\?[A-Za-z0-9.])[*+]\1[*+]/;

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
  const { source, flags: mergedFlags } = translatePcreToJs(pattern, flags ?? '');
  if (hasReDoSRisk(source)) return null;
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
  const { source, flags } = translatePcreToJs(pattern);
  if (hasReDoSRisk(source)) {
    return 'Pattern contains a structure prone to catastrophic backtracking (ReDoS risk).';
  }
  try {
    new RegExp(source, flags);
    return null;
  } catch (e: unknown) {
    if (e instanceof SyntaxError) {
      return e.message;
    }
    return String(e);
  }
}
