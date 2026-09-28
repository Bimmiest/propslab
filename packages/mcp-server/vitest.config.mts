import { defineConfig } from 'vitest/config';

// Without a config of its own, vitest walks up and finds the app's root
// vitest.config.ts — React plugin, jsdom setup file and all. This package is
// plain Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  // The engine sources the tests import live outside this package, so their
  // `pcre2-wasm-utf16` import would resolve from the repository root. Dedupe
  // resolves it from here instead: the copy this package declares.
  resolve: {
    dedupe: ['pcre2-wasm-utf16'],
  },
});
