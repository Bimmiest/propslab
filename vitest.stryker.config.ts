import { configDefaults, defineConfig } from 'vitest/config';
import base from './vitest.config';

// The vitest config Stryker runs (`npm run test:mutation`, stryker.config.mjs).
// It is the normal one with two changes.
//
// 1. Only the tests of the modules in stryker.config.mjs's `mutate`. The
//    component tests start jsdom per file, which is most of a mutant run's
//    cost, for kills that the tests of those modules should be making.
//
// 2. Not the worker-entry tests in src/workers. They re-import the engine
//    inside a test (vi.resetModules), so every module-level constant — a
//    regex, a lookup table — is attributed to that one test, and Stryker runs
//    each such mutant against it alone. It cannot fail, so ~700 mutants read as
//    SURVIVED that no other test was ever given the chance to kill. The worker
//    entry points are outside `mutate` anyway, and CI still runs these tests.
//
// The engine's own mutation run is in its repository (ADR 0023).

// Spread rather than mergeConfig, which concatenates arrays and would ADD this
// include to the base one instead of replacing it.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Instrumented code is slower. Once responseBudget.ts was mutated (#571),
    // the dry run's serializeSimulation test, which calls it in its loops,
    // passed 20 s and every full run stopped before mutating anything (#728).
    // Each mutant still gets Stryker's own timeout, from the dry run's times.
    testTimeout: 120_000,
    // The tests of the MCP server modules in stryker.config.mjs's `mutate`,
    // and those of the app modules it names. The
    // package's tests import its SDK from packages/mcp-server/node_modules,
    // so a run needs that install too.
    include: [
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
      // By name, not a glob: the worker-entry tests beside them stay out (2.).
      'src/workers/__tests__/workerLifecycle*.test.ts',
      'src/workers/__tests__/workerRequestQueue.test.ts',
      'src/store/__tests__/*.test.ts',
      // The editor's language support (#816).
      'src/monaco/__tests__/*.test.ts',
    ],
    exclude: [...configDefaults.exclude],
  },
});
