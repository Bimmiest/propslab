// ---------------------------------------------------------------------------
// splunkConfCodeActions.ts
// Quick fixes for the markers computeDiagnostics produces.
//
// Only one so far: renaming a mis-cased attribute to its canonical spelling.
// It is the fix worth making one click because the diagnostic already
// knows the exact answer -- `time_format` can only have meant `TIME_FORMAT` --
// and because the failure it prevents is invisible: Splunk ignores the line and
// the default applies, so nothing about the config's behaviour says it is dead.
// ---------------------------------------------------------------------------

import type { editor, languages, IRange } from 'monaco-editor';
import { MISCASED_MARKER_CODE } from './splunkConfDiagnostics';
import { miscasedCanonical } from '../engine/parser/confParser';
import { DIRECTIVE_RE } from '../engine/parser/confParser';

/**
 * The range covering just the key on a directive line, so the edit replaces the
 * attribute name and leaves the value, spacing and any comment untouched.
 * Returns undefined when the line is not a directive after all -- the model can
 * have changed since the marker was computed.
 */
function keyRange(model: editor.ITextModel, lineNumber: number): { range: IRange; key: string } | undefined {
  const line = model.getLineContent(lineNumber);
  const match = DIRECTIVE_RE.exec(line);
  if (!match) return undefined;

  const rawKey = (match[1] ?? '').trim();
  if (rawKey === '') return undefined;

  // Column of the first character of the key, 1-based. The regex allows no
  // leading whitespace, so indexOf finds the key itself rather than a value
  // that happens to repeat it.
  const startColumn = line.indexOf(rawKey) + 1;
  return {
    key: rawKey,
    range: {
      startLineNumber: lineNumber,
      endLineNumber: lineNumber,
      startColumn,
      endColumn: startColumn + rawKey.length,
    },
  };
}

export function createCodeActionProvider(
  fileType: 'props.conf' | 'transforms.conf',
): languages.CodeActionProvider {
  return {
    provideCodeActions(model, _range, context) {
      const actions: languages.CodeAction[] = [];

      for (const marker of context.markers) {
        if (marker.code !== MISCASED_MARKER_CODE) continue;

        const found = keyRange(model, marker.startLineNumber);
        if (!found) continue;

        // Re-derive rather than trusting the marker's message: the user may have
        // edited the line since it was computed, and renaming to a stale
        // canonical would be a worse outcome than offering nothing.
        const canonical = miscasedCanonical(found.key, fileType);
        if (canonical === undefined) continue;

        actions.push({
          title: `Change "${found.key}" to "${canonical}"`,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: true,
          edit: {
            edits: [
              {
                resource: model.uri,
                versionId: model.getVersionId(),
                textEdit: { range: found.range, text: canonical },
              },
            ],
          },
        });
      }

      return { actions, dispose: () => undefined };
    },
  };
}
