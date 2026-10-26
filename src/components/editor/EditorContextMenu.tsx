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
import { parseConf } from '../../engine/parser/confParser';
import { resolveStanzasForEvent } from '../../engine/parser/stanzaMatcher';
import { parseExtractValue } from '../../engine/processors/fieldExtractor';
import { toggleComment } from './toggleComment';
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

/** The regex a directive line holds, for the Regex tab, with an EXTRACT's class name. */
function regexOnLine(
  line: string,
  file: 'props.conf' | 'transforms.conf',
): { pattern: string; className?: string } | undefined {
  const eq = line.indexOf('=');
  if (eq <= 0 || /^\s*[#[]/.test(line)) return undefined;
  const key = line.slice(0, eq).trim();
  if (getDirectiveInfo(key, file)?.valueType !== 'regex') return undefined;
  const value = line.slice(eq + 1);
  const extract = /^EXTRACT-(.+)$/i.exec(key);
  // EXTRACT's value may end in `in <field>`, which is not part of the regex.
  const pattern = extract ? parseExtractValue(value).pattern : value.trim();
  return pattern ? { pattern, ...(extract?.[1] ? { className: extract[1] } : {}) } : undefined;
}

/** The name of the stanza that holds `lineNumber`: the nearest `[header]` above it, or undefined. */
function stanzaAt(model: editor.ITextModel, lineNumber: number): string | undefined {
  for (let n = lineNumber; n >= 1; n--) {
    const header = /^\s*\[(.+)\]\s*$/.exec(model.getLineContent(n));
    if (header) return header[1];
  }
  return undefined;
}

function testInRegexTab({ pattern, className }: { pattern: string; className?: string }): void {
  const s = useAppStore.getState();
  s.setRegexPattern(pattern);
  if (className) s.setRegexClassName(className);
  s.setActiveView('simulator');
  s.setActiveOutputTab('preview');
  s.setPreviewSubTab('regex');
  s.setMobileView('output');
}

function showInEffectiveConfig(): void {
  const s = useAppStore.getState();
  s.setActiveView('simulator');
  s.setActiveOutputTab('effective');
  s.setMobileView('output');
}

/**
 * Whether `stanza` is one the Effective config tab shows: a stanza that applies
 * to the metadata, as the tab resolves it. Parsed when the menu opens.
 */
function appliesToMetadata(stanza: string): boolean {
  const { propsConf, metadata } = useAppStore.getState();
  const { stanzas } = parseConf(propsConf, 'props.conf');
  return resolveStanzasForEvent(stanzas, metadata).stanzas.some((s) => s.name === stanza);
}

/** Rendered only while the menu is open, so it reads the editor as it is now. */
function EditorMenuItems({ editor: ed, file }: { editor: editor.IStandaloneCodeEditor; file: EditorFile }) {
  const openDictionaryAt = useAppStore((s) => s.openDictionaryAt);
  const mod = getModifierName();
  const model = ed.getModel();
  const selection = ed.getSelection();
  const selected = model && selection && !selection.isEmpty() ? model.getValueInRange(selection) : '';
  const position = ed.getPosition();
  const conf = file !== 'raw' && model && position ? { file, line: model.getLineContent(position.lineNumber) } : null;
  const directive = conf ? directiveOnLine(conf.line, conf.file) : undefined;
  const regex = conf ? regexOnLine(conf.line, conf.file) : undefined;
  const stanza = file === 'props.conf' && model && position ? stanzaAt(model, position.lineNumber) : undefined;
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
      {file !== 'raw' && (
        <ContextMenuItem
          shortcut={`${mod}+/`}
          onSelect={() => {
            toggleComment(ed);
            ed.focus();
          }}
        >
          Toggle line comment
        </ContextMenuItem>
      )}
      {regex && (
        <ContextMenuItem onSelect={() => testInRegexTab(regex)}>Test the regex in the Regex tab</ContextMenuItem>
      )}
      {stanza !== undefined &&
        (appliesToMetadata(stanza) ? (
          <ContextMenuItem onSelect={showInEffectiveConfig}>Show [{stanza}] in Effective config</ContextMenuItem>
        ) : (
          <ContextMenuItem disabled onSelect={() => {}}>
            [{stanza}] does not match the metadata
          </ContextMenuItem>
        ))}
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
