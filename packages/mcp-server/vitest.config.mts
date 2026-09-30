import { defineConfig } from 'vitest/config';

// Without a config of its own, vitest walks up and finds the app's root
// vitest.config.ts — React plugin, jsdom setup file and all. This package is
// plain Node.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 20000,
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
      // Measured, not chosen: within a point of what the suite produces with
      // the heap-limit tests skipped (93.6 / 88.2 / 94.1 / 93.8), which they are
      // wherever NODE_OPTIONS already sets a heap size (runInWorker.test.ts).
      // Without NODE_OPTIONS, as in CI, they run and the figures are 94.8 / 89.2
      // / 96.6 / 95.2, so the floors sit 1.2-2.6 points under CI's numbers and
      // hold on the Windows and macOS legs, where the Linux-only launcher tests
      // skip. scripts/check-coverage-floors.mjs fails CI's Linux leg when a
      // floor is more than 3 points under (#506). As in the app's config, raise
      // them when tests raise coverage; never lower them to make a branch green.
      thresholds: {
        statements: 93,
        branches: 88,
        functions: 94,
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
