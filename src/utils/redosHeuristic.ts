/**
 * An advisory, structural check for patterns prone to catastrophic
 * backtracking. It gates nothing: every pattern runs on PCRE2, whose match and
 * depth limits bound the work of each match, as they do in Splunk. What is
 * left for it is to point at a likely culprit when the total work of a run —
 * many events, many patterns, each within its limits — still outlasts a
 * watchdog; the MCP server lists its verdicts beside a timeout.
 *
 * It flags:
 *  1. A repeated group whose body is *ambiguous* — the body contains an
 *     unbounded `*`/`+` that nothing inside the body reliably terminates, so a
 *     given input can be split across iterations in exponentially many ways.
 *     Examples: `(a+)+`, `(\w+)*`, `(.+)+`, `(?:\d*)*`, `(.*,){20}`.
 *  2. Two adjacent unbounded quantifiers on the SAME atom. Examples: `a*a*`,
 *     `\d+\d+` — and by extension long runs like `a*a*a*a*c`.
 *
 * Rule 1 checks ambiguity rather than the mere presence of an inner
 * quantifier: `(\d+\.){3}\d+` (IPv4), `^(?:[^ ]* ){2}` and `(?:[^,]*,)+` are
 * safe and idiomatic. A repetition is only ambiguous when the repeated atom can
 * also match whatever follows it inside the body.
 *
 * It does NOT catch alternation-overlap forms such as `(a|aa)+`, so an empty
 * verdict proves nothing.
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
  if (source[i] === ']') i++; // a leading `]` is a literal (PCRE; translatePcreToJs escapes it)
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
 * Memo of the risk verdict, keyed on the pattern source: the analysis is a
 * pure function of the source and the expensive part.
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
