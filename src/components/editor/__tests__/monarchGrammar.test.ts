// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// monarchGrammar.test.ts
// The conf grammar's continuation handling, and its agreement with parseConf on
// what each line of a file is.
//
// Runs Monaco's own tokenizer (editor.tokenize) over the registered language:
// the grammar is data that only Monarch can execute, so a stub would test
// nothing. The editor's DOM is not needed for that, and jsdom is enough.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, vi } from 'vitest';
import fc from 'fast-check';
import * as monaco from 'monaco-editor/editor';
import { ensureSplunkMonaco, PROPS_LANGUAGE_ID } from '../splunkMonacoSetup';
import { parseConf } from '../../../engine/parser/confParser';

// jsdom has no matchMedia, which Monaco's theme service reads when it is created.
vi.hoisted(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
});

beforeAll(() => {
  ensureSplunkMonaco();
});

interface Piece {
  type: string;
  text: string;
}

/** Tokenize `text` and return each line's tokens with their text, the language postfix removed. */
function tokenize(text: string): Piece[][] {
  const lines = text.split('\n');
  return monaco.editor.tokenize(text, PROPS_LANGUAGE_ID).map((tokens, i) =>
    tokens.map((t, j) => ({
      type: t.type.replace(/\.splunk-conf$/, ''),
      text: (lines[i] ?? '').slice(t.offset, tokens[j + 1]?.offset),
    })),
  );
}

type Kind = 'comment' | 'header' | 'directive' | 'text';

/** What the grammar made of a line: read off its first tokens. */
function kindOf(pieces: Piece[]): Kind {
  const first = pieces[0];
  if (!first) return 'text';
  if (first.type === 'comment') return 'comment';
  if (first.type === 'tag.bracket') return 'header';
  // A directive is a key followed by a delimiter that is the `=` itself.
  const eq = pieces.findIndex((p, i) => i > 0 && p.type === 'delimiter' && p.text.trim().startsWith('='));
  if (eq > 0) return 'directive';
  return 'text';
}

const kinds = (text: string) => tokenize(text).map(kindOf);

describe('a value continues on an odd run of trailing backslashes', () => {
  it.each([
    ['a header-looking line', 'REGEX = a\\\n[a-z]+\nKEY = v'],
    ['a comment-looking line', 'REGEX = a\\\n#x\nKEY = v'],
    ['a directive-looking line', 'REGEX = a\\\nOTHER = b\nKEY = v'],
    ['an indented line', 'REGEX = a\\\n   b\nKEY = v'],
  ])('%s is value text', (_name, text) => {
    expect(kinds(text)).toEqual(['directive', 'text', 'directive']);
  });

  it('carries on through further lines that end in a backslash, then stops', () => {
    expect(kinds('REGEX = a\\\n[b]\\\n# c\\\n[d]\nKEY = v\n[st]')).toEqual([
      'directive', 'text', 'text', 'text', 'directive', 'header',
    ]);
  });

  it('a line that is only a backslash keeps the value going', () => {
    expect(kinds('REGEX = a\\\n\\\n[x]\nKEY = v')).toEqual(['directive', 'text', 'text', 'directive']);
  });

  it('an even run of backslashes is escaped text, not a continuation', () => {
    expect(kinds('REGEX = C:\\\\\n[st]')).toEqual(['directive', 'header']);
    expect(kinds('REGEX = a\\\\\\\n[x]\nKEY = v')).toEqual(['directive', 'text', 'directive']);
  });

  it('a backslash followed by a space is literal, not a continuation', () => {
    expect(kinds('REGEX = a\\ \n[st]')).toEqual(['directive', 'header']);
    expect(kinds('REGEX = a\\\t\n# c')).toEqual(['directive', 'comment']);
  });

  it('an empty line ends the value', () => {
    expect(kinds('REGEX = a\\\n\n[st]')).toEqual(['directive', 'text', 'header']);
  });

  it('applies to every kind of value', () => {
    for (const head of ['KEY', 'EVAL-x', 'INGEST_EVAL', 'EXTRACT-a', 'FIELDALIAS-a', 'TRANSFORMS-a', 'LOOKUP-a', 'REGEX', 'plain key']) {
      expect(kinds(`${head} = a\\\n[x]\\\n# y\nOTHER = z`), head).toEqual(['directive', 'text', 'text', 'directive']);
    }
  });

  it('still highlights the continuation line by the kind of value', () => {
    const [, second] = tokenize('EXTRACT-a = (?<x>\\\\d+)\\\n  (?:[a-z]+)\\d');
    const types = new Set(second?.map((p) => p.type));
    expect(types.has('regexp')).toBe(true);
    expect(types.has('regexp.escape')).toBe(true);
  });

  it('colours the trailing backslash', () => {
    const [first] = tokenize('REGEX = a\\\nb');
    expect(first?.at(-1)).toEqual({ type: 'escape', text: '\\' });
  });
});

describe('an indented directive is not a directive', () => {
  it('starts no value and no continuation', () => {
    expect(kinds('  KEY = a\\\n[st]')).toEqual(['text', 'header']);
  });
});

// ── The grammar and parseConf read generated files alike (#516) ─────────────

fc.configureGlobal({ seed: 516, numRuns: 300 });

const fragment = fc.constantFrom('a', 'b c', '[x]', '#', '=', '(?<n>\\d+)', 'v=1', ']', '[', ' ');
const tail = fc.constantFrom('', '', '\\', '\\\\', '\\\\\\', '\\ ', ' ');

/** One line of a generated file: what it is meant to be, and its text (each line numbered). */
const line = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(fc.constantFrom('KEY', 'EXTRACT-a', 'REGEX', 'EVAL-x', 'FIELDALIAS-y', 'TRANSFORMS-z', 'LOOKUP-l', 'other_key', 'a key'), fragment, tail).map(([k, f, t]) => (i: number) => `${k} = ${f}~${i}~${t}`) },
  { weight: 2, arbitrary: fc.constant((i: number) => `[stanza~${i}~]`) },
  { weight: 2, arbitrary: fc.tuple(fragment, tail).map(([f, t]) => (i: number) => `#${f}~${i}~${t}`) },
  { weight: 1, arbitrary: fc.tuple(fc.constantFrom('  ', '\t', ''), fragment, tail).map(([ws, f, t]) => (i: number) => `${ws}${f}~${i}~${t}`) },
  { weight: 1, arbitrary: fc.constant(() => '') },
);

describe('the tokenizer and parseConf agree on the lines of a generated file', () => {
  it('on which lines are headers, comments, directives and continuations', () => {
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 12 }), (makers) => {
        const lines = makers.map((make, i) => make(i));
        const text = lines.join('\n');

        const conf = parseConf(text, 'props.conf');
        // (An implicit [default] for directives before any header has no header line.)
        const headers = new Set(
          conf.stanzas.filter((s) => lines[s.lineRange.start - 1]?.startsWith('[')).map((s) => s.lineRange.start),
        );
        const directives = new Set(conf.stanzas.flatMap((s) => s.directives.map((d) => d.line)));
        // A continuation line is one whose marker landed inside a directive's joined value.
        const continuations = new Set<number>();
        for (const stanza of conf.stanzas) {
          for (const d of stanza.directives) {
            for (const m of d.value.matchAll(/~(\d+)~/g)) {
              const at = Number(m[1]) + 1;
              if (at !== d.line) continuations.add(at);
            }
          }
        }

        const actual = kinds(text);
        lines.forEach((l, i) => {
          const n = i + 1;
          // One deliberate difference: a line that starts with `[` but is not a well-formed
          // header (`[abc`) is malformed to the parser, and is coloured as a header while it is
          // being typed. The diagnostics are what flag it.
          const expected: Kind = continuations.has(n)
            ? 'text'
            : headers.has(n) || l.startsWith('[') ? 'header' : directives.has(n) ? 'directive' : l.startsWith('#') ? 'comment' : 'text';
          expect(actual[i], `line ${n} ${JSON.stringify(l)} in ${JSON.stringify(text)}`).toBe(expected);
        });
      }),
    );
  });
});
