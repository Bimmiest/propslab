import { useEffect, useRef } from 'react';
// Import the editor API only — NOT the `monaco-editor` barrel (editor.main),
// which eagerly bundles ~80 basic-languages and the TypeScript/JSON/CSS/HTML
// language services (their main-thread modes *and* web workers, the ts.worker
// alone being ~7 MB). This app registers its own conf languages, so it needs
// none of them. `monaco-editor/editor` is the supported slim entry (0.56+);
// it already pulls in coreCommands and standaloneStrings.
import * as monaco from 'monaco-editor/editor';
// The editor CONTRIBUTIONS, which the API entry does not pull in, via the
// per-feature entry points. Named one by one rather than via
// features/register.all, which also registers sticky scroll, rename, code
// lens, parameter hints, semantic tokens and ~40 more this app never enables.
// Dropping one silently disables its feature, so each line names what depends
// on it; the e2e suite covers hover, suggest, code actions, folding and find.
import 'monaco-editor/features/codeEditor/register';
// Directive/TIME_FORMAT hovers, and the marker hover on lint squiggles.
import 'monaco-editor/features/hover/register';
// Directive completion; snippets back its InsertAsSnippet items.
// Deep import: features/suggest/register only brings suggestInlineCompletions,
// not the SuggestController that drives the completion widget.
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/features/snippet/register';
// Quick fixes for miscased keys (splunkConfCodeActions).
import 'monaco-editor/features/codeAction/register';
// F8 / Shift+F8 between lint markers.
import 'monaco-editor/features/gotoError/register';
// Stanza folding (splunkConfFolding).
import 'monaco-editor/features/folding/register';
// Ctrl+F / Ctrl+H.
import 'monaco-editor/features/find/register';
// Plain editing ergonomics users expect from any code editor.
import 'monaco-editor/features/bracketMatching/register';
import 'monaco-editor/features/clipboard/register';
import 'monaco-editor/features/cursorUndo/register';
import 'monaco-editor/features/linesOperations/register';
import 'monaco-editor/features/multicursor/register';
import 'monaco-editor/features/wordHighlighter/register';
import 'monaco-editor/features/wordOperations/register';
// Screen reader: Ctrl+M toggles Tab between indenting and moving focus.
import 'monaco-editor/features/toggleTabFocusMode/register';
// Codicon font and classes (the modifiers stylesheet comes in with suggest
// and code actions).
import 'monaco-editor/features/codicon/register';
import type { editor } from 'monaco-editor';
// Deep import: 0.56+ has no feature entry point for the base editor worker.
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import { acquireModel, saveViewState, takeViewState } from './modelRegistry';

// Point Monaco at the locally bundled worker instead of a CDN. Set here, not in
// main.tsx, so it rides the lazy editor chunk: the `?worker` wrapper matches
// the monaco-editor chunk group, and importing it at startup made the entry
// statically depend on (and wait for) the whole editor chunk.
self.MonacoEnvironment = {
  getWorker() {
    return new editorWorker();
  },
};

export interface MonacoEditorProps {
  value: string;
  onChange?: (value: string) => void;
  language: string;
  /** A registered theme name. Monaco themes are global, so the last writer wins. */
  theme: string;
  /**
   * Construction options, merged over `automaticLayout: true`.
   *
   * Must be referentially stable — hoist it to a module constant. An inline
   * object literal is a new identity every render, which would re-run
   * `updateOptions` on every render for no benefit.
   */
  options?: editor.IStandaloneEditorConstructionOptions;
  /**
   * Keeps this file's model and view state across unmounts (see
   * modelRegistry), so a remount keeps undo history, cursor and scroll.
   * Read once, at mount. Without it the model is disposed with the editor.
   */
  modelKey?: string;
  /** Runs before the editor is constructed — register languages/themes here. */
  beforeMount?: () => void;
  onMount?: (instance: editor.IStandaloneCodeEditor) => void;
}

/**
 * Mounts a Monaco editor against a directly-imported `monaco` instance.
 *
 * This replaces `@monaco-editor/react`, which existed to fetch Monaco over
 * AMD/CDN at runtime — a job `loader.config({ monaco })` in main.tsx had
 * already taken away from it by handing it a pre-built instance. What was left
 * was this lifecycle shim, plus the loader machinery still riding along in the
 * bundle.
 *
 * Behaviour is deliberately kept identical to the library's, including the
 * `automaticLayout: true` default it applied before spreading caller options —
 * without it the editor does not re-layout when a resizable panel changes size,
 * because Monaco otherwise only reacts to window resizes.
 */
export function MonacoEditor({
  value,
  onChange,
  language,
  theme,
  options,
  modelKey,
  beforeMount,
  onMount,
}: MonacoEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  // Mount-only callbacks, read through refs so an unstable prop identity does
  // not re-run the construction effect (which would dispose a live editor).
  const beforeMountRef = useRef(beforeMount);
  const onMountRef = useRef(onMount);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    beforeMountRef.current = beforeMount;
    onMountRef.current = onMount;
    onChangeRef.current = onChange;
  });

  // Set while we write `value` into the model ourselves, so the resulting
  // content event is not echoed back to the parent as a user edit.
  const suppressChangeRef = useRef(false);

  // Initial props, captured so the construction effect can stay dependency-free.
  // Later changes are handled by the sync effects below.
  const initialRef = useRef({ value, language, theme, options, modelKey });

  // The model's text as of our last read or write. The sync effect compares
  // `value` against this instead of calling getValue(), which rebuilds the
  // whole buffer as a string: once per keystroke is enough.
  const modelValueRef = useRef(value);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const {
      value: initialValue,
      language: initialLanguage,
      theme: initialTheme,
      options: initialOptions,
      modelKey: key,
    } = initialRef.current;

    beforeMountRef.current?.();

    const model = key
      ? acquireModel(key, () => monaco.editor.createModel(initialValue, initialLanguage))
      : monaco.editor.createModel(initialValue, initialLanguage);
    const instance = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      ...initialOptions,
    });
    monaco.editor.setTheme(initialTheme);
    editorRef.current = instance;

    if (key) {
      // A kept model may predate a language change or, if the text was
      // replaced while no editor showed it (Clear all, loading an example),
      // hold stale text: bring it up to date as an undoable edit.
      monaco.editor.setModelLanguage(model, initialLanguage);
      if (model.getValue() !== initialValue) {
        model.pushStackElement();
        model.pushEditOperations([], [{ range: model.getFullModelRange(), text: initialValue, forceMoveMarkers: true }], () => null);
        model.pushStackElement();
      }
      const viewState = takeViewState<editor.ICodeEditorViewState>(key);
      if (viewState) instance.restoreViewState(viewState);
    }

    const subscription = instance.onDidChangeModelContent(() => {
      if (suppressChangeRef.current) return;
      const next = instance.getValue();
      modelValueRef.current = next;
      onChangeRef.current?.(next);
    });

    onMountRef.current?.(instance);

    return () => {
      subscription.dispose();
      if (key) saveViewState(key, instance.saveViewState());
      else instance.getModel()?.dispose();
      instance.dispose();
      editorRef.current = null;
    };
  }, []);

  // Controlled value. `executeEdits` rather than `setValue` so the undo stack
  // and cursor position survive a parent-driven update (e.g. loading an
  // example, or the scaffold writing a directive into props.conf).
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || value === modelValueRef.current) return;

    const model = instance.getModel();
    if (!model) return;

    suppressChangeRef.current = true;
    instance.executeEdits('', [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    suppressChangeRef.current = false;
    modelValueRef.current = value;
  }, [value]);

  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  useEffect(() => {
    monaco.editor.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (options) editorRef.current?.updateOptions(options);
  }, [options]);

  return <div ref={containerRef} className="w-full h-full" />;
}
