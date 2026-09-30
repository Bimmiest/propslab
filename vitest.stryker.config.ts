import { defineConfig, type Plugin } from 'vitest/config';
import base from './vitest.config';

// The vitest config Stryker runs (`npm run test:mutation`, stryker.config.mjs).
// It is the normal one with four changes.
//
// 1. Only the engine's own tests. Mutants live in src/engine/**, and the
//    component tests that also import the engine start jsdom per file — most
//    of a mutant run's cost, for kills the engine suite should be making
//    itself. An engine mutant that only a component test notices is a gap in
//    the engine suite.
//
// 2. Not the worker-entry tests. They re-import the engine inside a test
//    (vi.resetModules), so every module-level constant — a regex, a lookup
//    table — is attributed to that one test, and Stryker runs each such mutant
//    against it alone. It cannot fail, so ~700 mutants read as SURVIVED that no
//    other test was ever given the chance to kill. The worker entry points are
//    outside `mutate` anyway, and CI still runs these tests.
//
// 3. A shim for a Stryker/vitest 5 mismatch that otherwise makes every result
//    meaningless. Stryker runs each mutant against only the tests that cover
//    it, by setting `testNamePattern` to their names joined with spaces
//    ("suite test"). Vitest 5 matches that pattern against names joined with
//    " > " ("suite > test"), so any test inside a describe() is filtered out,
//    zero tests run, and the mutant is reported as SURVIVED — the run looks
//    healthy and scores near zero. The setter below accepts either separator.
//    Remove it once @stryker-mutator/vitest-runner joins names the way vitest
//    does; the tell is a run where a mutant nothing could miss survives.
const strykerTestNamePattern: Plugin = {
  name: 'propslab:stryker-test-name-pattern',
  configureVitest({ project }) {
    let pattern: RegExp | undefined;
    Object.defineProperty(project.config, 'testNamePattern', {
      configurable: true,
      enumerable: true,
      get: () => pattern,
      set: (value: RegExp | undefined) => {
        pattern = value && new RegExp(value.source.replaceAll(' ', '(?: > | )'), value.flags);
      },
    });
  },
};

// 4. None of the directive-evidence machinery. The base config records what
//    tests feed `runPipeline` (src/test/recordDirectiveEvidence.ts) for the one
//    test that reads it back, which needs the whole suite in one invocation
//    across two projects. A mutant run is neither, so the recorder is dropped,
//    the projects are collapsed to the single `include` below, and that test is
//    excluded.
delete process.env['PROPSLAB_EVIDENCE_DIR'];

// Spread rather than mergeConfig, which concatenates arrays and would ADD this
// include to the base one instead of replacing it.
export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), strykerTestNamePattern],
  test: {
    ...base.test,
    projects: undefined,
    setupFiles: (base.test?.setupFiles as string[] | undefined)?.filter((f) => !f.includes('recordDirectiveEvidence')),
    // The engine's tests, those of the two utils the engine runs on, those of
    // the MCP server modules in stryker.config.mjs's `mutate`, and those of the
    // two app modules it names. The
    // package's tests import its SDK from packages/mcp-server/node_modules,
    // so a run needs that install too.
    include: [
      'src/engine/**/*.test.ts',
      'src/utils/__tests__/strftime*.test.ts',
      'src/utils/__tests__/splunkRegex*.test.ts',
      'packages/mcp-server/src/__tests__/requestId.test.ts',
      'packages/mcp-server/src/__tests__/messageLimit.test.ts',
      'packages/mcp-server/src/__tests__/serialize.test.ts',
      // The worker lifecycle and the store (#508), the two non-engine modules
      // whose logic the app's correctness leans on. Both are plain modules; the
      // store's test opts into jsdom itself, once, for a file.
      'src/hooks/__tests__/workerLifecycle*.test.ts',
      'src/store/__tests__/*.test.ts',
    ],
    exclude: [
      ...(base.test?.exclude ?? []),
      'src/engine/__tests__/workerReady.test.ts',
      'src/engine/__tests__/timestampMatchWorker.test.ts',
      'src/engine/__tests__/directiveEvidence.test.ts',
    ],
  },
});
