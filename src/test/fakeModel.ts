// ---------------------------------------------------------------------------
// fakeModel.ts
// The one ITextModel stand-in the Monaco provider tests share.
//
// It implements only what the providers read, but it implements it the way
// Monaco's own text model does, so a provider test cannot pass on a line split
// or a word boundary the real editor would not produce:
//
//   - lines end at LF, CRLF or a bare CR (the real model splits on all three,
//     and none of them is part of a line's content);
//   - the model's EOL is CRLF when more than half of the line breaks are CRLF
//     or bare CR, else LF (`PieceTreeTextBufferFactory._getEOL`), and getValue()
//     joins the lines with it, so a bare CR reads back as that EOL;
//   - the word at a position is Monaco's default word definition, matched the
//     way `getWordAtText` does, so a caret at the end of a word is in the word.
//
// `fakeModel.contract.test.ts` holds this against a real model.
// ---------------------------------------------------------------------------

import type { editor, IPosition, Uri } from 'monaco-editor';

/** Monaco's DEFAULT_WORD_REGEX: what a language without its own `wordPattern` uses. */
const DEFAULT_WORD = /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

export interface FakeModelOptions {
  /** Answer every getWordAtPosition with this, instead of deriving it from the text. */
  word?: editor.IWordAtPosition | null;
  /** The model's URI string, for the code action provider. */
  uri?: string;
}

/** Line breaks of `text` as the model's buffer splits them. */
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/** The EOL Monaco picks for `text` when it has no preference. */
function detectEol(text: string): '\n' | '\r\n' {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lone = (text.replace(/\r\n/g, '').match(/[\r\n]/g) ?? []).length;
  const cr = (text.replace(/\r\n/g, '').match(/\r/g) ?? []).length;
  const total = crlf + lone;
  return total > 0 && cr + crlf > total / 2 ? '\r\n' : '\n';
}

/** `getWordAtText`: the word match containing `column` (its end included), or null. */
function wordAt(line: string, column: number): editor.IWordAtPosition | null {
  const offset = column - 1;
  for (const match of line.matchAll(DEFAULT_WORD)) {
    const start = match.index;
    const end = start + match[0].length;
    if (start <= offset && offset <= end) return { word: match[0], startColumn: start + 1, endColumn: end + 1 };
    if (start > offset) break;
  }
  return null;
}

export function fakeModel(text: string, options: FakeModelOptions = {}): editor.ITextModel {
  const lines = splitLines(text);
  const eol = detectEol(text);
  const getWordAtPosition = (position: IPosition): editor.IWordAtPosition | null =>
    options.word !== undefined ? options.word : wordAt(lines[position.lineNumber - 1] ?? '', position.column);

  const model = {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
    getLinesContent: () => [...lines],
    getValue: () => lines.join(eol),
    getEOL: () => eol,
    getVersionId: () => 1,
    getWordAtPosition,
    getWordUntilPosition: (position: IPosition): editor.IWordAtPosition => {
      const word = getWordAtPosition(position);
      if (!word) return { word: '', startColumn: position.column, endColumn: position.column };
      return {
        word: word.word.slice(0, position.column - word.startColumn),
        startColumn: word.startColumn,
        endColumn: position.column,
      };
    },
    uri: { toString: () => options.uri ?? 'inmemory://model/1' } as unknown as Uri,
  };
  return model as unknown as editor.ITextModel;
}
