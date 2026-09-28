import type { languages, editor, CancellationToken } from 'monaco-editor';
// Value import from the slim entry only — a value import from the `monaco-editor`
// barrel would drag editor.main (every language + its web worker) into the
// bundle. See the import comment in MonacoEditor.tsx.
import { languages as monacoLanguages } from 'monaco-editor/editor';

export function createFoldingRangeProvider(): languages.FoldingRangeProvider {
  return {
    provideFoldingRanges(
      model: editor.ITextModel,
      _context: languages.FoldingContext,
      _token: CancellationToken
    ): languages.ProviderResult<languages.FoldingRange[]> {
      const ranges: languages.FoldingRange[] = [];
      const lineCount = model.getLineCount();

      let stanzaStart: number | null = null;

      for (let i = 1; i <= lineCount; i++) {
        const line = model.getLineContent(i).trim();

        if (line.startsWith('[') && line.endsWith(']')) {
          // Close previous stanza
          if (stanzaStart !== null) {
            // Find last non-empty line before this stanza header
            let end = i - 1;
            while (end > stanzaStart && model.getLineContent(end).trim() === '') {
              end--;
            }
            if (end > stanzaStart) {
              ranges.push({
                start: stanzaStart,
                end,
                kind: monacoLanguages.FoldingRangeKind.Region,
              });
            }
          }
          stanzaStart = i;
        }
      }

      // Close the last stanza
      if (stanzaStart !== null) {
        let end = lineCount;
        while (end > stanzaStart && model.getLineContent(end).trim() === '') {
          end--;
        }
        if (end > stanzaStart) {
          ranges.push({
            start: stanzaStart,
            end,
            kind: monacoLanguages.FoldingRangeKind.Region,
          });
        }
      }

      // Also fold comment blocks
      let commentStart: number | null = null;
      for (let i = 1; i <= lineCount; i++) {
        const line = model.getLineContent(i).trim();
        const isComment = line.startsWith('#'); // `;` is NOT a Splunk .conf comment

        if (isComment && commentStart === null) {
          commentStart = i;
        } else if (!isComment && commentStart !== null) {
          if (i - 1 > commentStart) {
            ranges.push({
              start: commentStart,
              end: i - 1,
              kind: monacoLanguages.FoldingRangeKind.Comment,
            });
          }
          commentStart = null;
        }
      }
      // Flush a comment block that runs to the end of the file (the loop above
      // only closes a block when a non-comment line follows it).
      if (commentStart !== null && lineCount > commentStart) {
        ranges.push({
          start: commentStart,
          end: lineCount,
          kind: monacoLanguages.FoldingRangeKind.Comment,
        });
      }

      return ranges;
    },
  };
}
