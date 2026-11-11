import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

// The vitest config Stryker runs (`npm run test:mutation`, stryker.config.mjs).
// It is the normal one with three changes.
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
// 3. None of the directive-evidence machinery. The base config records what
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
  test: {
    ...base.test,
    projects: undefined,
    // Instrumented code is slower. Once responseBudget.ts was mutated (#571),
    // the dry run's serializeSimulation test, which calls it in its loops,
    // passed 20 s and every full run stopped before mutating anything (#728).
    // Each mutant still gets Stryker's own timeout, from the dry run's times.
    testTimeout: 120_000,
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
      'packages/mcp-server/src/__tests__/responseBudget.test.ts',
      // What tools.ts's handlers are tested by. Not toolsProperties.test.ts:
      // with responseBudget.ts instrumented, its serializer property runs
      // past testTimeout.
      'packages/mcp-server/src/__tests__/tools.test.ts',
      'packages/mcp-server/src/__tests__/adversarial.test.ts',
      'packages/mcp-server/src/__tests__/runInWorker.test.ts',
      // The worker lifecycle and the store (#508), the two non-engine modules
      // whose logic the app's correctness leans on. Both are plain modules; the
      // store's test opts into jsdom itself, once, for a file.
      'src/workers/__tests__/workerLifecycle*.test.ts',
      'src/workers/__tests__/workerRequestQueue.test.ts',
      'src/store/__tests__/*.test.ts',
      // The editor's language support (#816).
      'src/monaco/__tests__/*.test.ts',
    ],
    exclude: [
      ...configDefaults.exclude,
      'src/engine/__tests__/workerReady.test.ts',
      // Every worker entry's own test, by name, so the next one is excluded too.
      'src/engine/__tests__/*Worker.test.ts',
      'src/engine/__tests__/directiveEvidence.test.ts',
    ],
  },
});
