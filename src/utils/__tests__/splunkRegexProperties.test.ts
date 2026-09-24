// ---------------------------------------------------------------------------
// splunkRegexProperties.test.ts
// Property-based tests for the PCRE → JS translation in translatePcreToJs (#340).
//
// Patterns are generated from a subset of regex syntax that PCRE and JS read
// the same way — literals, escapes, character classes (with regex
// metacharacters inside them), greedy and lazy quantifiers, capturing,
// non-capturing, named and lookaround groups, alternation and anchors — and
// the translation is checked against JS's own reading of the equivalent
// pattern, on generated subject strings.
//
// Excluded from generation, with the reason:
//  - a `]` first in a class (`[]a]`, `[^]a]`). PCRE reads it as a literal `]`
//    inside the class; JS reads `[]` as an empty class and `[^]` as "any
//    character". The translator copies classes verbatim, so the two engines
//    disagree on such a pattern — a real divergence, reported separately
//    rather than asserted here, since the properties below compare against
//    JS's reading.
//  - `[:` inside a class, which PCRE reads as the start of a POSIX class.
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { translatePcreToJs, SUPPORTS_SCOPED_MODIFIERS } from '../splunkRegex';

fc.configureGlobal({ seed: 340, numRuns: 300 });

// ── Pattern grammar ─────────────────────────────────────
//
// A pattern is built as a tree and rendered twice: once as JS source and once
// as PCRE source, which differ only in named-group syntax. Named groups are
// numbered while rendering so names never collide.

type Atom =
  | { t: 'text'; s: string } // a literal, escape, `.`, or character class — identical in both syntaxes
  | { t: 'anchor'; s: string }
  | { t: 'group'; kind: 'cap' | 'nc' | 'named' | 'la' | 'nla' | 'lb' | 'nlb'; body: Alt }
  | { t: 'backref' } // to the most recent named group, if any
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

/** A character class. A `^` is only a negation when first; inside, it is a literal. */
const charClass = fc
  .tuple(fc.boolean(), fc.array(classItem, { minLength: 1, maxLength: 4 }), fc.boolean())
  .map(([negate, items, caret]) => `[${negate ? '^' : ''}${items.join('')}${caret ? '^' : ''}]`);

const quantifier = fc
  .tuple(fc.constantFrom('*', '+', '?', '{2}', '{1,}', '{0,2}', '{1,3}'), fc.boolean())
  .map(([q, lazy]) => (lazy ? `${q}?` : q));

const textAtom: fc.Arbitrary<Atom> = fc
  .oneof(literal, escape, fc.constant('.'), charClass)
  .map((s) => ({ t: 'text', s }));

const anchor: fc.Arbitrary<Atom> = fc.constantFrom('^', '$', '\\b', '\\B').map((s) => ({ t: 'anchor', s }));

const { alt } = fc.letrec<{ alt: Alt; seq: Seq; atom: Atom; group: Atom }>((tie) => ({
  alt: fc.array(tie('seq'), { minLength: 1, maxLength: 3 }),
  seq: fc.array(tie('atom'), { maxLength: 5 }),
  atom: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    textAtom,
    anchor,
    fc.constant<Atom>({ t: 'backref' }),
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

/** Render as JS (`(?<g0>…)`, `\k<g0>`) or PCRE (`(?P<g0>…)`, `(?P=g0)`) source. */
function render(pattern: Alt, flavour: 'js' | 'pcre'): string {
  let named = 0;
  let lastName: string | undefined;
  const opens: Record<string, string> = { cap: '(', nc: '(?:', la: '(?=', nla: '(?!', lb: '(?<=', nlb: '(?<!' };
  const atom = (a: Atom): string => {
    switch (a.t) {
      case 'text':
      case 'anchor':
        return a.s;
      case 'backref':
        // A backreference to a group that is not yet defined is legal in both
        // engines but means different things (JS: empty; PCRE: fails), so only
        // refer back to a group that has closed.
        if (lastName === undefined) return '';
        return flavour === 'js' ? `\\k<${lastName}>` : `(?P=${lastName})`;
      case 'quant':
        return atom(a.atom) + a.q;
      case 'group': {
        if (a.kind === 'named') {
          const name = `g${named++}`;
          const body = alternation(a.body);
          lastName = name;
          return `${flavour === 'js' ? '(?<' : '(?P<'}${name}>${body})`;
        }
        return `${opens[a.kind]!}${alternation(a.body)})`;
      }
    }
  };
  const alternation = (alts: Alt): string => alts.map((s) => s.map(atom).join('')).join('|');
  return alternation(pattern);
}

const jsPattern = alt.map((p) => render(p, 'js'));

const subject = fc.string({ unit: fc.constantFrom(...SUBJECT_CHARS), maxLength: 12 });
const subjects = fc.array(subject, { minLength: 1, maxLength: 6 });

/** Every match `re` finds in `s`, with its index and captures. */
function allMatches(re: RegExp, s: string) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  return [...s.matchAll(g)].map((m) => ({ index: m.index, captures: [...m], groups: m.groups ? { ...m.groups } : undefined }));
}

function expectSameMatches(actual: RegExp, expected: RegExp, strings: string[]) {
  for (const s of strings) {
    expect(allMatches(actual, s), `/${actual.source}/${actual.flags} vs /${expected.source}/${expected.flags} on ${JSON.stringify(s)}`).toEqual(
      allMatches(expected, s),
    );
  }
}

function compiles(source: string, flags = ''): boolean {
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

// ── Properties ──────────────────────────────────────────

describe('translatePcreToJs properties (#340)', () => {
  it('generates patterns JS accepts', () => {
    // Guards the generator: every other property assumes its patterns compile.
    fc.assert(
      fc.property(jsPattern, (p) => {
        expect(compiles(p), p).toBe(true);
      }),
    );
  });

  it('leaves a pattern JS already accepts unchanged, so it matches identically', () => {
    fc.assert(
      fc.property(jsPattern, subjects, (p, strings) => {
        const t = translatePcreToJs(p);
        expect(t, p).toEqual({ source: p, flags: '', warnings: [] });
        expectSameMatches(new RegExp(t.source, t.flags), new RegExp(p), strings);
      }),
    );
  });

  it('reads PCRE (?P<name>…) and (?P=name) as JS named groups and backreferences', () => {
    fc.assert(
      fc.property(alt, subjects, (p, strings) => {
        const t = translatePcreToJs(render(p, 'pcre'));
        expect(t.source).toBe(render(p, 'js'));
        expectSameMatches(new RegExp(t.source, t.flags), new RegExp(render(p, 'js')), strings);
      }),
    );
  });

  it('treats a leading (?i) as the JS i flag', () => {
    fc.assert(
      fc.property(jsPattern, subjects, (p, strings) => {
        const t = translatePcreToJs(`(?i)${p}`);
        expect(t.flags).toBe('i');
        expect(t.warnings).toEqual([]);
        expectSameMatches(new RegExp(t.source, t.flags), new RegExp(p, 'i'), strings);
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
  const seqText = (s: Atom[]) => s.map((a) => (a.t === 'text' || a.t === 'anchor' ? a.s : '')).join('');

  it.runIf(SUPPORTS_SCOPED_MODIFIERS)('scopes a mid-pattern (?i) to the rest of its group and each later alternative', () => {
    fc.assert(
      fc.property(midPattern, subjects, ({ outer, inGroup, pre, post, rest }, strings) => {
        const tail = rest === undefined ? '' : `|${seqText(rest)}`;
        const tailJs = rest === undefined ? '' : `|(?i:(?:${seqText(rest)}))`;
        const body = `${seqText(pre)}(?i)${seqText(post)}${tail}`;
        const bodyJs = `${seqText(pre)}(?i:(?:${seqText(post)}))${tailJs}`;
        const [before, after] = outer.map(seqText) as [string, string];
        const pcre = inGroup ? `${before}(${body})${after}` : body;
        const js = inGroup ? `${before}(${bodyJs})${after}` : bodyJs;
        const t = translatePcreToJs(pcre, '', { scopedModifiers: true });
        expect(t.warnings).toEqual([]);
        expectSameMatches(new RegExp(t.source, t.flags), new RegExp(js), strings);
      }),
    );
  });

  it('hoists a mid-pattern (?i) to the whole pattern, with a warning, where scoped groups are unavailable', () => {
    fc.assert(
      fc.property(midPattern, subjects, ({ outer, inGroup, pre, post, rest }, strings) => {
        const tail = rest === undefined ? '' : `|${seqText(rest)}`;
        const [before, after] = outer.map(seqText) as [string, string];
        const wrap = (body: string) => (inGroup ? `${before}(${body})${after}` : body);
        const t = translatePcreToJs(wrap(`${seqText(pre)}(?i)${seqText(post)}${tail}`), '', { scopedModifiers: false });
        const hoisted = wrap(`${seqText(pre)}${seqText(post)}${tail}`);
        expect(t.source).toBe(hoisted);
        expect(t.flags).toBe('i');
        // A (?i) at the very start is a leading group, which a flag expresses exactly.
        const leading = !inGroup && seqText(pre) === '';
        expect(t.warnings).toHaveLength(leading ? 0 : 1);
        expectSameMatches(new RegExp(t.source, t.flags), new RegExp(hoisted, 'i'), strings);
      }),
    );
  });

  it('never alters the contents of a character class', () => {
    // PCRE-only syntax around the classes, so the translator has work to do
    // everywhere except inside them.
    const pcreNoise = fc.constantFrom('a++', '\\d*+', 'x?+', '(?>b)', '(?P<n>c)', '(?i)', 'd{2}+', ' # c\n', '|', '(e)');
    const piece = fc.oneof(
      charClass.map((c) => ({ cls: c })),
      pcreNoise.map((s) => ({ text: s })),
    );
    fc.assert(
      fc.property(fc.boolean(), fc.array(piece, { maxLength: 8 }), fc.boolean(), (extended, pieces, scoped) => {
        const pattern = (extended ? '(?x)' : '') + pieces.map((p) => ('cls' in p ? p.cls : p.text)).join('');
        const { source } = translatePcreToJs(pattern, '', { scopedModifiers: scoped });
        let from = 0;
        for (const p of pieces) {
          if (!('cls' in p)) continue;
          const at = source.indexOf(p.cls, from);
          expect(at, `${p.cls} in ${source}`).toBeGreaterThanOrEqual(0);
          from = at + p.cls.length;
        }
      }),
    );
  });

  it('never throws, and leaves anything JS accepts compiling and unchanged', () => {
    const regexChar = fc.constantFrom(
      '(', ')', '[', ']', '{', '}', '?', '*', '+', '|', '^', '$', '\\', '.', 'a', '1', ',', '<', '>', '=', '!', ':', 'P', 'i', 'x', '-', ' ', '#', '\n',
    );
    fc.assert(
      fc.property(fc.string({ unit: regexChar, maxLength: 16 }), fc.boolean(), (s, scoped) => {
        const t = translatePcreToJs(s, '', { scopedModifiers: scoped });
        if (compiles(s)) {
          expect(t, s).toEqual({ source: s, flags: '', warnings: [] });
        }
      }),
      { numRuns: 500 },
    );
  });
});
