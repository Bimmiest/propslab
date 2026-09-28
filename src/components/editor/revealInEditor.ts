import type { editor } from 'monaco-editor';
import type { DiagnosticTarget } from '../../engine/types';
import { useAppStore, type MobileView } from '../../store/useAppStore';
import { getEditor, onEditorRegistered } from './editorRegistry';

const MOBILE_VIEW: Record<DiagnosticTarget, MobileView> = {
  raw: 'raw',
  'props.conf': 'props',
  'transforms.conf': 'transforms',
};

/**
 * How long to wait for an editor that was not on screen to mount, the
 * lazily loaded Monaco chunk included. Past it the jump is dropped, so a slow
 * mount cannot yank the cursor long after the click.
 */
const MOUNT_TIMEOUT_MS = 10_000;

let cancelPending: (() => void) | null = null;

function reveal(ed: editor.IStandaloneCodeEditor, line: number): void {
  ed.focus();
  requestAnimationFrame(() => {
    ed.setPosition({ lineNumber: line, column: 1 });
    ed.revealLineInCenter(line);
  });
}

/**
 * Put `file`'s editor on screen and move its cursor to `line`.
 *
 * The editor is not mounted while its panel is collapsed, or on mobile while
 * another panel is showing, so a bare `getEditor(file)` found nothing and the
 * link did nothing. This expands the panel and switches the view first, then
 * reveals the line once the editor has registered.
 */
export function revealInEditor(file: DiagnosticTarget, line: number): void {
  cancelPending?.();
  cancelPending = null;

  const store = useAppStore.getState();
  if (store.collapsedPanels[file]) store.togglePanelCollapse(file);
  store.setActiveView('simulator');
  store.setMobileView(MOBILE_VIEW[file]);

  const mounted = getEditor(file);
  if (mounted) {
    reveal(mounted, line);
    return;
  }

  const unsubscribe = onEditorRegistered(file, (ed) => {
    cancel();
    reveal(ed, line);
  });
  const timer = setTimeout(() => cancel(), MOUNT_TIMEOUT_MS);
  const cancel = () => {
    unsubscribe();
    clearTimeout(timer);
    if (cancelPending === cancel) cancelPending = null;
  };
  cancelPending = cancel;
}
