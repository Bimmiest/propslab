import { describe, it, expect, vi } from 'vitest';
import type { languages } from 'monaco-editor';
import { fakeModel } from '../../test/fakeModel';
import { createFoldingRangeProvider } from '../splunkConfFolding';

// The real editor API touches `window` on import; only the kind constants are used.
vi.mock('monaco-editor/editor', () => ({
  languages: {
    FoldingRangeKind: { Region: { value: 'region' }, Comment: { value: 'comment' } },
  },
}));

function fold(text: string) {
  const model = fakeModel(text);
  const ranges = createFoldingRangeProvider().provideFoldingRanges(model, {}, {} as never) as languages.FoldingRange[];
  return ranges.map(({ start, end, kind }) => ({ start, end, kind: kind?.value }));
}

describe('splunkConfFolding', () => {
  it('folds each stanza up to its last non-blank line', () => {
    expect(fold('[a]\nX = 1\nY = 2\n\n[b]\nZ = 3\n\n')).toEqual([
      { start: 1, end: 3, kind: 'region' },
      { start: 5, end: 6, kind: 'region' },
    ]);
  });

  it('does not fold a stanza with no body', () => {
    expect(fold('[a]\n\n[b]')).toEqual([]);
  });

  it('folds runs of two or more # comment lines, including one at the end of the file', () => {
    expect(fold('# one\n# two\nX = 1\n# lone\nY = 2\n# a\n# b')).toEqual([
      { start: 1, end: 2, kind: 'comment' },
      { start: 6, end: 7, kind: 'comment' },
    ]);
  });

  it('does not treat ; as a comment', () => {
    expect(fold('; a\n; b')).toEqual([]);
  });

  it('reads a header the way the parser does: trailing whitespace is fine', () => {
    expect(fold('[a] \nX = 1\n[b]\nY = 2')).toEqual([
      { start: 1, end: 2, kind: 'region' },
      { start: 3, end: 4, kind: 'region' },
    ]);
  });

  it('does not start a fold at `[]` or at an indented header, which the parser does not read as one', () => {
    expect(fold('[a]\nX = 1\n[]\nY = 2\n  [b]\nZ = 3')).toEqual([{ start: 1, end: 6, kind: 'region' }]);
  });

  it('does not start a fold at a continued regex ending in `]`', () => {
    expect(fold('[a]\nEXTRACT-x = (?<n>\\d+)\\\n[a-z]\nY = 2\n[b]\nZ = 3')).toEqual([
      { start: 1, end: 4, kind: 'region' },
      { start: 5, end: 6, kind: 'region' },
    ]);
  });

  it('does not read a `#` line inside a continued value as a comment', () => {
    expect(fold('K = a\\\n# not\\\n# a comment\nL = b')).toEqual([]);
  });

  it('an even run of backslashes ends the value, so the next line is read normally', () => {
    expect(fold('[a]\nP = C:\\\\\n[b]\nX = 1')).toEqual([
      { start: 1, end: 2, kind: 'region' },
      { start: 3, end: 4, kind: 'region' },
    ]);
  });

  it('a malformed line or a comment ending in a backslash starts no continuation', () => {
    expect(fold('garbage\\\n[b]\nX = 1\n# c\\\n# d')).toEqual([
      { start: 2, end: 5, kind: 'region' },
      { start: 4, end: 5, kind: 'comment' },
    ]);
  });
});
