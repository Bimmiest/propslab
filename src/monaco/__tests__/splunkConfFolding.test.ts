import { describe, it, expect, vi } from 'vitest';
import type { editor, languages } from 'monaco-editor';
import { createFoldingRangeProvider } from '../splunkConfFolding';

// The real editor API touches `window` on import; only the kind constants are used.
vi.mock('monaco-editor/editor/editor.api', () => ({
  languages: {
    FoldingRangeKind: { Region: { value: 'region' }, Comment: { value: 'comment' } },
  },
}));

function fold(text: string) {
  const lines = text.split('\n');
  const model = {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as editor.ITextModel;
  const ranges = createFoldingRangeProvider().provideFoldingRanges(
    model,
    {},
    {} as never,
  ) as languages.FoldingRange[];
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
});
