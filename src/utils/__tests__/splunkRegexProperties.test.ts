// ---------------------------------------------------------------------------
// splunkRegexProperties.test.ts
// Differential property tests: PCRE2 (the engine) against JS's own RegExp, on
// the syntax the two read the same way.
//
// Patterns are generated from literals, escapes, character classes (with
// regex metacharacters inside them), greedy and lazy quantifiers, capturing,
// non-capturing, named and lookaround groups, alternation and anchors, rendered
// once in JS spelling and once in PCRE spelling (`(?P<name>…)`). One class
// spelling differs: a `]` first in a class is a member in PCRE and written
// `\]` for JS.
//
// Differences the comparison steps around, each pinned by an example test in
// splunkRegex.test.ts instead:
//  - `$` also matches before a final newline in PCRE; compiled here with
//    DOLLAR_ENDONLY so the two agree.
//  - Iteration after an empty match, and captures inside repeated groups:
//    compared by first match per start offset, whole match only.
//  - A backreference to a group that did not participate matches empty in JS
//    and fails in PCRE, so the generator makes none.
//  - A lookbehind of unbounded length is a JS-only feature.
//  - `[:` inside a class, which PCRE reads as the start of a POSIX class, is
//    never generated.
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { safeRegex, type SplunkRegex } from '../splunkRegex';
import { fcSeed } from '../../test/fcSeed';

fc.configureGlobal({ seed: fcSeed(340), numRuns: 300 });

// ── Pattern grammar ─────────────────────────────────────
//
// A pattern is built as a tree and rendered twice: once as JS source and once
// as PCRE source, which differ only in named-group syntax. Named groups are
// numbered while rendering so names never collide.

type Atom =
  // A literal, escape, `.`, or character class. `pcre` is set only where the
  // PCRE spelling differs: a class whose first member is `]`.
  | { t: 'text'; s: string; pcre?: string }
  | { t: 'anchor'; s: string }
  | { t: 'group'; kind: 'cap' | 'nc' | 'named' | 'la' | 'nla' | 'lb' | 'nlb'; body: Alt }
  | { t: 'quant'; atom: Atom; q: string };
type Seq = Atom[];
type Alt = Seq[];

/** Characters used for literals and for the subject strings, so matches happen. */
const SUBJECT_CHARS = ['a', 'b', 'A', 'B', '1', ' ', '-', '_', '.', '*', '\n', ',', '(', ']', '<', 'é', '#'];

const literal = fc.constantFrom('a', 'b', 'A', 'B', '1', ' ', '-', '_', ',', ':', '=', '#', '/', '<', '>', '!', '@', '~', '"', "'", '%', '&', 'é');
const escape = fc.constantFrom(
  '\\d', '\\w', '\\s', '\\D', '\\W', '\\S', '\\.', '\\*', '\\+', '\\?', '\\(', '\\)', '\\[', '\\]',
  '\\{', '\\}', '\\|', '\\\\', '\\/', '\\-', '\\^', '\\$', '\\t', '\\n', '\\#', '\\ ',
);

/** A single class member. No `-` except in explicit ranges or escaped, so no accidental range. */
const classItem = fc.constantFrom(
  'a', 'b', 'A', '1', ' ', '_', ',', '#', '*', '+', '?', '(', ')', '{', '}', '|', '.', '$', '<', '>', '=', '!', '"',
  'a-z', '0-9', 'A-F', '\\d', '\\w', '\\s', '\\]', '\\\\', '\\-', '\\[', '\\^',
  // PCRE syntax that is only text inside a class — the translator must not act on it.
  '(?P<x>', '(?i)', '(?>', '++', '*+', '?+', '{2}+', '(?P=x)',
);

/**
 * A character class, in both spellings. A `^` is only a negation when first;
 * inside, it is a literal. A `]` first (after any `^`) is a literal member in
 * PCRE, which JS spells `\]`; with it, the class needs no other member.
 */
const charClass = fc
  .tuple(fc.boolean(), fc.boolean(), fc.array(classItem, { maxLength: 4 }), fc.boolean())
  .filter(([, bracket, items]) => bracket || items.length > 0)
  .map(([negate, bracket, items, caret]) => {
    const open = `[${negate ? '^' : ''}`;
    const rest = `${items.join('')}${caret ? '^' : ''}]`;
    return { js: `${open}${bracket ? '\\]' : ''}${rest}`, pcre: `${open}${bracket ? ']' : ''}${rest}` };
  });

const quantifier = fc
  .tuple(fc.constantFrom('*', '+', '?', '{2}', '{1,}', '{0,2}', '{1,3}'), fc.boolean())
  .map(([q, lazy]) => (lazy ? `${q}?` : q));

const textAtom: fc.Arbitrary<Atom> = fc.oneof(
  fc.oneof(literal, escape, fc.constant('.')).map((s): Atom => ({ t: 'text', s })),
  charClass.map(({ js, pcre }): Atom => (js === pcre ? { t: 'text', s: js } : { t: 'text', s: js, pcre })),
);

const anchor: fc.Arbitrary<Atom> = fc.constantFrom('^', '$', '\\b', '\\B').map((s) => ({ t: 'anchor', s }));

const { alt } = fc.letrec<{ alt: Alt; seq: Seq; atom: Atom; group: Atom }>((tie) => ({
  alt: fc.array(tie('seq'), { minLength: 1, maxLength: 3 }),
  seq: fc.array(tie('atom'), { maxLength: 5 }),
  atom: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    textAtom,
    anchor,
    tie('group'),
    // Anchors and lookarounds are not quantifiable in both engines; everything else is.
    fc
      .tuple(fc.oneof(textAtom, tie('group')), quantifier)
      .filter(([a]) => !(a.t === 'group' && ['la', 'nla', 'lb', 'nlb'].includes(a.kind)))
      .map(([atom, q]): Atom => ({ t: 'quant', atom, q })),
  ),
  group: fc
    .tuple(fc.constantFrom('cap', 'nc', 'named', 'la', 'nla', 'lb', 'nlb'), tie('alt'))
    .map(([kind, body]): Atom => ({ t: 'group', kind, body })),
}));

const seqOnly = fc.array(fc.oneof(textAtom, anchor), { maxLength: 4 });

/** Render as JS (`(?<g0>…)`) or PCRE (`(?P<g0>…)`) source. */
function render(pattern: Alt, flavour: 'js' | 'pcre'): string {
  let named = 0;
  const opens: Record<string, string> = { cap: '(', nc: '(?:', la: '(?=', nla: '(?!', lb: '(?<=', nlb: '(?<!' };
  const atom = (a: Atom): string => {
    switch (a.t) {
      case 'text':
        return flavour === 'pcre' ? a.pcre ?? a.s : a.s;
      case 'anchor':
        return a.s;
      case 'quant':
        return atom(a.atom) + a.q;
      case 'group': {
        if (a.kind === 'named') {
          const name = `g${named++}`;
          const body = alternation(a.body);
          return `${flavour === 'js' ? '(?<' : '(?P<'}${name}>${body})`;
        }
        return `${opens[a.kind]!}${alternation(a.body)})`;
      }
    }
  };
  const alternation = (alts: Alt): string => alts.map((s) => s.map(atom).join('')).join('|');
  return alternation(pattern);
}

const pcrePattern = alt.map((p) => ({ js: render(p, 'js'), pcre: render(p, 'pcre') }));

const subject = fc.string({ unit: fc.constantFrom(...SUBJECT_CHARS), maxLength: 12 });
const subjects = fc.array(subject, { minLength: 1, maxLength: 6 });

/**
 * PCRE2 rejects a lookbehind whose branches have no maximum length; JS accepts
 * any lookbehind. The generator produces both, and these are the only
 * patterns PCRE may refuse.
 */
const UNBOUNDED_LOOKBEHIND = /\(\?<[=!].*(?:[*+]|\{\d+,\})/;

/**
 * The first match at each start offset, as [index, text]. Whole-match spans
 * only: capture groups inside a repeated group keep their last value in PCRE
 * but are reset per iteration in JS, a documented difference.
 */
function pcreFirstMatches(re: SplunkRegex, s: string) {
  const out: [number, string][] = [];
  for (let i = 0; i <= s.length; i++) {
    const m = re.exec(s, i);
    out.push(m ? [m.index, m[0]] : [-1, '']);
  }
  return out;
}

function jsFirstMatches(re: RegExp, s: string) {
  const g = new RegExp(re.source, `${re.flags}g`);
  const out: [number, string][] = [];
  for (let i = 0; i <= s.length; i++) {
    g.lastIndex = i;
    const m = g.exec(s);
    out.push(m ? [m.index, m[0]] : [-1, '']);
  }
  return out;
}

function expectSameMatches(pcre: SplunkRegex, js: RegExp, strings: string[]) {
  for (const s of strings) {
    expect(pcreFirstMatches(pcre, s), `${pcre.source} vs /${js.source}/${js.flags} on ${JSON.stringify(s)}`).toEqual(
      jsFirstMatches(js, s),
    );
  }
}

/** Compiled as the engine compiles it, but with `$` at the very end only, as in JS. */
function pcre(source: string): SplunkRegex | null {
  return safeRegex(source, 'D');
}

const SUPPORTS_SCOPED_MODIFIERS = (() => {
  try {
    new RegExp('(?i:a)');
    return true;
  } catch {
    return false;
  }
})();

// ── Properties ──────────────────────────────────────────

describe('PCRE2 agrees with JS on the syntax the two share (#368)', () => {
  it('compiles every generated pattern but a lookbehind of unbounded length', () => {
    fc.assert(
      fc.property(pcrePattern, ({ js, pcre: p }) => {
        expect(() => new RegExp(js), js).not.toThrow();
        if (!UNBOUNDED_LOOKBEHIND.test(p)) expect(pcre(p), p).not.toBeNull();
      }),
    );
  });

  it('finds the same first match from every offset', () => {
    fc.assert(
      fc.property(pcrePattern, subjects, ({ js, pcre: p }, strings) => {
        const re = pcre(p);
        if (!re) return;
        expectSameMatches(re, new RegExp(js), strings);
      }),
    );
  });

  it('reads the JS spelling of named groups the same as the PCRE one', () => {
    fc.assert(
      fc.property(pcrePattern, subjects, ({ js, pcre: p }, strings) => {
        const re = pcre(js);
        if (!re) return;
        expectSameMatches(re, new RegExp(js), strings);
        expect(pcre(p)?.names).toEqual(re.names);
      }),
    );
  });

  it('treats a leading (?i) as the JS i flag', () => {
    fc.assert(
      fc.property(pcrePattern, subjects, ({ js, pcre: p }, strings) => {
        const re = pcre(`(?i)${p}`);
        if (!re) return;
        expectSameMatches(re, new RegExp(js, 'i'), strings);
      }),
    );
  });

  /**
   * `pre(?i)post|rest`, optionally inside a capturing group with text around
   * it: the documented scope of a mid-pattern flag group is the rest of the
   * enclosing group, each later alternative included.
   */
  const midPattern = fc.record({
    outer: fc.tuple(seqOnly, seqOnly),
    inGroup: fc.boolean(),
    pre: seqOnly,
    post: seqOnly,
    rest: fc.option(seqOnly, { nil: undefined }),
  });
  const seqText = (s: Atom[], flavour: 'js' | 'pcre' = 'js') =>
    s.map((a) => (a.t === 'text' ? (flavour === 'pcre' ? a.pcre ?? a.s : a.s) : a.t === 'anchor' ? a.s : '')).join('');

  it.runIf(SUPPORTS_SCOPED_MODIFIERS)('scopes a mid-pattern (?i) to the rest of its group and each later alternative', () => {
    fc.assert(
      fc.property(midPattern, subjects, ({ outer, inGroup, pre, post, rest }, strings) => {
        const tail = rest === undefined ? '' : `|${seqText(rest, 'pcre')}`;
        const tailJs = rest === undefined ? '' : `|(?i:(?:${seqText(rest)}))`;
        const body = `${seqText(pre, 'pcre')}(?i)${seqText(post, 'pcre')}${tail}`;
        const bodyJs = `${seqText(pre)}(?i:(?:${seqText(post)}))${tailJs}`;
        const [beforePcre, afterPcre] = outer.map((o) => seqText(o, 'pcre')) as [string, string];
        const [before, after] = outer.map((o) => seqText(o)) as [string, string];
        const p = inGroup ? `${beforePcre}(${body})${afterPcre}` : body;
        const js = inGroup ? `${before}(${bodyJs})${after}` : bodyJs;
        expectSameMatches(pcre(p)!, new RegExp(js), strings);
      }),
    );
  });
});
