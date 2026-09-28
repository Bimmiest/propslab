import { defineConfig } from 'vitest/config';

// Without a config of its own, vitest walks up and finds the app's root
// vitest.config.ts — React plugin, jsdom setup file and all. This package is
// plain Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Every source file of the package, imported or not, so an untested one
      // counts as 0% rather than being absent. The engine it bundles is outside
      // this root and is measured by the app's suite.
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        // Type-only.
        'src/protocol.ts',
        // Entry points that only ever run out of process — the launcher as a
        // spawned node, the worker from the built bundle — which v8 coverage
        // in this process cannot see. The launcher tests and every worker
        // test run them.
        'src/index.ts',
        'src/simulateWorker.ts',
      ],
      // Measured, not chosen: just under what the suite produces today with
      // the heap-limit tests skipped, which they are wherever NODE_OPTIONS
      // already sets a heap size (runInWorker.test.ts). As in the app's
      // config, raise them when tests raise coverage; never lower them to
      // make a branch green.
      thresholds: {
        statements: 91,
        branches: 84,
        functions: 92,
        lines: 93,
      },
    },
  },
  // The engine sources the tests import live outside this package, so their
  // `pcre2-wasm-utf16` import would resolve from the repository root. Dedupe
  // resolves it from here instead: the copy this package declares.
  resolve: {
    dedupe: ['pcre2-wasm-utf16'],
  },
});
