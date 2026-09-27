import { useEffect, useRef } from 'react';
// Import the editor API only — NOT the `monaco-editor` barrel (editor.main),
// which eagerly bundles ~80 basic-languages and the TypeScript/JSON/CSS/HTML
// language services (their main-thread modes *and* web workers, the ts.worker
// alone being ~7 MB). This app registers its own conf languages, so it needs
// none of them. vite.config.ts chunks on this exact specifier.
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
// The editor CONTRIBUTIONS, which editor.api does not pull in. Named one by
// one rather than via editor.all, which also registers sticky scroll, rename,
// code lens, parameter hints, semantic tokens and ~40 more contributions this
// app never enables (#375). Dropping one silently disables its feature, so
// each line names what depends on it; the e2e suite covers hover, suggest,
// code actions, folding and find.
import 'monaco-editor/esm/vs/editor/browser/coreCommands.js';
import 'monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
// Directive/TIME_FORMAT hovers, and the marker hover on lint squiggles.
import 'monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js';
// Directive completion; snippets back its InsertAsSnippet items.
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import 'monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js';
// Quick fixes for miscased keys (splunkConfCodeActions).
import 'monaco-editor/esm/vs/editor/contrib/codeAction/browser/codeActionContributions.js';
// F8 / Shift+F8 between lint markers.
import 'monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError.js';
// Stanza folding (splunkConfFolding).
import 'monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
// Ctrl+F / Ctrl+H.
import 'monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
// Plain editing ergonomics users expect from any code editor.
import 'monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import 'monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import 'monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js';
import 'monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js';
import 'monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js';
import 'monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js';
import 'monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
// Screen reader: Ctrl+M toggles Tab between indenting and moving focus.
import 'monaco-editor/esm/vs/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js';
import 'monaco-editor/esm/vs/editor/common/standaloneStrings.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import type { editor } from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

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
  const initialRef = useRef({ value, language, theme, options });

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const { value: initialValue, language: initialLanguage, theme: initialTheme, options: initialOptions } = initialRef.current;

    beforeMountRef.current?.();

    const model = monaco.editor.createModel(initialValue, initialLanguage);
    const instance = monaco.editor.create(container, {
      model,
      automaticLayout: true,
      ...initialOptions,
    });
    monaco.editor.setTheme(initialTheme);
    editorRef.current = instance;

    const subscription = instance.onDidChangeModelContent(() => {
      if (suppressChangeRef.current) return;
      onChangeRef.current?.(instance.getValue());
    });

    onMountRef.current?.(instance);

    return () => {
      subscription.dispose();
      instance.getModel()?.dispose();
      instance.dispose();
      editorRef.current = null;
    };
  }, []);

  // Controlled value. `executeEdits` rather than `setValue` so the undo stack
  // and cursor position survive a parent-driven update (e.g. loading an
  // example, or the scaffold writing a directive into props.conf).
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || value === instance.getValue()) return;

    const model = instance.getModel();
    if (!model) return;

    suppressChangeRef.current = true;
    instance.executeEdits('', [{ range: model.getFullModelRange(), text: value, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    suppressChangeRef.current = false;
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
