import { useRef, useEffect, useCallback } from 'react';
import * as monaco from 'monaco-editor/editor';
import type { editor } from 'monaco-editor';
import { useAppStore } from '../../store/useAppStore';
import { MonacoEditor } from './MonacoEditor';
import { registerEditor, unregisterEditor } from './editorRegistry';
import type { DiagnosticMarker } from '../../monaco/splunkConfDiagnostics';
import { fileProblems, lintConf } from '../../monaco/editorProblems';
import { toMarkerData } from '../../monaco/markerData';
import { LINT_DELAY_MS } from './useFileProblems';
import { ensureSplunkMonaco, PROPS_LANGUAGE_ID, TRANSFORMS_LANGUAGE_ID } from './splunkMonacoSetup';
import { TOGGLE_COMMENT_ACTION, toggleComment } from './toggleComment';

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
  // find.closeOnResult and doubleClickSelectsBlock stay at Monaco's defaults
  // (off / on): Enter keeps stepping through stanzas with the widget open, and
  // the conf languages define no bracket pairs, so block-select only acts just
  // inside a quoted value (selecting its contents) and is otherwise a word select.
  suggestOnTriggerCharacters: true,
  // Not in comments or strings: a `#` line is prose, and a quoted value is free text.
  quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
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

// One options object per file, each named for screen readers, so the three
// editors are not all announced as the same generic "Editor content".
const OPTIONS_BY_FILE: Record<'props.conf' | 'transforms.conf', editor.IStandaloneEditorConstructionOptions> = {
  'props.conf': { ...EDITOR_OPTIONS, ariaLabel: 'props.conf' },
  'transforms.conf': { ...EDITOR_OPTIONS, ariaLabel: 'transforms.conf' },
};

export function SplunkEditor({ value, onChange, fileType = 'props.conf', language, onEditorReady }: SplunkEditorProps) {
  // Each conf file maps to its own language so it only offers its own directives.
  const resolvedLanguage = language ?? (fileType === 'transforms.conf' ? TRANSFORMS_LANGUAGE_ID : PROPS_LANGUAGE_ID);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const theme = useAppStore((s) => s.theme);
  const diagnosticTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The run's diagnostics join the linter's markers, so that the editor marks
  // the list its panel shows (fileProblems, #899).
  const runDiagnostics = useAppStore((s) => s.validationDiagnostics);
  const runRef = useRef(runDiagnostics);
  // The last lint of this editor's text; null until the first pass.
  const lintRef = useRef<readonly DiagnosticMarker[] | null>(null);

  const applyMarkers = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model || lintRef.current === null) return;
    const { markers } = fileProblems(fileType, lintRef.current, runRef.current);
    monaco.editor.setModelMarkers(model, 'splunk-linter', toMarkerData(markers));
  }, [fileType]);

  const lint = useCallback(() => {
    const model = editorRef.current?.getModel();
    if (!model) return;
    lintRef.current = lintConf(model.getValue(), fileType);
    applyMarkers();
  }, [fileType, applyMarkers]);

  useEffect(() => {
    runRef.current = runDiagnostics;
    applyMarkers();
  }, [runDiagnostics, applyMarkers]);

  const handleMount = (editorInstance: editor.IStandaloneCodeEditor) => {
    editorRef.current = editorInstance;
    // Ctrl+/ as in other editors; the context menu runs the same function (#762).
    editorInstance.addAction({
      id: TOGGLE_COMMENT_ACTION,
      label: 'Toggle line comment',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      run: toggleComment,
    });
    registerEditor(fileType, editorInstance);
    onEditorReady?.(editorInstance);
  };

  // Theme is applied through the <MonacoEditor theme=…> prop below (which calls
  // monaco.editor.setTheme); a separate updateOptions({ theme }) effect was
  // redundant — updateOptions doesn't even carry the global theme.

  // Lint on every content change, whoever made it. Not from `onChange`:
  // MonacoEditor deliberately withholds `onChange` for its own writes of
  // `value` (so they are not echoed back to the store as user edits), so Clear,
  // loading an example and the scaffold would leave the old file's markers on
  // the new text. Listening on the editor directly sees both kinds of edit
  // through one debounce, so a keystroke is not scheduled twice, and it cannot
  // feed back: setting markers is not a content change.
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
      diagnosticTimerRef.current = setTimeout(lint, LINT_DELAY_MS);
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
      // A lint of the old file type must not be marked against the new one.
      lintRef.current = null;
    };
  }, [fileType, lint]);

  return (
    <MonacoEditor
      language={resolvedLanguage}
      value={value}
      onChange={onChange}
      onMount={handleMount}
      theme={theme === 'dark' ? 'splunk-dark' : 'splunk-light'}
      options={OPTIONS_BY_FILE[fileType]}
      modelKey={fileType}
      beforeMount={ensureSplunkMonaco}
    />
  );
}
