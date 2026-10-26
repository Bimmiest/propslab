// ---------------------------------------------------------------------------
// EditorContextMenu.tsx
// The editors' right-click menu (#745), the app's shared ContextMenu rather
// than Monaco's own, which this build does not load and which would look and
// behave unlike every other menu here. Shift+F10 and the Menu key open it as
// well: the browser sends the contextmenu event to Monaco's focused textarea,
// and it bubbles to the trigger.
// ---------------------------------------------------------------------------

import type { PointerEvent, ReactNode } from 'react';
import type { editor } from 'monaco-editor';
import { useAppStore } from '../../store/useAppStore';
import { getDirectiveInfo } from '../../engine/directiveRegistry';
import { copyQuietly, copyToClipboard } from '../../utils/clipboard';
import { getModifierName } from '../../utils/platform';
import { openCommandPalette, openScaffold } from '../ui/appActions';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../ui/ContextMenu';

type EditorFile = 'raw' | 'props.conf' | 'transforms.conf';

export function EditorContextMenu({
  editor: instance,
  file,
  children,
}: {
  editor: editor.IStandaloneCodeEditor | null;
  file: EditorFile;
  children: ReactNode;
}) {
  // A right-click moves the cursor to where it lands, unless it lands in the
  // selection, which the menu then acts on, as in VS Code. On the pointer, not
  // the contextmenu event: one from the keyboard carries the element's
  // position, not the cursor's.
  const onPointerDownCapture = (e: PointerEvent) => {
    if (e.button !== 2 || !instance) return;
    const position = instance.getTargetAtClientPoint(e.clientX, e.clientY)?.position;
    if (position && !instance.getSelection()?.containsPosition(position)) instance.setPosition(position);
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger disabled={!instance}>
        <div className="h-full" onPointerDownCapture={onPointerDownCapture}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{instance && <EditorMenuItems editor={instance} file={file} />}</ContextMenuContent>
    </ContextMenu>
  );
}

/** The directive key on the cursor's line, as the dictionary names it, or undefined. */
function directiveOnLine(line: string, file: 'props.conf' | 'transforms.conf'): string | undefined {
  const eq = line.indexOf('=');
  if (eq <= 0 || /^\s*[#[]/.test(line)) return undefined;
  return getDirectiveInfo(line.slice(0, eq).trim(), file)?.key;
}

/** Rendered only while the menu is open, so it reads the editor as it is now. */
function EditorMenuItems({ editor: ed, file }: { editor: editor.IStandaloneCodeEditor; file: EditorFile }) {
  const openDictionaryAt = useAppStore((s) => s.openDictionaryAt);
  const mod = getModifierName();
  const model = ed.getModel();
  const selection = ed.getSelection();
  const selected = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
  const position = ed.getPosition();
  const directive =
    file !== 'raw' && model && position ? directiveOnLine(model.getLineContent(position.lineNumber), file) : undefined;
  // Absent outside a secure context, whatever the DOM types say.
  const canPaste = (navigator as { clipboard?: Clipboard }).clipboard !== undefined;

  // One undo step, read at the moment of the edit: the selection is the one the menu opened over.
  const replaceSelection = (text: string) => {
    const range = ed.getSelection();
    if (!range) return;
    ed.pushUndoStop();
    ed.executeEdits('context-menu', [{ range, text, forceMoveMarkers: true }]);
    ed.pushUndoStop();
    ed.focus();
  };

  return (
    <>
      <ContextMenuItem
        disabled={!selected}
        shortcut={`${mod}+X`}
        // The text is deleted only once it is on the clipboard.
        onSelect={() =>
          void copyToClipboard(selected).then(
            () => replaceSelection(''),
            () => {},
          )
        }
      >
        Cut
      </ContextMenuItem>
      <ContextMenuItem disabled={!selected} shortcut={`${mod}+C`} onSelect={() => copyQuietly(selected)}>
        Copy
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canPaste}
        shortcut={`${mod}+V`}
        // The browser may ask first; a refusal leaves the text as it was.
        onSelect={() => void navigator.clipboard.readText().then(replaceSelection, () => {})}
      >
        Paste
      </ContextMenuItem>
      <ContextMenuItem
        shortcut={`${mod}+A`}
        onSelect={() => {
          if (model) ed.setSelection(model.getFullModelRange());
          ed.focus();
        }}
      >
        Select all
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        shortcut={`${mod}+F`}
        onSelect={() => {
          ed.focus();
          void ed.getAction('actions.find')?.run();
        }}
      >
        Find
      </ContextMenuItem>
      {directive && (
        <ContextMenuItem onSelect={() => openDictionaryAt(directive)}>
          Look up {directive} in the Dictionary
        </ContextMenuItem>
      )}
      {file === 'raw' && (
        <ContextMenuItem onSelect={openScaffold}>Scaffold props.conf from this sample</ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem shortcut={`${mod}+K`} onSelect={openCommandPalette}>
        Command palette
      </ContextMenuItem>
    </>
  );
}
