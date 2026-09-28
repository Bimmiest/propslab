// Runs for every vitest file. Engine tests use the `node` env and skip the
// jsdom-specific setup; component tests opt into jsdom via a
// `// @vitest-environment jsdom` pragma and pick up the DOM bits here.
import { initRegexEngineSync } from '../utils/splunkRegex';

type GetBuiltinModule = (id: 'node:fs') => { readFileSync(path: string): Uint8Array };

// The regex engine is PCRE2 in WebAssembly, instantiated once before any
// pattern compiles, as the app and the MCP server do at startup. Node's fs is
// reached through getBuiltinModule because this project is type-checked
// without Node's types, which would admit Node globals into app code.
// The path comes from vitest.config.ts: under jsdom, `import.meta.url` is an
// http URL, which fs cannot read.
declare const __PCRE2_WASM_PATH__: string;
const { getBuiltinModule } = (globalThis as unknown as { process: { getBuiltinModule: GetBuiltinModule } }).process;
initRegexEngineSync(getBuiltinModule('node:fs').readFileSync(__PCRE2_WASM_PATH__));

if (typeof window !== 'undefined') {
  await import('@testing-library/jest-dom/vitest');
  const { afterEach } = await import('vitest');
  const { cleanup } = await import('@testing-library/react');
  afterEach(() => cleanup());

  // jsdom doesn't implement ResizeObserver; react-resizable-panels needs it.
  if (!('ResizeObserver' in globalThis)) {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as unknown as { ResizeObserver: typeof ResizeObserverMock }).ResizeObserver = ResizeObserverMock;
  }

  // Nor scrollIntoView, which any list that keeps a keyboard selection in view
  // will call. jsdom has no layout, so a no-op is the honest stand-in — without
  // it the call throws and surfaces as an unhandled error beside passing tests.
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function scrollIntoView() {};
  }
}
