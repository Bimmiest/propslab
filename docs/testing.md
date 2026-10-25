# Tests

This file describes the two test suites: the unit tests under vitest, and the end-to-end suite under Playwright. [development.md](development.md#scripts) lists the scripts that run them. [CONTRIBUTING.md](../CONTRIBUTING.md#the-ci-checks) gives the rules for tests, the coverage floors and mutation testing.

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

[deployment.md](deployment.md) describes the CI jobs that run these suites.
