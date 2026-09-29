// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// The fake ITextModel the provider tests share, held against a real Monaco text
// model. If the two ever disagree on a line, a word or the EOL, a provider test
// is passing against behaviour the editor does not have.
//
// monaco-editor's editor.createModel runs under jsdom for a plain text model,
// so this needs no browser. Importing the editor is slow the first time, hence
// the generous timeout.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import type { editor } from 'monaco-editor';
import { fakeModel } from './fakeModel';

type Monaco = typeof import('monaco-editor/editor');
let monaco: Monaco;
const created: editor.ITextModel[] = [];

beforeAll(async () => {
  monaco = await import('monaco-editor/editor');
}, 120_000);

afterAll(() => {
  for (const model of created) model.dispose();
});

function real(text: string): editor.ITextModel {
  const model = monaco.editor.createModel(text, 'plaintext');
  created.push(model);
  return model;
}

const SAMPLES = [
  '',
  'KV_MODE = json',
  '[my:sourcetype]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y-%m-%d',
  'a\rb\r\nc',
  'a\r\nb\r\nc\n',
  'one\rtwo\rthree',
  'x\n\n\ny\n',
  'EXTRACT-a = (?<f>\\d+)\\\n  more',
  'v = 1.5e3 -x .5y foo_bar-baz',
  '\n',
  '\r\r',
  '\r\n',
];
// Not sampled: a text that is exactly one lone CR. Monaco's buffer builder holds a
// trailing CR back and, for that one input, counts it twice (3 lines, not 2).
// Nothing an editor holds is ever that text, so the fake does not copy the quirk.

/** Every position on every line, ends included. */
function positions(model: editor.ITextModel): { lineNumber: number; column: number }[] {
  const out: { lineNumber: number; column: number }[] = [];
  for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber++) {
    const max = model.getLineContent(lineNumber).length + 1;
    for (let column = 1; column <= max; column++) out.push({ lineNumber, column });
  }
  return out;
}

function expectSameModel(text: string): void {
  const fake = fakeModel(text);
  const actual = real(text);
  expect(fake.getLineCount(), `line count of ${JSON.stringify(text)}`).toBe(actual.getLineCount());
  expect(fake.getEOL(), `EOL of ${JSON.stringify(text)}`).toBe(actual.getEOL());
  expect(fake.getValue(), `value of ${JSON.stringify(text)}`).toBe(actual.getValue());
  for (let n = 1; n <= actual.getLineCount(); n++) {
    expect(fake.getLineContent(n)).toBe(actual.getLineContent(n));
  }
  for (const position of positions(actual)) {
    expect(fake.getWordAtPosition(position), `word at ${JSON.stringify(position)}`).toEqual(
      actual.getWordAtPosition(position),
    );
    expect(fake.getWordUntilPosition(position), `word until ${JSON.stringify(position)}`).toEqual(
      actual.getWordUntilPosition(position),
    );
  }
}

describe('fakeModel matches a real Monaco text model', () => {
  it.each(SAMPLES)('on %j', (text) => {
    expectSameModel(text);
  });

  it('splits a bare CR into lines and reads it back with the model EOL', () => {
    const fake = fakeModel('a\rb\r\nc');
    expect(fake.getLineCount()).toBe(3);
    expect(fake.getLineContent(2)).toBe('b');
    expect(fake.getValue()).toBe('a\r\nb\r\nc');
  });

  it('on generated text made of words, punctuation and every kind of line break', () => {
    const piece = fc.constantFrom('ab', 'K_V', '1.5', '-x', ' ', '=', '[', ']', '%Y', '\\', '\n', '\r\n', '\r', '.5z');
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 10 }), (parts) => {
        const text = parts.join('');
        if (text !== '\r') expectSameModel(text);
      }),
      { numRuns: 60, seed: 516 },
    );
  }, 60_000);
});
