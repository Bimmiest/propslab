// @ts-check
// Mutation testing (#370): `npm run test:mutation`. Coverage
// says a line ran; this says whether any test would notice the line being
// wrong. See docs/testing.md for how to read a run and when CI runs it.
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  // The file says which tests, and why.
  vitest: { configFile: 'vitest.stryker.config.ts' },

  // The modules with real logic outside the engine, whose own mutation run is
  // in its repository (ADR 0023). Left out: the components, which the
  // component tests cover, and the worker entry points, each a
  // `self.onmessage` wrapper.
  mutate: [
    // The MCP server's pure functions (#455): the oversize-message limiter,
    // the request-id scan behind its error, and the response serializer.
    'packages/mcp-server/src/requestId.ts',
    'packages/mcp-server/src/messageLimit.ts',
    'packages/mcp-server/src/serialize.ts',
    // The response budget and the tool handlers (#571). tools.ts runs the engine
    // in a worker, which loads the built bundle, so what is mutated here is the
    // handlers' own logic: limits, error advice and the lookup tool.
    'packages/mcp-server/src/responseBudget.ts',
    'packages/mcp-server/src/tools.ts',
    // The worker lifecycle (post, ready, watchdog, crash) and the app store
    // (#508): state machines with real logic, and tests that ran in the app's
    // suite but were never asked whether they would notice a wrong edit.
    'src/workers/workerLifecycle.ts',
    'src/workers/workerProtocol.ts',
    'src/store/**/*.ts',
    // The editor's language support (#816, #836). Its providers run against
    // src/test/fakeModel.ts, which fakeModel.contract.test.ts holds to a real
    // model, and the TIME_FORMAT preview's worker runs against a fake worker.
    'src/monaco/*.ts',
    '!src/store/**/__tests__/**',
  ],

  // Each mutant runs only the tests that reached it — the difference between
  // an hour and most of a day.
  coverageAnalysis: 'perTest',
  // A "static" mutant changes a module-level value (a regex constant, a lookup
  // table) that is built once at import, so no single test can be said to cover
  // it and Stryker has to rerun the whole suite for each. There are about 900.
  // The full run in CI includes them: mutation.yml sets MUTATION_STATIC=1, and
  // they add about 40 minutes of work, split across its shards (#857). A PR run
  // and a local run skip them, to stay fast, and report them as Ignored;
  // `MUTATION_STATIC=1 npm run test:mutation -- --mutate <file>` runs them when
  // you change one of those constants.
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
  // the mutation workflow. Measured, not chosen: 3 points under the 91.15% that
  // the modules above scored in the weekly run of 2026-11-09, when the engine
  // and its 85.90% moved to its own repository (ADR 0023). 3 points is the
  // slack the coverage ratchet uses. At
  // 1.6 points, one change that killed fewer mutants turned the weekly run red
  // with no PR to blame (#571). Raise it when tests raise the score; never lower
  // it to make a branch green.
  //
  // `low` is the edge of the warning band: a score between `break` and `low`
  // passes but is flagged in the report. It sat at `break`, so the band was empty
  // and the first sign of a slide was a red build (#508). Now a few points
  // above, so a run drifting toward the floor is visible before it fails.
  //
  // A shard of the weekly run (MUTATION_SHARD=1) has no floor of its own:
  // scripts/check-mutation-score.mjs holds the shards' combined score to
  // `break` (#851). One shard alone can be below the floor while the run is not.
  thresholds: { high: 92, low: 90, break: process.env.MUTATION_SHARD === '1' ? null : 88 },
};
