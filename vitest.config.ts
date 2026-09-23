import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Mirrors the build-time define in vite.config.ts. Without it any component
  // reading the version throws under test.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
  },
  test: {
    // Default to node for engine tests; component tests opt into jsdom via
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
    coverage: {
      provider: 'v8',
      // Text for a local run, lcov for anything that wants to ingest it, and
      // json-summary so the numbers can be read back without re-running.
      reporter: ['text', 'lcov', 'json-summary'],
      // `include` covers every source file, not only the imported ones, so a
      // file with NO test counts as 0% rather than being absent. An untested
      // file is exactly what a floor exists to notice, and omitting it is how
      // coverage numbers flatter a codebase. (vitest 4 does this by default for
      // whatever `include` matches; the v3 `all` flag no longer exists.)
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/__tests__/**',
        'src/test/**',
        // Type-only modules compile to nothing, so they report 0% forever.
        'src/engine/types.ts',
        'src/vite-env.d.ts',
        'src/main.tsx',
        // A generated data table: large, literal, and asserted through the
        // modules that read it rather than directly.
        'src/engine/cim/cimModelsData.ts',
        // Worker entry points. They are a `self.onmessage` wrapper around an
        // engine function that IS tested; a `node` test cannot instantiate one,
        // so they would sit at 0% and drag a floor down while saying nothing.
        // The Playwright suite exercises them against the real build.
        'src/engine/*Worker.ts',
        // Type-only.
        'src/engine/scaffold/types.ts',
      ],
      // The floor belongs here rather than in a CI flag, so `npm run
      // test:coverage` locally gives the same verdict CI does.
      //
      // Measured, not chosen: these are what the suite produces today, rounded
      // down. Raise them when real work raises coverage; never lower them to
      // make a branch green. A round target picked in advance just produces
      // tests written to move a number.
      thresholds: {
        statements: 76,
        branches: 68,
        functions: 64,
        lines: 78,
        // The engine is held to a much higher bar than the app as a whole. It
        // is where correctness lives — a simulator whose UI is under-tested is
        // annoying, whereas one whose pipeline is under-tested is wrong — and
        // reporting only an aggregate would let engine coverage rot behind a
        // healthy-looking global number.
        'src/engine/**': {
          statements: 92,
          branches: 83,
          functions: 97,
          lines: 94,
        },
      },
    },
  },
});
