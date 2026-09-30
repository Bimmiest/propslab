import { createRequire } from 'node:module';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Where src/test/recordDirectiveEvidence.ts leaves what each test file fed to
// runPipeline. This file is evaluated once, in the main process, and workers
// inherit the environment, so every file of one invocation shares one
// directory and two invocations never share one. The directory goes when the
// main process does, whichever projects that run reached: a run of a single
// test file writes into it too, and has no project to clean up after it.
const evidenceDir = join(tmpdir(), `propslab-directive-evidence-${String(process.pid)}-${String(Date.now())}`);
process.env.PROPSLAB_EVIDENCE_DIR = evidenceDir;
process.once('exit', () => {
  rmSync(evidenceDir, { recursive: true, force: true });
});

const UNIT_TESTS = ['src/**/*.test.{ts,tsx}'];
const EVIDENCE_TEST = 'src/engine/__tests__/directiveEvidence.test.ts';

export default defineConfig({
  plugins: [react()],
  // Mirrors the build-time define in vite.config.ts. Without it any component
  // reading the version throws under test.
  define: {
    __APP_VERSION__: JSON.stringify('test'),
    // Read by src/test/setup.ts to instantiate the regex engine.
    __PCRE2_WASM_PATH__: JSON.stringify(createRequire(import.meta.url).resolve('pcre2-wasm-utf16/pcre2.wasm')),
  },
  test: {
    // Default to node for engine tests; component tests opt into jsdom via
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    setupFiles: ['src/test/setup.ts', 'src/test/recordDirectiveEvidence.ts'],
    restoreMocks: true,
    unstubGlobals: true,
    unstubEnvs: true,
    testTimeout: 20000,
    // Two projects, run one after the other. `unit` is every test but one;
    // `evidence` is the one test that reads what the others recorded, so it has
    // to start after they have all finished. `groupOrder` is what guarantees
    // that: projects in the same group run together, groups run lowest first.
    // See src/test/recordDirectiveEvidence.ts.
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: UNIT_TESTS,
          exclude: [...configDefaults.exclude, EVIDENCE_TEST],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'evidence',
          include: [EVIDENCE_TEST],
          sequence: { groupOrder: 1 },
        },
      },
    ],
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
        // Type-only modules compile to nothing, so they report 0% forever.
        'src/engine/types.ts',
        'src/vite-env.d.ts',
        // A generated data table: large, literal, and asserted through the
        // modules that read it rather than directly.
        'src/engine/cim/cimModelsData.ts',
        // Type-only.
        'src/engine/scaffold/types.ts',
      ],
      // The floor belongs here rather than in a CI flag, so `npm run
      // test:coverage` locally gives the same verdict CI does.
      //
      // Measured, not chosen: each floor is the suite's actual figure minus one
      // point, rounded down, and scripts/check-coverage-floors.mjs (which CI
      // runs after this) fails when any floor is more than 3 points under the
      // actual figure (#506). At 14-24 points of slack coverage could fall by
      // double digits without a red build, so the ratchet was nominal. Raise a
      // floor in the same change that raises coverage; never lower one to make a
      // branch green. A round target picked in advance just produces tests
      // written to move a number.
      //
      // Nothing is excluded to flatter these numbers. The files only the
      // Playwright suite exercises (App.tsx, SplunkEditor.tsx,
      // PropsConfEditor.tsx, TransformsConfEditor.tsx, editorRuntime.tsx,
      // SimulatorView.tsx, ScaffoldModal.tsx and the `index.ts` barrels) are
      // deliberately still counted, at or near 0%: that is the honest figure
      // for "covered by vitest", and it is why `src/components/**` sits well
      // below `src/engine/**`. main.tsx and src/engine/*Worker.ts were once
      // excluded as "cannot be instantiated under node"; main.test.tsx and the
      // worker tests do instantiate them, so they are measured like the rest.
      thresholds: {
        statements: 92,
        branches: 84,
        functions: 89,
        lines: 92,
        // The engine is held to a much higher bar than the app as a whole. It
        // is where correctness lives — a simulator whose UI is under-tested is
        // annoying, whereas one whose pipeline is under-tested is wrong — and
        // reporting only an aggregate would let engine coverage rot behind a
        // healthy-looking global number. The same goes, less strictly, for the
        // other source directories: the global figure is dominated by the
        // engine and would hide a fall in any one of them.
        'src/engine/**': {
          statements: 96,
          branches: 89,
          functions: 98,
          lines: 97,
        },
        'src/components/**': {
          statements: 83,
          branches: 75,
          functions: 80,
          lines: 85,
        },
        'src/hooks/**': {
          statements: 92,
          branches: 82,
          functions: 95,
          lines: 96,
        },
        'src/monaco/**': {
          statements: 91,
          branches: 83,
          functions: 95,
          lines: 92,
        },
        'src/store/**': {
          statements: 99,
          branches: 99,
          functions: 99,
          lines: 99,
        },
        'src/utils/**': {
          statements: 93,
          branches: 87,
          functions: 99,
          lines: 96,
        },
      },
    },
  },
});
