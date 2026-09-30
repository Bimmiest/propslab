// Side-effect module: makes the REAL Monaco editor mountable under jsdom.
//
// Import it before anything that imports Monaco (ES imports run in order), and
// import the component under test with `await import()` after it, since the
// mocks below only affect modules loaded later.
//
// What is stubbed is only what cannot exist in jsdom and is not under test:
//  - `matchMedia`, which Monaco's theme service reads when it is created.
//  - the editor worker wrapper (`?worker` is a bundler feature).
//  - the editor CONTRIBUTIONS, which need real layout and are covered by the
//    Playwright suite. Monaco's core, its models, its language registries and
//    its services are all real.

import { vi } from 'vitest';

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

vi.doMock('monaco-editor/editor/editor.worker?worker', () => ({ default: vi.fn() }));
for (const feature of [
  'codeEditor',
  'hover',
  'snippet',
  'codeAction',
  'gotoError',
  'folding',
  'find',
  'bracketMatching',
  'clipboard',
  'cursorUndo',
  'linesOperations',
  'multicursor',
  'wordHighlighter',
  'wordOperations',
  'toggleTabFocusMode',
  'codicon',
]) {
  vi.doMock(`monaco-editor/features/${feature}/register`, () => ({}));
}
vi.doMock('monaco-editor/editor/contrib/suggest/browser/suggestController.js', () => ({}));
