// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// MonacoEditor.test.tsx
// The controlled-value sync of the Monaco wrapper, against a REAL Monaco
// editor (it runs under jsdom): the undo history a parent-driven replacement
// leaves, the suppress flag when an edit throws, and the EOL reconcile on a
// remount. (The `finally` that clears the suppress flag when executeEdits throws
// is not tested through the component: React unmounts the tree on an effect's
// throw, taking the flag with it.)
// The contribution entry points and the worker wrapper are stubbed; they are
// browser-only and none of them is under test here.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { editor } from 'monaco-editor';
import * as monaco from 'monaco-editor/editor';
import { resetModelRegistry } from '../modelRegistry';

vi.hoisted(() => {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent: () => false,
  });
});

vi.mock('monaco-editor/editor/editor.worker?worker', () => ({ default: vi.fn() }));
for (const feature of [
  'codeEditor', 'hover', 'snippet', 'codeAction', 'gotoError', 'folding', 'find', 'bracketMatching',
  'clipboard', 'cursorUndo', 'linesOperations', 'multicursor', 'wordHighlighter', 'wordOperations',
  'toggleTabFocusMode', 'codicon',
]) {
  vi.doMock(`monaco-editor/features/${feature}/register`, () => ({}));
}
vi.mock('monaco-editor/editor/contrib/suggest/browser/suggestController.js', () => ({}));

const { MonacoEditor } = await import('../MonacoEditor');

interface Handle {
  instance: editor.IStandaloneCodeEditor;
  changes: string[];
}

function mount(value: string, modelKey?: string) {
  const handle = { changes: [] } as unknown as Handle;
  const props = (v: string) => ({
    value: v,
    language: 'plaintext',
    theme: 'vs',
    ...(modelKey ? { modelKey } : {}),
    onChange: (next: string) => handle.changes.push(next),
    onMount: (instance: editor.IStandaloneCodeEditor) => {
      handle.instance = instance;
    },
  });
  const view = render(
    <MonacoEditor {...props(value)} />,
  );
  return {
    handle,
    setValue: (v: string) =>
      view.rerender(<MonacoEditor {...props(v)} />),
    unmount: view.unmount,
  };
}

const typeText = (instance: editor.IStandaloneCodeEditor, text: string) =>
  instance.trigger('test', 'type', { text });
const undo = (instance: editor.IStandaloneCodeEditor) => instance.trigger('test', 'undo', null);

beforeEach(() => resetModelRegistry());
afterEach(() => {
  cleanup();
  for (const model of monaco.editor.getModels()) model.dispose();
});

describe('a parent-driven value replaces the text as its own undo step (#503)', () => {
  it('Ctrl+Z after loading an example brings back the typed text, not the text before it', () => {
    const { handle, setValue } = mount('a');
    typeText(handle.instance, 'xyz');
    expect(handle.instance.getValue()).toBe('xyza');

    setValue('EXAMPLE');
    expect(handle.instance.getValue()).toBe('EXAMPLE');

    undo(handle.instance);
    expect(handle.instance.getValue()).toBe('xyza');
  });

  it('does not echo the replacement back to the parent as a user edit', () => {
    const { handle, setValue } = mount('a');
    setValue('EXAMPLE');
    expect(handle.changes).toEqual([]);
    typeText(handle.instance, 'x');
    expect(handle.changes).toEqual(['EXAMPLEx']);
  });
});

describe('remounting reconciles the kept model modulo line endings (#503)', () => {
  it('pushes no edit when the model holds CRLF and the value is the same text in LF', () => {
    const first = mount('a\nb', 'props.conf');
    const model = first.handle.instance.getModel()!;
    model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    expect(model.getValue()).toBe('a\r\nb');
    first.unmount();

    const versionBefore = model.getVersionId();
    const second = mount('a\nb', 'props.conf');
    expect(second.handle.instance.getModel()).toBe(model);
    expect(model.getVersionId()).toBe(versionBefore);
  });

  it('still brings a kept model up to date when the text really differs', () => {
    const first = mount('a\nb', 'props.conf');
    const model = first.handle.instance.getModel()!;
    model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
    first.unmount();

    mount('a\nc', 'props.conf');
    expect(model.getValue().replace(/\r\n/g, '\n')).toBe('a\nc');
  });
});
