// ---------------------------------------------------------------------------
// splunkConfCodeActions.test.ts
// The mis-cased-attribute quick fix.
//
// The fix is only useful if it edits the key and nothing else, so most of what
// is asserted here is what the edit leaves alone.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import type { editor, languages, Range } from 'monaco-editor';
import { createCodeActionProvider } from '../splunkConfCodeActions';
import { computeDiagnostics, MISCASED_MARKER_CODE } from '../splunkConfDiagnostics';
import { fakeModel } from '../../test/fakeModel';

/**
 * Run the real linter, then feed its markers to the provider the way Monaco
 * does — the coupling between the two is the thing worth testing, so the
 * markers are never hand-written.
 */
function actionsFor(text: string, fileType: 'props.conf' | 'transforms.conf' = 'props.conf') {
  const model = fakeModel(text);
  const markers: editor.IMarkerData[] = computeDiagnostics(model, fileType);
  const wholeFile = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 } as Range;

  const context: languages.CodeActionContext = { markers, trigger: 1 };
  const provider = createCodeActionProvider(fileType);
  const result = provider.provideCodeActions(model, wholeFile, context, {
    isCancellationRequested: false,
    onCancellationRequested: () => ({ dispose: () => undefined }),
  });
  return (result as languages.CodeActionList | undefined)?.actions ?? [];
}

function edit(action: languages.CodeAction) {
  const first = action.edit?.edits[0] as unknown as {
    textEdit: { text: string; range: { startColumn: number; endColumn: number; startLineNumber: number } };
  };
  return first.textEdit;
}

describe('mis-cased attribute quick fix (#89)', () => {
  it('offers the canonical spelling for a mis-cased attribute', () => {
    const actions = actionsFor('[st]\ntime_format = %s');
    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe('Change "time_format" to "TIME_FORMAT"');
    expect(actions[0]?.kind).toBe('quickfix');
  });

  it('replaces only the key, leaving the value untouched', () => {
    const textEdit = edit(actionsFor('[st]\ntime_format = %s')[0]!);
    expect(textEdit.text).toBe('TIME_FORMAT');
    expect(textEdit.range.startLineNumber).toBe(2);
    // `time_format` is columns 1-11, so the edit ends before the space and `=`.
    expect(textEdit.range.startColumn).toBe(1);
    expect(textEdit.range.endColumn).toBe(1 + 'time_format'.length);
  });

  it('fixes a mis-cased class prefix without touching the class name', () => {
    const actions = actionsFor('[st]\nextract-myField = (?<a>\\w+)');
    expect(actions[0]?.title).toBe('Change "extract-myField" to "EXTRACT-myField"');
    const textEdit = edit(actions[0]!);
    // The class name keeps its own casing — only the prefix was wrong.
    expect(textEdit.text).toBe('EXTRACT-myField');
  });

  it('offers nothing for a correctly-cased attribute', () => {
    expect(actionsFor('[st]\nTIME_FORMAT = %s')).toEqual([]);
    expect(actionsFor('[st]\nEXTRACT-myField = (?<a>\\w+)')).toEqual([]);
  });

  it('offers nothing for a key that is not an attribute at all', () => {
    expect(actionsFor('[st]\nNOT_A_REAL_DIRECTIVE = 1')).toEqual([]);
  });

  it('scopes the suggestion to the file being edited', () => {
    // FORMAT is a transforms.conf attribute; a mis-cased one in props.conf has
    // no canonical spelling to offer because it would be wrong there anyway.
    expect(actionsFor('[t1]\nformat = $1', 'transforms.conf')[0]?.title).toBe('Change "format" to "FORMAT"');
    expect(actionsFor('[st]\nformat = $1', 'props.conf')).toEqual([]);
  });

  it('attaches the marker it fixes, so Monaco can dismiss it', () => {
    const action = actionsFor('[st]\ntime_format = %s')[0]!;
    expect(action.diagnostics?.[0]?.code).toBe(MISCASED_MARKER_CODE);
  });

  it('ignores markers it did not produce', () => {
    // An invalid regex is an error with no quick fix; the provider must not
    // offer a rename against it.
    expect(actionsFor('[t1]\nREGEX = (unbalanced', 'transforms.conf')).toEqual([]);
  });
});
