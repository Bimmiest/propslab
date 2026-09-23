import { useRef, useEffect, useCallback } from 'react';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import type { editor } from 'monaco-editor';
import { useAppStore } from '../../store/useAppStore';
import { MonacoEditor } from './MonacoEditor';
import { registerEditor, unregisterEditor } from './editorRegistry';
import { computeDiagnostics } from '../../monaco/splunkConfDiagnostics';
import { ensureSplunkMonaco, PROPS_LANGUAGE_ID, TRANSFORMS_LANGUAGE_ID } from './splunkMonacoSetup';

interface SplunkEditorProps {
  value: string;
  onChange: (value: string) => void;
  fileType?: 'props.conf' | 'transforms.conf';
  /** Override the Monaco language ID. Defaults to the one matching `fileType`. */
  language?: string;
  onEditorReady?: (editor: editor.IStandaloneCodeEditor) => void;
}

// Module-level so the identity is stable: MonacoEditor treats a new `options`
// object as a change and re-runs updateOptions.
const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  minimap: { enabled: false },
  contextmenu: false,
  wordWrap: 'off',
  lineNumbers: 'on',
  folding: true,
  scrollBeyondLastLine: false,
  fontSize: 14,
  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', 'Consolas', monospace",
  tabSize: 4,
  renderWhitespace: 'selection',
  bracketPairColorization: { enabled: false },
  acceptSuggestionOnEnter: 'off',
  tabCompletion: 'on',
  // Monaco's 300ms default fires while the pointer is still crossing the file
  // on its way somewhere else, and these hovers are large — a full directive
  // reference, not a one-line tooltip. Long enough to require intent.
  hover: { delay: 800 },
  suggestOnTriggerCharacters: true,
  quickSuggestions: true,
  fixedOverflowWidgets: true,
  padding: { top: 8 },
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  overviewRulerBorder: false,
  scrollbar: {
    verticalScrollbarSize: 8,
    horizontalScrollbarSize: 8,
  },
};

export function SplunkEditor({ value, onChange, fileType = 'props.conf', language, onEditorReady }: SplunkEditorProps) {
  // Each conf file maps to its own language so it only offers its own directives (UI-4).
  const resolvedLanguage = language ?? (fileType === 'transforms.conf' ? TRANSFORMS_LANGUAGE_ID : PROPS_LANGUAGE_ID);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const theme = useAppStore((s) => s.theme);
  const diagnosticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runDiagnostics = useCallback(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (!model) return;

    const markers = computeDiagnostics(model, fileType);
    monaco.editor.setModelMarkers(model, 'splunk-linter', markers);
  }, [fileType]);

  const handleMount = (editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
    registerEditor(fileType, editorInstance);
    onEditorReady?.(editorInstance);
  };

  // Theme is applied through the <MonacoEditor theme=…> prop below (which calls
  // monaco.editor.setTheme); a separate updateOptions({ theme }) effect was
  // redundant — updateOptions doesn't even carry the global theme.

  // Lint on every content change, whoever made it. This used to be scheduled
  // from the `onChange` handler, but MonacoEditor deliberately withholds
  // `onChange` for its own writes of `value` (so they are not echoed back to
  // the store as user edits) — which meant Clear, loading an example and the
  // scaffold all replaced the text and left the old file's markers on it
  // (#295). Listening on the editor directly sees both kinds of edit through
  // one debounce, so a keystroke is not scheduled twice, and it cannot feed
  // back: setting markers is not a content change.
  //
  // Runs after MonacoEditor's construction effect (a child's effects fire
  // before its parent's), so the instance is already here. It also owns the
  // registry entry's teardown: keyed on `fileType`, a change re-registers the
  // editor under the new name instead of only unregistering it from the old.
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    registerEditor(fileType, instance);

    const schedule = () => {
      if (diagnosticTimerRef.current) clearTimeout(diagnosticTimerRef.current);
      diagnosticTimerRef.current = setTimeout(runDiagnostics, 500);
    };
    schedule(); // initial pass over whatever the editor mounted with
    const subscription = instance.onDidChangeModelContent(schedule);

    return () => {
      subscription.dispose();
      if (diagnosticTimerRef.current) {
        clearTimeout(diagnosticTimerRef.current);
        diagnosticTimerRef.current = null;
      }
      // Removed so consumers can't act on a disposed instance (e.g. after a
      // collapse or mobile-layout switch).
      unregisterEditor(fileType, instance);
    };
  }, [fileType, runDiagnostics]);

  return (
    <MonacoEditor
      language={resolvedLanguage}
      value={value}
      onChange={onChange}
      onMount={handleMount}
      theme={theme === 'dark' ? 'splunk-dark' : 'splunk-light'}
      options={EDITOR_OPTIONS}
      beforeMount={ensureSplunkMonaco}
    />
  );
}
