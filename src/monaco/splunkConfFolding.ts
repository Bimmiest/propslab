import type { languages, editor, CancellationToken } from 'monaco-editor';
// Value import from the slim entry only — a value import from the `monaco-editor`
// barrel would drag editor.main (every language + its web worker) into the
// bundle. See the import comment in MonacoEditor.tsx.
import { languages as monacoLanguages } from 'monaco-editor/editor';
import { DIRECTIVE_RE, STANZA_RE } from '../engine/parser/confParser';
import { endsWithContinuation } from '../engine/utils/directiveValues';

type LineKind = 'header' | 'comment' | 'other';

/**
 * What each line is, read the way confParser reads it (index 0 is line 1).
 *
 * A directive whose line ends in an odd run of backslashes owns the lines that
 * follow it, whatever they look like: a continued regex ending in `]` is not a
 * stanza header and a `#` line inside a value is not a comment. Headers and
 * comments are recognised on the UNTRIMMED line (`STANZA_RE`, and `#` in
 * column 0), so `[]` and an indented `[x]` are neither, as they are not to the
 * parser.
 */
function classifyLines(model: editor.ITextModel): LineKind[] {
  const kinds: LineKind[] = [];
  let inValue = false;
  for (let i = 1; i <= model.getLineCount(); i++) {
    const line = model.getLineContent(i);
    if (inValue) {
      inValue = endsWithContinuation(line);
      kinds.push('other');
    } else if (line.startsWith('#')) {
      kinds.push('comment');
    } else if (STANZA_RE.test(line)) {
      kinds.push('header');
    } else {
      inValue = DIRECTIVE_RE.test(line) && endsWithContinuation(line);
      kinds.push('other');
    }
  }
  return kinds;
}

export function createFoldingRangeProvider(): languages.FoldingRangeProvider {
  return {
    provideFoldingRanges(
      model: editor.ITextModel,
      _context: languages.FoldingContext,
      _token: CancellationToken,
    ): languages.ProviderResult<languages.FoldingRange[]> {
      const ranges: languages.FoldingRange[] = [];
      const lineCount = model.getLineCount();
      const kinds = classifyLines(model);
      const kindAt = (line: number) => kinds[line - 1];

      let stanzaStart: number | null = null;

      for (let i = 1; i <= lineCount; i++) {
        if (kindAt(i) === 'header') {
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
        const isComment = kindAt(i) === 'comment'; // `;` is NOT a Splunk .conf comment

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
