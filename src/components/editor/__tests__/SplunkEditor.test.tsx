// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// SplunkEditor.test.tsx
// The conf editor wrapper around MonacoEditor, against a REAL Monaco editor
// (it runs under jsdom; src/test/monacoJsdom.ts says what is stubbed): which
// language and accessible name each file gets, how the instance is published
// to the rest of the app, the theme it follows, and the lint pass that runs
// after every content change whoever made it.
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { editor } from 'monaco-editor';
import * as monaco from 'monaco-editor/editor';
import { useAppStore } from '../../../store/useAppStore';
import { resetModelRegistry } from '../modelRegistry';
import { getEditor } from '../editorRegistry';
import { disposeSplunkMonaco, PROPS_LANGUAGE_ID, TRANSFORMS_LANGUAGE_ID } from '../splunkMonacoSetup';

const { SplunkEditor } = await import('../SplunkEditor');

const LINTER = 'splunk-linter';
const markers = () => monaco.editor.getModelMarkers({ owner: LINTER });

/** The 500 ms debounce SplunkEditor puts between a change and the lint pass. */
const LINT_DELAY_MS = 500;

function mount(props: Partial<React.ComponentProps<typeof SplunkEditor>> = {}) {
  const ready: editor.IStandaloneCodeEditor[] = [];
  const changes: string[] = [];
  const element = (p: Partial<React.ComponentProps<typeof SplunkEditor>>) => (
    <SplunkEditor
      value={'[st]\nKV_MODE = auto\n'}
      onChange={(v) => changes.push(v)}
      onEditorReady={(e) => ready.push(e)}
      {...p}
    />
  );
  const view = render(element(props));
  return {
    ready,
    changes,
    unmount: view.unmount,
    update: (p: Partial<React.ComponentProps<typeof SplunkEditor>>) => view.rerender(element({ ...props, ...p })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  useAppStore.setState({ theme: 'light' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  for (const model of monaco.editor.getModels()) model.dispose();
  resetModelRegistry();
  disposeSplunkMonaco();
});

describe('which language and name each file gets', () => {
  it.each([
    ['props.conf', PROPS_LANGUAGE_ID],
    ['transforms.conf', TRANSFORMS_LANGUAGE_ID],
  ] as const)('%s edits as %s and is named for screen readers', (fileType, languageId) => {
    const { ready } = mount({ fileType });
    const instance = ready[0]!;
    expect(instance.getModel()?.getLanguageId()).toBe(languageId);
    expect(instance.getOption(monaco.editor.EditorOption.ariaLabel)).toBe(fileType);
  });

  it('defaults to props.conf', () => {
    const { ready } = mount();
    expect(ready[0]!.getModel()?.getLanguageId()).toBe(PROPS_LANGUAGE_ID);
  });

  it("lets an explicit language override the file type's", () => {
    const { ready } = mount({ fileType: 'transforms.conf', language: PROPS_LANGUAGE_ID });
    expect(ready[0]!.getModel()?.getLanguageId()).toBe(PROPS_LANGUAGE_ID);
  });

  it('applies the shared options', () => {
    const { ready } = mount();
    expect(ready[0]!.getModel()?.getOptions().tabSize).toBe(4);
    expect(ready[0]!.getOption(monaco.editor.EditorOption.fontSize)).toBe(14);
    expect(ready[0]!.getOption(monaco.editor.EditorOption.folding)).toBe(true);
  });
});

describe('publishing the instance', () => {
  it('hands the editor to onEditorReady and to the registry under its file name', () => {
    const { ready } = mount({ fileType: 'transforms.conf' });
    expect(ready).toHaveLength(1);
    expect(getEditor('transforms.conf')).toBe(ready[0]);
    expect(getEditor('props.conf')).toBeUndefined();
  });

  it('takes it out of the registry on unmount', () => {
    const { unmount } = mount();
    expect(getEditor('props.conf')).toBeDefined();
    unmount();
    expect(getEditor('props.conf')).toBeUndefined();
  });

  it('re-registers the same instance under the new name when the file type changes', () => {
    const { ready, update } = mount({ fileType: 'props.conf' });
    update({ fileType: 'transforms.conf' });
    expect(getEditor('transforms.conf')).toBe(ready[0]);
    expect(getEditor('props.conf')).toBeUndefined();
  });
});

describe('the value and onChange', () => {
  it('shows the value it is given', () => {
    const { ready } = mount({ value: '[st]\nTRUNCATE = 5\n' });
    expect(ready[0]!.getValue()).toBe('[st]\nTRUNCATE = 5\n');
  });

  it('reports what the user types, and not what the parent writes', () => {
    const { ready, changes, update } = mount();
    const eol = ready[0]!.getModel()!.getEOL();
    ready[0]!.trigger('test', 'type', { text: 'x' });
    expect(changes).toEqual([`x[st]${eol}KV_MODE = auto${eol}`]);

    update({ value: '[other]\n' });
    expect(ready[0]!.getValue()).toBe('[other]\n');
    expect(changes).toHaveLength(1);
  });
});

describe('the theme', () => {
  // Monaco puts the base of the active theme on the editor's root element:
  // splunk-light is built on `vs`, splunk-dark on `vs-dark`.
  const base = () => {
    const classes = document.querySelector('.monaco-editor')?.classList;
    return classes?.contains('vs-dark') ? 'vs-dark' : classes?.contains('vs') ? 'vs' : undefined;
  };

  it('follows the store: splunk-light on a light theme, splunk-dark on a dark one', () => {
    mount();
    expect(base()).toBe('vs');

    act(() => useAppStore.setState({ theme: 'dark' }));
    expect(base()).toBe('vs-dark');

    act(() => useAppStore.setState({ theme: 'light' }));
    expect(base()).toBe('vs');
  });
});

describe('the lint pass', () => {
  const MISCASED = '[st]\nkv_mode = auto\n';
  const CLEAN = '[st]\nKV_MODE = auto\n';

  it('marks the initial text once the debounce has passed, not before', () => {
    mount({ value: MISCASED });
    expect(markers()).toEqual([]);
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers().map((m) => m.startLineNumber)).toEqual([2]);
  });

  it('lints text the parent wrote, which onChange never reports', () => {
    const { changes, update } = mount({ value: CLEAN });
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers()).toEqual([]);

    // e.g. loading an example, or the scaffold writing a directive.
    update({ value: MISCASED });
    expect(changes).toEqual([]);
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers()).toHaveLength(1);

    update({ value: CLEAN });
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers()).toEqual([]);
  });

  it('lints once for a burst of edits', () => {
    const { ready } = mount({ value: CLEAN });
    const setMarkers = vi.spyOn(monaco.editor, 'setModelMarkers');
    vi.advanceTimersByTime(LINT_DELAY_MS);
    setMarkers.mockClear();

    for (let i = 0; i < 5; i++) ready[0]!.trigger('test', 'type', { text: 'x' });
    vi.advanceTimersByTime(LINT_DELAY_MS - 1);
    expect(setMarkers).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setMarkers).toHaveBeenCalledTimes(1);
  });

  it('lints against the file it edits: a transforms.conf key is fine there and wrong in props.conf', () => {
    const transformsOnly = '[st]\nREGEX = (a)\n';
    mount({ value: transformsOnly, fileType: 'transforms.conf' });
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers()).toEqual([]);
    cleanup();
    for (const model of monaco.editor.getModels()) model.dispose();
    resetModelRegistry();

    mount({ value: transformsOnly, fileType: 'props.conf' });
    vi.advanceTimersByTime(LINT_DELAY_MS);
    expect(markers().length).toBeGreaterThan(0);
  });

  it('sets no markers after unmount, even with a pass pending', () => {
    // The pending timer is cleared on unmount, and a disposed editor has no
    // model to mark either: two guards, so this asserts the outcome only.
    const { unmount } = mount({ value: MISCASED });
    const setMarkers = vi.spyOn(monaco.editor, 'setModelMarkers');
    unmount();
    vi.advanceTimersByTime(LINT_DELAY_MS * 2);
    expect(setMarkers).not.toHaveBeenCalled();
    expect(markers()).toEqual([]);
  });
});
