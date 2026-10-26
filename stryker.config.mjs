// @ts-check
// Mutation testing for the engine (#370): `npm run test:mutation`. Coverage
// says a line ran; this says whether any test would notice the line being
// wrong. See CONTRIBUTING.md for how to read a run and when CI runs it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // Engine tests only, plus a vitest 5 compatibility shim; the file says why.
  vitest: { configFile: 'vitest.stryker.config.ts' },

  // src/engine is where correctness lives, so it is what gets mutated. Left out:
  // type-only modules (no code to mutate), the worker entry points (a
  // `self.onmessage` wrapper the Node suite cannot instantiate), and the
  // generated or hand-written data tables — the directive registry, the CIM
  // models and the support roster — whose mutants are edits to description
  // prose that no behavioural test should be asserting.
  mutate: [
    'src/engine/**/*.ts',
    // The date parser and the regex adapter the engine runs on.
    'src/utils/strftime.ts',
    'src/utils/splunkRegex.ts',
    // The MCP server's pure functions (#455): the oversize-message limiter,
    // the request-id scan behind its error, and the response serializer.
    'packages/mcp-server/src/requestId.ts',
    'packages/mcp-server/src/messageLimit.ts',
    'packages/mcp-server/src/serialize.ts',
    // The response budget (#571): measured at 78.7% on its own tests. tools.ts
    // is not here yet: 72.8% with runInWorker's tests, under the floor.
    'packages/mcp-server/src/responseBudget.ts',
    // The worker lifecycle (post, ready, watchdog, crash) and the app store
    // (#508): state machines with real logic, and tests that ran in the app's
    // suite but were never asked whether they would notice a wrong edit.
    // src/monaco is not here: its providers are tested against a fake of
    // Monaco's model, so a mutant there is killed or spared by how faithful the
    // fake is, and the run's cost is the jsdom start of a dozen test files per
    // mutant. See CONTRIBUTING.md.
    'src/workers/workerLifecycle.ts',
    // Was under src/engine until #566 moved the worker plumbing to src/workers.
    'src/workers/workerProtocol.ts',
    'src/store/**/*.ts',
    '!src/store/**/__tests__/**',
    '!src/engine/**/__tests__/**',
    '!src/engine/**/*.test.ts',
    '!src/engine/types.ts',
    '!src/engine/scaffold/types.ts',
    '!src/engine/*Worker.ts',
    '!src/engine/cim/cimModelsData.ts',
    '!src/engine/registry/**',
    '!src/engine/directiveSupport.ts',
  ],

  // Each mutant runs only the tests that reached it — the difference between
  // an hour and most of a day.
  coverageAnalysis: 'perTest',
  // A "static" mutant changes a module-level value (a regex constant, a lookup
  // table) that is built once at import, so no single test can be said to cover
  // it and Stryker has to rerun the whole suite for each. There are ~900 of
  // them and they cost more than every other mutant combined, which would put a
  // full run past three hours. They are reported as Ignored, not counted either
  // way; `MUTATION_STATIC=1 npm run test:mutation -- --mutate <file>` runs them
  // when you are changing one of those constants. CI does not: a whole-engine run
  // with them needs 6 to 12 hours on four cores, past GitHub's 6-hour job limit,
  // so the monthly run that was to report them never finished (#571).
  //
  // An environment variable, because Stryker's `--ignoreStatic` flag can only
  // switch the option on: `--ignoreStatic false` reads `false` as the path of a
  // config file and fails.
  ignoreStatic: process.env.MUTATION_STATIC !== '1',

  reporters: ['clear-text', 'progress', 'html', 'json'],
  // The score table, not the thousands of individual survivors: those are what
  // the HTML report (reports/mutation/mutation.html) is for.
  clearText: { reportMutants: false, reportTests: false },

  // `break` is the floor: below it the run exits non-zero, which is what fails
  // the mutation workflow. Measured, not chosen: 3 points under the 84.90% the
  // whole engine scored on 2026-10-26, the slack the coverage ratchet uses. At
  // 1.6 points, one change that killed fewer mutants turned the weekly run red
  // with no PR to blame (#571). Raise it when tests raise the score; never lower
  // it to make a branch green.
  //
  // `low` is the edge of the warning band: a score between `break` and `low`
  // passes but is flagged in the report. It sat at `break`, so the band was empty
  // and the first sign of a slide was a red build (#508). Now a few points
  // above, so a run drifting toward the floor is visible before it fails.
  thresholds: { high: 85, low: 83, break: 81 },
};
