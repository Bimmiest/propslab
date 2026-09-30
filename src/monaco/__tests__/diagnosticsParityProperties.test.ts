// ---------------------------------------------------------------------------
// diagnosticsParityProperties.test.ts
// Property: the editor's linter and confParser read every generated file the
// same way — the same lines are directives, the same lines are malformed, and
// a continued directive has the same value in both.
//
// Files are generated line by line from everything a conf line can be: stanza
// headers (well-formed, unclosed, indented, with trailing whitespace),
// directives (indented or not, values holding `=`, `#` and backslashes, a
// trailing continuation backslash with or without whitespace after it),
// comments (indented or not), blank lines and arbitrary text, joined with LF or
// CRLF. Each property states which reading both must share; the example tests
// in diagnosticsParity.test.ts pin the individual cases.
//
// The linter reports directives only through markers, so the generated keys
// are ones whose marker names the line and value: unknown keys (an "Unknown
// directive" info on the key's line) and MAX_EVENTS with a non-numeric value
// (a warning that quotes the joined value).
//
// The seed is fixed so a run is reproducible.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { computeDiagnostics } from '../splunkConfDiagnostics';
import { fakeModel } from '../../test/fakeModel';
import { parseConf } from '../../engine/parser/confParser';
import { fcSeed } from '../../test/fcSeed';
import { isIntegerLiteral } from '../../engine/utils/directiveValues';

fc.configureGlobal({ seed: fcSeed(371), numRuns: 300 });

const model = fakeModel;

const ws = fc.constantFrom('', ' ', '\t', '  ');
const valueText = fc
  .array(fc.constantFrom('a', '1', ' ', '=', '#', '\\', '[', ']', 'x y'), { maxLength: 8 })
  .map((cs) => cs.join(''));
const directiveKey = fc.constantFrom('k1', 'my_key', 'key two', 'a.b', 'MAX_EVENTS');

const line = fc.oneof(
  // Directives, possibly indented, possibly continued (with junk after the `\`).
  fc
    .tuple(ws, directiveKey, ws, ws, valueText, fc.constantFrom('', '\\', '\\ ', '\\\\', '\\\t'))
    .map(([indent, k, a, b, v, tail]) => `${indent}${k}${a}=${b}${v}${tail}`),
  // Stanza headers, well-formed or not.
  fc
    .tuple(
      ws,
      fc.constantFrom('s', 'a b', 'source::x', 'x=y'),
      fc.constantFrom(']', '', '] ', ']x'),
      fc.constantFrom('', '\\'),
    )
    .map(([indent, name, close, tail]) => `${indent}[${name}${close}${tail}`),
  // Comments and blanks.
  fc.tuple(ws, fc.constantFrom('#', '# c', '# k = v', '# \\')).map(([indent, c]) => `${indent}${c}`),
  ws,
  // Anything else.
  valueText,
);

const file = fc
  .array(fc.tuple(line, fc.constantFrom('\n', '\r\n')), { maxLength: 14 })
  .map((ls) => ls.map(([l, eol]) => l + eol).join(''));

const MALFORMED = /Malformed line|Missing closing bracket|Empty stanza header/;

describe('computeDiagnostics and confParser read generated files alike', () => {
  it('agree on which lines are directives', () => {
    fc.assert(
      fc.property(file, (text) => {
        const engine = parseConf(text, 'props.conf')
          .stanzas.flatMap((s) => s.directives)
          .filter((d) => d.key !== 'MAX_EVENTS')
          .map((d) => d.line);
        const linter = computeDiagnostics(model(text), 'props.conf')
          .filter((m) => /^Unknown directive/.test(m.message))
          .map((m) => m.startLineNumber);
        expect(new Set(linter)).toEqual(new Set(engine));
      }),
    );
  });

  it('agree on which lines are malformed', () => {
    fc.assert(
      fc.property(file, (text) => {
        const engine = parseConf(text, 'props.conf')
          .errors.filter((e) => e.level === 'error')
          .map((e) => e.line);
        const linter = computeDiagnostics(model(text), 'props.conf')
          .filter((m) => MALFORMED.test(m.message))
          .map((m) => m.startLineNumber);
        expect(linter.sort()).toEqual(engine.sort());
      }),
    );
  });

  it('agree on the value of a continued directive', () => {
    fc.assert(
      fc.property(file, (text) => {
        // The linter validates the value trimmed, as the engine reads it.
        const engine = parseConf(text, 'props.conf')
          .stanzas.flatMap((s) => s.directives)
          .filter((d) => d.key === 'MAX_EVENTS' && d.value.trim() !== '' && !isIntegerLiteral(d.value))
          .map((d) => `${d.line}:${d.value.trim()}`);
        const linter = computeDiagnostics(model(text), 'props.conf')
          .filter((m) => m.message.startsWith('Expected an integer for "MAX_EVENTS"'))
          .map((m) => `${m.startLineNumber}:${/got "([\s\S]*)"$/.exec(m.message)?.[1]}`);
        expect(linter.sort()).toEqual(engine.sort());
      }),
    );
  });
});
