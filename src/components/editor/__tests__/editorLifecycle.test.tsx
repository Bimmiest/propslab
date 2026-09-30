// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// editorLifecycle.test.tsx
// What mounting and disposing the editors leaves behind in the REAL Monaco (it
// runs under jsdom; see src/test/monacoJsdom.ts for the few browser-only parts
// that are stubbed): editors, models, content listeners, and the language
// providers registered by ensureSplunkMonaco.
//
// splunkMonacoSetup.test.ts asserts registration against a mocked
// `monaco.languages`, which proves the code calls register once per provider
// but cannot notice Monaco holding two. The provider counts here are read from
// Monaco's own registries (src/test/monacoRegistry.ts).
// ---------------------------------------------------------------------------

import '../../../test/monacoJsdom';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import * as monaco from 'monaco-editor/editor';
import { providerCounts } from '../../../test/monacoRegistry';
import { resetModelRegistry } from '../modelRegistry';
import { getEditor } from '../editorRegistry';
import { disposeSplunkMonaco, PROPS_LANGUAGE_ID, TRANSFORMS_LANGUAGE_ID } from '../splunkMonacoSetup';

const { MonacoEditor } = await import('../MonacoEditor');
const { SplunkEditor } = await import('../SplunkEditor');

const ONE_OF_EACH = { hover: 1, completion: 1, folding: 1, codeAction: 1 };
const NONE = { hover: 0, completion: 0, folding: 0, codeAction: 0 };

function disposeEverything() {
  cleanup();
  for (const model of monaco.editor.getModels()) model.dispose();
  resetModelRegistry();
}

beforeEach(() => {
  disposeEverything();
  disposeSplunkMonaco();
});
afterEach(disposeEverything);

describe('mounting and disposing an editor', () => {
  it('leaves no editor and no model behind when the model is not kept', () => {
    for (let i = 0; i < 3; i++) {
      const view = render(<MonacoEditor value="a" language="plaintext" theme="vs" />);
      expect(monaco.editor.getEditors()).toHaveLength(1);
      expect(monaco.editor.getModels()).toHaveLength(1);
      view.unmount();
    }
    expect(monaco.editor.getEditors()).toHaveLength(0);
    expect(monaco.editor.getModels()).toHaveLength(0);
  });

  it('keeps one model per key across mounts, and no editor', () => {
    let kept: monaco.editor.ITextModel | undefined;
    for (let i = 0; i < 3; i++) {
      const view = render(<MonacoEditor value="a" language="plaintext" theme="vs" modelKey="props.conf" />);
      const [model, ...rest] = monaco.editor.getModels();
      expect(rest).toHaveLength(0);
      kept ??= model;
      expect(model).toBe(kept);
      view.unmount();
      expect(monaco.editor.getEditors()).toHaveLength(0);
    }
    expect(monaco.editor.getModels()).toEqual([kept]);
  });

  it('stops reporting edits to a parent that has unmounted, and does not stack listeners on a kept model', () => {
    const first: string[] = [];
    const second: string[] = [];
    const mount = (into: string[]) =>
      render(
        <MonacoEditor value="a" language="plaintext" theme="vs" modelKey="props.conf" onChange={(v) => into.push(v)} />,
      );

    mount(first).unmount();
    mount(second);
    const model = monaco.editor.getModels()[0]!;
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: 'edited' }], () => null);

    expect(first).toEqual([]);
    expect(second).toEqual(['edited']);
  });
});

describe('the conf editors register their language support once (real Monaco registries)', () => {
  it('registers one provider of each kind per language, however many editors mount', () => {
    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(NONE);

    const props = render(<SplunkEditor value={'[st]\n'} onChange={() => {}} fileType="props.conf" />);
    const transforms = render(<SplunkEditor value={'[t]\n'} onChange={() => {}} fileType="transforms.conf" />);
    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);
    expect(providerCounts(TRANSFORMS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);

    // Two mounts of the same editor, the second after the first is gone, as a
    // panel collapse and re-expand does.
    props.unmount();
    render(<SplunkEditor value={'[st]\n'} onChange={() => {}} fileType="props.conf" />);
    transforms.unmount();
    render(<SplunkEditor value={'[t]\n'} onChange={() => {}} fileType="transforms.conf" />);

    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);
    expect(providerCounts(TRANSFORMS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);
  });

  it('does not register a second set when two editors mount side by side', () => {
    render(
      <>
        <SplunkEditor value={'[st]\n'} onChange={() => {}} fileType="props.conf" />
        <SplunkEditor value={'[st]\n'} onChange={() => {}} fileType="props.conf" />
      </>,
    );
    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);
    expect(monaco.editor.getEditors()).toHaveLength(2);
  });

  it('takes every provider down on dispose, and registers one fresh set after it', () => {
    const view = render(<SplunkEditor value={'[st]\n'} onChange={() => {}} />);
    view.unmount();

    // What a hot reload of the module does.
    disposeSplunkMonaco();
    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(NONE);
    expect(providerCounts(TRANSFORMS_LANGUAGE_ID)).toEqual(NONE);

    render(<SplunkEditor value={'[st]\n'} onChange={() => {}} />);
    expect(providerCounts(PROPS_LANGUAGE_ID)).toEqual(ONE_OF_EACH);
  });

  it('leaves the editor registry empty once its editor is gone', () => {
    const view = render(<SplunkEditor value={'[st]\n'} onChange={() => {}} fileType="transforms.conf" />);
    expect(getEditor('transforms.conf')).toBeDefined();
    view.unmount();
    expect(getEditor('transforms.conf')).toBeUndefined();
  });
});
