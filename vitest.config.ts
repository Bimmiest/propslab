import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The tests of the scripts sit next to them (#822).
const UNIT_TESTS = ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts'];

export default defineConfig({
  plugins: [react()],
  // Mirrors the build-time define in vite.config.ts. Without it any component
  // reading the version throws under test.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    __APP_COMMIT__: JSON.stringify('0000000000000000000000000000000000000000'),
    __APP_COMMIT_DATE__: JSON.stringify('2026-01-02T03:04:05+00:00'),
    __APP_REPOSITORY__: JSON.stringify('https://github.com/Bimmiest/propslab'),
    __ENGINE_VERSION__: JSON.stringify('0.0.0-test'),
    __ENGINE_COMMIT__: JSON.stringify('1111111111111111111111111111111111111111'),
    __ENGINE_REPOSITORY__: JSON.stringify('https://github.com/Bimmiest/propslab-engine'),
    // Read by src/test/setup.ts to instantiate the regex engine.
    __PCRE2_WASM_PATH__: JSON.stringify(createRequire(import.meta.url).resolve('pcre2-wasm-utf16/pcre2.wasm')),
  },
  test: {
    // Default to node; component tests opt into jsdom via
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: UNIT_TESTS,
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      // Text for a local run, lcov for anything that wants to ingest it, and
      // json-summary so the numbers can be read back without re-running.
      reporter: ['text', 'lcov', 'json-summary'],
      // `include` covers every source file, not only the imported ones, so a
      // file with NO test counts as 0% rather than being absent. An untested
      // file is exactly what a floor exists to notice, and omitting it is how
      // coverage numbers flatter a codebase. (vitest does this by default for
      // whatever `include` matches.)
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        // Type-only, so it reports 0% forever.
        'src/vite-env.d.ts',
      ],
      // The floor belongs here rather than in a CI flag, so `npm run
      // test:coverage` locally gives the same verdict CI does.
      //
      // Measured, not chosen: each floor is the suite's actual figure minus one
      // point, rounded down, and shared-workflows' coverage-ratchet (which CI
      // runs after this, with `slack: 3`) fails when any floor is more than 3
      // points under the actual figure (#506, #602). The ratchet prints the
      // measured figure rounded down as the floor to write; write one point
      // under it, as the rest here are. At 14-24 points of slack coverage could fall by
      // double digits without a red build, so the ratchet was nominal. Raise a
      // floor in the same change that raises coverage; never lower one to make a
      // branch green. A round target picked in advance just produces tests
      // written to move a number.
      //
      // Nothing is excluded to flatter these numbers. The files only the
      // Playwright suite exercises (App.tsx, editorRuntime.tsx and the
      // `index.ts` barrels) are deliberately still counted, at 0%: that is the
      // honest figure for "covered by vitest", and it is why
      // `src/components/**` sits below the other directories. main.tsx and
      // src/workers/*Worker.ts were once excluded as "cannot be instantiated
      // under node"; main.test.tsx and the worker tests do instantiate them, so
      // they are measured like the rest.
      thresholds: {
        // Measured again when the engine, the best-covered code here, moved to
        // its own repository (ADR 0023).
        statements: 93,
        branches: 86,
        functions: 91,
        lines: 94,
        // Each source directory has a floor of its own: the global figure
        // would hide a fall in any one of them. The engine's floors are in its
        // own repository (ADR 0023).
        'src/components/**': {
          statements: 92,
          branches: 83,
          functions: 89,
          lines: 93,
        },
        // Lower since #566 moved workerLifecycle.ts, a well-covered module, to
        // src/workers; the hooks themselves are covered as before.
        'src/hooks/**': {
          statements: 93,
          branches: 83,
          functions: 95,
          lines: 95,
        },
        'src/monaco/**': {
          statements: 97,
          branches: 95,
          functions: 97,
          lines: 98,
        },
        'src/store/**': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        // Both measured again when ADR 0023 moved the engine's four modules out
        // of src/utils and its three worker entry points into src/workers: the
        // entry points are less covered than the lifecycle beside them.
        'src/utils/**': {
          statements: 95,
          branches: 91,
          functions: 99,
          lines: 96,
        },
        'src/workers/**': {
          statements: 91,
          branches: 84,
          functions: 85,
          lines: 92,
        },
      },
    },
  },
});
