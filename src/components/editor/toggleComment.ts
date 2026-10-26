// ---------------------------------------------------------------------------
// toggleComment.ts
// Comment out lines of a conf file, or uncomment them (#762). One function for
// the editors' context menu and their Ctrl+/ keybinding; Monaco's own comment
// action needs a contribution this build does not load.
// ---------------------------------------------------------------------------

import type { editor } from 'monaco-editor';

/** The id SplunkEditor registers the Ctrl+/ action under. */
export const TOGGLE_COMMENT_ACTION = 'propslab.toggleComment';

/**
 * Comment out the selected lines, or the cursor's line, with `# `. When every
 * non-blank one is a comment already, take the `#` (and one space after it)
 * off instead. Blank lines are left alone. One undo step.
 */
export function toggleComment(ed: editor.ICodeEditor): void {
  const model = ed.getModel();
  const selection = ed.getSelection();
  if (!model || !selection) return;
  const first = selection.startLineNumber;
  // A selection that ends at the start of a line does not take that line.
  const last =
    selection.endColumn === 1 && selection.endLineNumber > first
      ? selection.endLineNumber - 1
      : selection.endLineNumber;
  const lines: number[] = [];
  for (let n = first; n <= last; n++) if (model.getLineContent(n).trim() !== '') lines.push(n);
  if (lines.length === 0) return;

  const uncomment = lines.every((n) => /^\s*#/.test(model.getLineContent(n)));
  const edits = lines.map((n) => {
    if (!uncomment)
      return { range: { startLineNumber: n, startColumn: 1, endLineNumber: n, endColumn: 1 }, text: '# ' };
    const [, indent = '', space = ''] = /^(\s*)#( ?)/.exec(model.getLineContent(n)) ?? [];
    const start = indent.length + 1;
    return {
      range: { startLineNumber: n, startColumn: start, endLineNumber: n, endColumn: start + 1 + space.length },
      text: '',
    };
  });
  ed.pushUndoStop();
  ed.executeEdits('toggle-comment', edits);
  ed.pushUndoStop();
}
