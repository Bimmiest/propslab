---
type: reference
---

# Tests

This file describes the two test suites: the unit tests under vitest, and the end-to-end suite under Playwright. [development.md](development.md#scripts) lists the scripts that run them. This file also gives the rules for tests, the coverage floors and mutation testing. [CONTRIBUTING.md](../CONTRIBUTING.md#tests) has the summary.

## The rules

- **Tests are linted for what makes them tests** (`@vitest/eslint-plugin`): `expect-expect` fails a case with no assertion, `no-identical-title` a repeated case name, `valid-expect` an unfinished or un-awaited `expect`. A helper that asserts for the test is named `expect…` (the rule accepts that pattern), and `fc.assert` counts as an assertion.
- **Coverage is a floor, and a ratchet.** The thresholds live in `vitest.config.ts` (and `packages/mcp-server/vitest.config.mts`) so a local run gives the same verdict CI does. The engine is held to a higher bar than the app as a whole, because a simulator whose UI is under-tested is annoying while one whose pipeline is under-tested is wrong; `src/components`, `hooks`, `monaco`, `store`, `utils` and `workers` each have a floor too, so the engine's number cannot hide a fall elsewhere. Each floor is the measured figure minus one point, and shared-workflows' coverage-ratchet (run by CI after the tests, with `slack: 3`) fails when one is more than 3 points under. It prints the measured figure rounded down as the floor to write; write one point under that, which keeps the MCP server's floors clear of its Windows and macOS legs. So a change that raises coverage also raises the floor, in the same commit; do not lower one to make a branch green. Nothing is excluded to flatter the numbers: files only the Playwright suite exercises stay counted at or near 0%.
- **Test scaffolding is shared.** `src/test/makeEvent.ts` builds a `SplunkEvent` (`makeEvent(raw, { fields })`), `src/test/fakeModel.ts` a Monaco text model, and `src/test/fcSeed.ts` every fast-check seed: a property test passes `fcSeed(<its default>)` and never a bare number, so `FC_SEED` can re-seed it. The weekly `randomised` job in `ci.yml` draws a fresh `FC_SEED`, shuffles the order, and runs under another timezone and locale; it prints the seed and the command that replays the run. A new test file uses these rather than defining its own event literal or model stand-in.
- **A test does not time itself.** No `performance.now()`, `Date.now()` or `toBeLessThan(<ms>)` in a unit test: a stopwatch assertion fails on a loaded runner and passes on a fast one. Pick the bound that is about the claim instead. For a linear-time claim, count the work: `expectLinearWork` in `src/test/scanWork.ts` runs a function at size *n* and *2n* and fails when the length its slices, joins and searches touch more than triples (linear doubles, quadratic quadruples), and a spy on the built-in the fix removed (`indexOf` in `wildcardMatch.test.ts`, `RegExp.prototype.test` in `redosHeuristic.test.ts`) counts calls. Where the cost hides inside one regex call and nothing can be counted, size the input so the quadratic version cannot finish inside the test's own timeout. For "answers promptly" or "frees the slot" in the MCP server, make the alternative outlast the test's timeout (a worker that sleeps 60 s in a 20 s test) or assert the order events happened in. Check that a new bound bites by reintroducing the bug once. The Playwright timing budgets live in their own non-retried `perf` project.

## Unit tests (`npm test`)

The tests are in `src/**/__tests__/`, and they run under vitest. The engine tests are for the modules with the highest risk:

- line breaking
- eval
- regex transforms
- dest-key routing
- the stanza matcher
- indexed extractions
- a regression suite for statelessness.

Component smoke tests cover StatusBar, HighlightedTab, FieldsTab and RegexTab in jsdom. `npm test` prints the current total. Three times, a number written here became incorrect.

The engine tests use the `node` environment by default. Each component test selects jsdom with `// @vitest-environment jsdom` at the top of its file. Thus the engine tests do not pay the cost of jsdom.

## End-to-end (`npm run test:e2e`)

A small Playwright suite in `e2e/` runs Chromium against a **production build**. `playwright.config.ts` rebuilds before it serves the app, because an old `dist/` gives wrong answers with confidence. `npm run test:e2e:ui` opens the interactive runner.

**The e2e suite runs against `dist/`, not the dev server.** A change that works under `vite dev` and not in a production build will pass locally and fail in CI.

The suite is for the things that vitest cannot reach, because of its structure. Each of these things failed silently here before:

- **The Content-Security-Policy.** The policy is a `<meta>` tag in `index.html`, and it has an effect only in a browser. A `<meta>` policy applies only to the document. Thus `public/staticwebapp.config.json` also sends the policy as a response header, which is the only way that it reaches the three workers. The header also sends `frame-ancestors`, `Cross-Origin-Opener-Policy` and a `Permissions-Policy`. A unit test (`src/__tests__/deployHeaders.test.ts`) fails if the header drops a directive that the meta tag has.

  During all of the life of the policy, `img-src` was not in it. Thus Chromium refused each of the `data:` squiggle SVGs of Monaco, and the lint underlines never appeared. The only sign was a console error, and nobody watched the console. The suite asserts zero CSP violations and zero console errors when the app starts.

  The policy also requires Trusted Types (`require-trusted-types-for 'script'`). It allows only the named policies of Monaco and a `default` policy (`src/trustedTypes.ts`) that admits same-origin worker URLs. A smoke test uses the editor, a hover, the palette and the dictionary, and fails on any violation.
- **The worker bundle.** All of the simulation runs in a Web Worker that `new Worker(new URL(…), { type: 'module' })` creates. Whether Vite emits a loadable chunk for that worker is a build-time question. Only the runtime gives the answer.
- **The regex engine.** PCRE2 is a WebAssembly asset. The page and each worker load it from one same-origin URL, which the build sets. The suite checks these things:
  - It loads under the CSP (`'wasm-unsafe-eval'`).
  - Each load is of that one asset.
  - It answers in all three workers.
  - Fetch, compile and instantiate stay inside a 2 s budget. The measured time is about 80 ms.
- **The Monaco chunk split.** `MonacoEditor.tsx` imports the slim `monaco-editor/editor` entry, and `vite.config.ts` hand-rolls a `codeSplitting` group around it. A bad split passes the type-check and the build, and then the editor does not mount. Each hand-picked editor contribution (suggest, code actions, folding, find, hover) has a test, because the absence of a contribution also fails silently.
- **Accessibility.** `a11y.spec.ts` runs axe-core over each main view, in both themes. The main views are the simulator, each output tab, the dictionary, the command palette, the settings, the pipeline reference and the mobile layout. The test fails on any WCAG 2.2 AA or best-practice violation. Nothing is excluded, and that includes Monaco, because its colours come from our own themes.
- **Performance.** `perf.spec.ts` does three things:
  - It pastes 20k events into the raw log.
  - It runs a regex-heavy config over large events.
  - It renders an event with 3,000 fields.

  It holds the pipeline and each tab change to a budget. Each budget is several times what a local run measures.

  `perf-vitals.spec.ts` loads the production build cold. It holds LCP, total blocking time and transferred bytes to budgets that come from measurements. Budgets for the size of each chunk are not sufficient alone: one time, they let the entry preload all of Monaco. These tests run in the `perf` Playwright project, which has no retries. They write their numbers to the job summary, with the budget next to each number.

If you extend the suite, remember this. The app runs the pipeline one time on mount, with an empty raw log. `runPipeline` returns a real result for empty input (`eventCount: 0`). Thus the status bar shows "Worker idle · 0 events" *before* any data loads. Wait for an event count that is not zero, as `loadExample` does. Do not wait for the idle state.

`@playwright/test` is pinned to `~1.64.1`. The pin matches a specific Chromium revision, so that local development is consistent. You can bump it at any time. CI installs the browser that agrees with each version, so the pin has no effect on CI runs.

[ci.md](ci.md) describes the CI jobs that run these suites.

## Mutation testing

Coverage says a line ran; it does not say a test would notice the line being wrong. [Stryker](https://stryker-mutator.io/) answers that by making small edits to `src/engine/**`, the two utils it runs on (`strftime.ts`, `splunkRegex.ts`), and five modules of the MCP server (`requestId.ts`, `messageLimit.ts`, `serialize.ts`, `responseBudget.ts`, `tools.ts`), the worker lifecycle and its message protocol (`src/workers/workerLifecycle.ts`, `src/workers/workerProtocol.ts`) and the store (`src/store`) — flipping a `<`, emptying a string, deleting a call — and rerunning the tests that reach each one. A mutant no test fails on has *survived*, and marks behaviour nothing asserts.

```bash
npm run test:mutation                  # full run; about 2½ hours on 4 cores (12,713 mutants in October 2026)
npm run test:mutation -- --mutate src/engine/processors/kvMode.ts   # one file, a few minutes
npm run test:mutation -- --mutate packages/mcp-server/src/requestId.ts
```

Every run includes those modules' tests, which need the MCP server installed and built (`npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server`): one of them talks to the built server. Those three score 90.9% together; the worker lifecycle scores 91% and the store 82% (its setters have their own tests in `useAppStore.actions.test.ts`).

Open `reports/mutation/mutation.html` for the survivors, line by line. The engine scores 84.9%, and `thresholds.break` in [`stryker.config.mjs`](../stryker.config.mjs) holds it at 81% — a floor and a ratchet, like coverage, with the same 3 points of slack. `thresholds.low` (83) is the warning band's edge: a score between the two passes, flagged in the report, so a slide toward the floor is seen before the build goes red.

- **It is not in `ci.yml`.** A full run is too slow for every PR. [`mutation.yml`](../.github/workflows/mutation.yml) runs the whole engine weekly and on demand, and on a PR mutates only the engine source files the PR changes, holding those to the same floor. If a PR changes a test, the run also mutates the source files that the test imports. `scripts/mutation-targets.mjs` reads the scope from the `mutate` list in `stryker.config.mjs`, so the scope is written in one place. A PR that touches a weakly tested file adds the tests that bring it up.
- **A change to formatting or comments only is not mutated.** `scripts/drop-format-only.mjs` drops a changed file when Prettier prints its old and new text identically, or when the two parse to the same code once comments are removed, so a reformat or a comment edit does not re-mutate the whole engine. A change to a `Stryker disable` or `Stryker restore` comment, and any change to code, keeps the file in.
- **Kill a survivor with a test that asserts behaviour**, not one written to move the number. Some survivors are *equivalent* — the mutant cannot change any result (a cache miss that recomputes the same value, a `??` whose left side is never nullish). Leave those.
- **Module-level constants are skipped** (`ignoreStatic`): they cost a full suite each, and there are about 900. Run `MUTATION_STATIC=1 npm run test:mutation -- --mutate <file>` when you change one (Stryker's `--ignoreStatic` flag can only switch the option on, so `--ignoreStatic false` fails). CI does not run them: with them a whole-engine run needs 6 to 12 hours on four cores, past GitHub's 6-hour job limit (#571).
- **`src/monaco` is not mutated, yet.** Measured once (#508): 1,200 mutants, 18 minutes on 4 cores, and a score of 66.9% (`splunkConfHover.ts` 42%, `splunkConfCompletion.ts` 57%, `timePrefixMatcher.ts` 67%; `splunkConfFolding.ts` and `markdown.ts` are above 90%). Adding it now would fail the 81% floor on every PR that touches a provider, before it made a single one better. The way in: raise the two weakest files with tests that assert the provider's output, then add `src/monaco/*.ts` to `mutate` in `stryker.config.mjs` and `src/monaco/__tests__/*.test.ts` to `include` in `vitest.stryker.config.ts`.
- **`vitest.stryker.config.ts` carries a compatibility shim** for `@stryker-mutator/vitest-runner` 10 on vitest 5, without which every mutant inside a `describe()` is reported as surviving. When you bump either package, check that a run still kills mutants; the comment in that file says what to look for. `npm run test:mutation:canary` does it: it mutates one small, thoroughly tested file (`wildcardMatch.ts`, about 40 seconds) and `scripts/check-mutation-canary.mjs` fails if nearly all its mutants survive, which is what a broken shim looks like. `mutation.yml` runs it before every mutation run.
