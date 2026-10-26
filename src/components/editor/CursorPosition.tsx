// ---------------------------------------------------------------------------
// CursorPosition.tsx
// The cursor's line and column, and the length of the selection, under an
// editor (#740). A user reads the offset for MAX_TIMESTAMP_LOOKAHEAD,
// TRUNCATE or a fixed-width regex here rather than counting characters.
// ---------------------------------------------------------------------------

import { useCallback, useSyncExternalStore } from 'react';
import type { editor } from 'monaco-editor';
import { cursorStats, formatCursorStats, type CursorStats } from './cursorStats';

function read(instance: editor.IStandaloneCodeEditor): CursorStats | null {
  const model = instance.getModel();
  const selection = instance.getSelection();
  if (!model || !selection) return null;
  // The selection's position end is where the cursor is, whichever way it was dragged.
  const { positionLineNumber: line, positionColumn: column } = selection;
  const beforeCursor = model.getLineContent(line).slice(0, column - 1);
  return cursorStats(line, beforeCursor, selection.isEmpty() ? '' : model.getValueInRange(selection));
}

export function CursorPosition({
  editor: instance,
  withBytes = false,
}: {
  editor: editor.IStandaloneCodeEditor | null;
  withBytes?: boolean;
}) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!instance) return () => {};
      // Content too: an edit earlier on the line, or a loaded example, moves
      // the offset without moving the cursor.
      const subscriptions = [instance.onDidChangeCursorSelection(onChange), instance.onDidChangeModelContent(onChange)];
      return () => {
        for (const s of subscriptions) s.dispose();
      };
    },
    [instance],
  );
  // A string snapshot, so an unchanged position does not render again.
  const text = useSyncExternalStore(subscribe, () => {
    const stats = instance && read(instance);
    return stats ? formatCursorStats(stats, withBytes) : '';
  });
  if (!text) return null;
  return (
    <span
      className="tabular-nums whitespace-nowrap text-[var(--color-text-muted)]"
      title={withBytes ? 'Col counts characters. Byte counts UTF-8 bytes, as TRUNCATE does.' : 'Col counts characters.'}
    >
      {text}
    </span>
  );
}
