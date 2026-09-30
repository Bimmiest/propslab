// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// MonacoEditor.test.tsx
// The controlled-value sync of the Monaco wrapper, against a REAL Monaco
// editor (it runs under jsdom): the undo history a parent-driven replacement
// leaves, the suppress flag when an edit throws, and the EOL reconcile on a
// remount. (The `finally` that clears the suppress flag when executeEdits throws
// is not tested through the component: React unmounts the tree on an effect's
// throw, taking the flag with it.)
// The contribution entry points and the worker wrapper are stubbed (see
// src/test/monacoJsdom.ts); they are browser-only and none of them is under
// test here.
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import type { editor } from 'monaco-editor';
import * as monaco from 'monaco-editor/editor';
import { resetModelRegistry } from '../modelRegistry';

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
  const view = render(<MonacoEditor {...props(value)} />);
  return {
    handle,
    setValue: (v: string) => view.rerender(<MonacoEditor {...props(v)} />),
    unmount: view.unmount,
  };
}

const typeText = (instance: editor.IStandaloneCodeEditor, text: string) => instance.trigger('test', 'type', { text });
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

describe('line endings round trip through onChange (#516)', () => {
  it('reports CRLF text as CRLF and takes it back without a second edit', () => {
    const { handle, setValue } = mount('a\r\nb');
    const model = handle.instance.getModel()!;
    expect(model.getEOL()).toBe('\r\n');

    typeText(handle.instance, 'x');
    expect(handle.changes).toEqual(['xa\r\nb']);

    // The parent stores what it was told and passes it straight back.
    const version = model.getVersionId();
    setValue(handle.changes[0]!);
    expect(model.getVersionId()).toBe(version);
    expect(handle.changes).toEqual(['xa\r\nb']);
  });

  it('keeps the model on CRLF when a new line is typed, and reports it as CRLF', () => {
    const { handle } = mount('a\r\nb');
    handle.instance.setPosition({ lineNumber: 1, column: 2 });
    typeText(handle.instance, '\n');
    expect(handle.changes.at(-1)).toBe('a\r\n\r\nb');
    expect(handle.changes.at(-1)).not.toMatch(/(?<!\r)\n/);
  });

  it('reports LF text as LF, and takes it back without a second edit', () => {
    const { handle, setValue } = mount('a\nb');
    const model = handle.instance.getModel()!;
    expect(model.getEOL()).toBe('\n');

    typeText(handle.instance, 'x');
    expect(handle.changes).toEqual(['xa\nb']);

    const version = model.getVersionId();
    setValue(handle.changes[0]!);
    expect(model.getVersionId()).toBe(version);
  });

  it('keeps a CRLF model on CRLF, and echoes nothing, when the parent writes text with LF endings', () => {
    // A parent-driven replacement is inserted with the model's own EOL, so the
    // buffer never ends up with mixed line endings, whatever the parent sends.
    const { handle, setValue } = mount('a\r\nb');
    const model = handle.instance.getModel()!;

    setValue('one\ntwo\nthree');
    expect(model.getValue()).toBe('one\r\ntwo\r\nthree');
    expect(handle.changes).toEqual([]);

    // …and what the user types next is reported in the model's endings.
    handle.instance.setPosition({ lineNumber: 3, column: 1 });
    typeText(handle.instance, '\n');
    expect(handle.changes).toEqual(['one\r\ntwo\r\n\r\nthree']);
  });
});
