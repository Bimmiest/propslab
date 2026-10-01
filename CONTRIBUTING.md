# Contributing

Thanks for looking at this. Most of what follows is already enforced by CI — it is written down here so you do not have to reverse-engineer it from `.github/workflows/ci.yml`.

## Getting set up

Node is pinned in [`.nvmrc`](.nvmrc), matched by `engines` in `package.json`, and used by CI. Use that version; a different major will produce failures that have nothing to do with your change.

```bash
nvm use            # or: fnm use
npm install
npm ci --prefix packages/mcp-server
npm run dev        # http://localhost:5173
```

The `npm ci --prefix packages/mcp-server` is not optional if you intend to lint. `npm run lint` is type-aware over the whole repository, including `packages/mcp-server`, and that package resolves `@modelcontextprotocol/sdk` and `zod` from its own `node_modules`. Without them those types don't resolve and every use reports as an unsafe `any` — a wall of errors that have nothing to do with your change.

`.claude/` and `CLAUDE.md` are git-ignored (see `.gitignore`) and can be used freely by contributors for local project configuration.

## The CI checks

[`ci.yml`](.github/workflows/ci.yml) runs five jobs, independently, on every PR, on pushes to main, weekly and on demand (`dependency-review` on PRs only). A PR needs all of them green — and so does the automatic deploy, which runs only after a push to main's CI run passes and then ships the newest commit on main whose whole CI run passed. A manual deploy is not CI-gated: dispatching the deploy workflow on `main` redeploys that same newest green commit, or, with its `sha` input set, rolls back to any commit main has contained, whether or not its CI passed. A rollback only sticks if the repository variable `DEPLOY_PAUSED` is set to `true` *before* you dispatch it — otherwise the next automatic deploy undoes it, or cancels it while it is still queued — and it stays in place until you delete the variable once the fix is on main. The [README](README.md#tests) describes the deploy workflow in full.

**`ci`** — the app, in this order:

```bash
npm run lint          # ESLint, including type-aware rules (needs the MCP server's deps, above)
npm run format:check  # Prettier over the TypeScript and JavaScript sources; `npm run format` fixes what it reports
npm run build         # tsc -b && vite build — this is the type-check
npm run test:coverage # vitest, with the coverage floor enforced
npm run test:e2e      # Playwright, against a production build
```

**`mcp-server`** — the MCP server package, which has its own lockfile and toolchain:

```bash
cd packages/mcp-server
npm ci
npm run test:coverage # typecheck + esbuild bundle first, then vitest with the package's coverage floor
```

**`audit`** — `npm audit` over both lockfiles, the app's and `packages/mcp-server`'s. A high-severity advisory in a production dependency fails it; dev-only advisories are reported but never fatal. It installs nothing, so there is nothing to run locally beyond `npm audit --omit=dev --audit-level=high` in each directory.

**`workflow-lint`** — [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh/) over `.github/`. Locally: `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 && actionlint`, and `uvx zizmor==1.30.1 .` (or `pipx run`). A zizmor finding that is deliberate gets an inline `# zizmor: ignore[<audit>]` with the reason beside it, as the deploy workflow's `workflow_run` trigger has.

**`dependency-review`** — on PRs, GitHub's dependency review over the PR's dependency diff, failing on a newly added high-severity advisory. CodeQL is not a workflow here: it runs through GitHub's default code-scanning setup (JavaScript/TypeScript and Actions) and reports as the "Analyze" checks.

A few things worth knowing:

- **Formatting is Prettier's, and not discussed in review.** `.prettierrc.json` is the style the code already had: single quotes, semicolons, two-space indents and trailing commas, with a line width of 120. That width fits 98.6% of the existing code lines and changes about 40% fewer lines than a width of 100 would. It covers `.ts`, `.tsx`, `.js`, `.mjs` and `.mts` (not Markdown, JSON, CSS or the lockfile), and `.prettierignore` leaves out the generated `cimModelsData.ts`. `npm run format` rewrites the files. The commit that applied it to the whole tree is listed in `.git-blame-ignore-revs`, so `git blame` looks through it: run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once to get the same locally (GitHub reads the file by itself).
- **Lint is typescript-eslint's `strictTypeChecked`**, with two rules tuned in `eslint.config.js`, each beside its reason: `no-confusing-void-expression` allows arrow shorthand, and `restrict-template-expressions` allows numbers. A deliberate use of a deprecated browser API, or a guard for something jsdom lacks, gets an inline disable saying so.
- **No `!` in shipped code.** `no-non-null-assertion` is on everywhere except tests and their support files (`__tests__`, `*.test.*`, `src/test`, `e2e`), where `result[0]!` follows an assertion that it exists. In `src/` narrow instead: destructure, iterate rather than index, or check for `undefined`.
- **The engine's imports are checked.** `src/engine` (tests aside) may not import from `components`, `hooks`, `store` or `monaco`, nor React, zustand or Monaco. It is a `no-restricted-imports` rule with glob `patterns`, and `src/__tests__/eslintBoundary.test.ts` lints real import lines against the rule as configured, so a change to the config cannot quietly stop it matching.
- **Tests are linted for what makes them tests** (`@vitest/eslint-plugin`): `expect-expect` fails a case with no assertion, `no-identical-title` a repeated case name, `valid-expect` an unfinished or un-awaited `expect`. A helper that asserts for the test is named `expect…` (the rule accepts that pattern), and `fc.assert` counts as an assertion.
- **Imports are ordered** (`eslint-plugin-import-x`): Node built-ins, then packages, then the project's own files (parent, sibling and index alike), in that order and no finer. Within a group the order is yours, and side-effect imports (`import '../../test/monacoJsdom'`) are not ordered, so one that must run first can stay first. `npm run lint -- --fix` reorders a file; `src/__tests__/eslintImportOrder.test.ts` holds the rule to the imports it must catch.
- **`noPropertyAccessFromIndexSignature` is on**, with `noImplicitOverride`: a property that comes from an index signature (`process.env`, `dataset`, a `Record<string, T>`) is read as `x['name']`, so it cannot be mistaken for a declared one. `exactOptionalPropertyTypes` is off on purpose; `tsconfig.app.json` says why.
- **`npm run build` is the type-check.** There is no separate `tsc --noEmit` step, so a type error surfaces as a build failure.
- **The e2e suite runs against `dist/`, not the dev server.** A change that works under `vite dev` and not in a production build will pass locally and fail in CI. On a clean checkout the first run needs the browser: `npx playwright install chromium`.
- **Coverage is a floor, and a ratchet.** The thresholds live in `vitest.config.ts` (and `packages/mcp-server/vitest.config.mts`) so a local run gives the same verdict CI does. The engine is held to a higher bar than the app as a whole, because a simulator whose UI is under-tested is annoying while one whose pipeline is under-tested is wrong; `src/components`, `hooks`, `monaco`, `store` and `utils` each have a floor too, so the engine's number cannot hide a fall elsewhere. Each floor is the measured figure minus one point, and `node scripts/check-coverage-floors.mjs` (run by CI after the tests) fails when one is more than 3 points under. So a change that raises coverage also raises the floor, in the same commit; do not lower one to make a branch green. Nothing is excluded to flatter the numbers: files only the Playwright suite exercises stay counted at or near 0%.

- **Test scaffolding is shared.** `src/test/makeEvent.ts` builds a `SplunkEvent` (`makeEvent(raw, { fields })`), `src/test/fakeModel.ts` a Monaco text model, and `src/test/fcSeed.ts` every fast-check seed: a property test passes `fcSeed(<its default>)` and never a bare number, so `FC_SEED` can re-seed it. The weekly `randomised` job in `ci.yml` draws a fresh `FC_SEED`, shuffles the order, and runs under another timezone and locale; it prints the seed and the command that replays the run. A new test file uses these rather than defining its own event literal or model stand-in.
- **A test does not time itself.** No `performance.now()`, `Date.now()` or `toBeLessThan(<ms>)` in a unit test: a stopwatch assertion fails on a loaded runner and passes on a fast one. Pick the bound that is about the claim instead. For a linear-time claim, count the work: `expectLinearWork` in `src/test/scanWork.ts` runs a function at size *n* and *2n* and fails when the length its slices, joins and searches touch more than triples (linear doubles, quadratic quadruples), and a spy on the built-in the fix removed (`indexOf` in `wildcardMatch.test.ts`, `RegExp.prototype.test` in `redosHeuristic.test.ts`) counts calls. Where the cost hides inside one regex call and nothing can be counted, size the input so the quadratic version cannot finish inside the test's own timeout. For "answers promptly" or "frees the slot" in the MCP server, make the alternative outlast the test's timeout (a worker that sleeps 60 s in a 20 s test) or assert the order events happened in. Check that a new bound bites by reintroducing the bug once. The Playwright timing budgets live in their own non-retried `perf` project.

## Mutation testing

Coverage says a line ran; it does not say a test would notice the line being wrong. [Stryker](https://stryker-mutator.io/) answers that by making small edits to `src/engine/**`, the two utils it runs on (`strftime.ts`, `splunkRegex.ts`), and three pure modules of the MCP server (`requestId.ts`, `messageLimit.ts`, `serialize.ts`), the worker lifecycle (`src/hooks/workerLifecycle.ts`) and the store (`src/store`) — flipping a `<`, emptying a string, deleting a call — and rerunning the tests that reach each one. A mutant no test fails on has *survived*, and marks behaviour nothing asserts.

```bash
npm run test:mutation                  # full run; about 75 minutes on 4 cores
npm run test:mutation -- --mutate src/engine/processors/kvMode.ts   # one file, a few minutes
npm run test:mutation -- --mutate packages/mcp-server/src/requestId.ts
```

Every run includes those modules' tests, which need the MCP server installed and built (`npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server`): one of them talks to the built server. Those three score 90.9% together; the worker lifecycle scores 91% and the store 82% (its setters have their own tests in `useAppStore.actions.test.ts`).

Open `reports/mutation/mutation.html` for the survivors, line by line. The engine scores 79.6%, and `thresholds.break` in [`stryker.config.mjs`](stryker.config.mjs) holds it at 78% — a floor and a ratchet, like coverage. `thresholds.low` (82) is the warning band's edge: a score between the two passes, flagged in the report, so a slide toward the floor is seen before the build goes red.

- **It is not in `ci.yml`.** A full run is too slow for every PR. [`mutation.yml`](.github/workflows/mutation.yml) runs the whole engine weekly and on demand (and, monthly, once with static mutants included, below), and on a PR mutates only the engine source files the PR changes, holding those to the same floor. A PR that touches a weakly tested file adds the tests that bring it up.
- **A formatting-only change is not mutated.** `scripts/drop-format-only.mjs` drops a changed file when Prettier prints its old and new text identically, so a reformat does not re-mutate the whole engine. Any other change to the file, a comment included, keeps it in.
- **Kill a survivor with a test that asserts behaviour**, not one written to move the number. Some survivors are *equivalent* — the mutant cannot change any result (a cache miss that recomputes the same value, a `??` whose left side is never nullish). Leave those.
- **Module-level constants are skipped** (`ignoreStatic`): they cost a full suite each, and there are about 900. Pass `--ignoreStatic false` when you change one. `mutation.yml` also runs them on the first of every month (or on demand with the `static` input): about three hours, and its score is reported rather than gated, because the `break` floor was measured without them. When that run has a baseline, give it a floor of its own.
- **`src/monaco` is not mutated, yet.** Measured once (#508): 1,200 mutants, 18 minutes on 4 cores, and a score of 66.9% (`splunkConfHover.ts` 42%, `splunkConfCompletion.ts` 57%, `timePrefixMatcher.ts` 67%; `splunkConfFolding.ts` and `markdown.ts` are above 90%). Adding it now would fail the 78% floor on every PR that touches a provider, before it made a single one better. The way in: raise the two weakest files with tests that assert the provider's output, then add `src/monaco/*.ts` to `mutate` in `stryker.config.mjs` and `src/monaco/__tests__/*.test.ts` to `include` in `vitest.stryker.config.ts`.
- **`vitest.stryker.config.ts` carries a compatibility shim** for `@stryker-mutator/vitest-runner` 10 on vitest 5, without which every mutant inside a `describe()` is reported as surviving. When you bump either package, check that a run still kills mutants; the comment in that file says what to look for. `npm run test:mutation:canary` does it: it mutates one small, thoroughly tested file (`wildcardMatch.ts`, about 40 seconds) and `scripts/check-mutation-canary.mjs` fails if nearly all its mutants survive, which is what a broken shim looks like. `mutation.yml` runs it before every mutation run.

## Where a change goes

| What | Where |
|---|---|
| Simulation logic | `src/engine/` — pure, no React imports, runs under Node and in a Web Worker |
| Directive metadata (description, default, phase, valid values) | `src/engine/registry/`, assembled by `src/engine/directiveRegistry.ts` |
| Whether the engine actually honours a directive | `src/engine/directiveSupport.ts` |
| Editor behaviour (hover, completion, lint markers) | `src/monaco/` |
| UI | `src/components/` |

`src/engine/**` has one runtime dependency, the PCRE2 WebAssembly module [`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16), and must not gain another — it is consumed directly as a library (see [docs/engine.md](docs/engine.md)), not only by this app. A user-written pattern compiles through `safeRegex` in `src/utils/splunkRegex.ts`, never `new RegExp`: that is what keeps the preview, the editor and the MCP server on Splunk's regex semantics. The engine's own fixed patterns (wildcards, strftime formats) stay JavaScript regexes. Replacement templates (`SEDCMD`, `FORMAT`, eval `replace()`) are expanded by each directive's own code from the match's groups; do not route them through PCRE2's substitution syntax, which Splunk does not use.

### The regex engine's binary

The module lives in its own repository, [`Bimmiest/pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16), and this one depends on it by commit (`package.json`), not by tag: a tag can be moved, a commit hash cannot. That repository commits `pcre2.wasm`, built from a pinned PCRE2 release with clang 18 and `wasm-ld`, and its CI rebuilds it and fails unless the result is byte-identical, so the binary is known to come from the source. To change it — a PCRE2 upgrade, a bridge change — make the change there, tag a release, and move the commit in `package.json` here and in `packages/mcp-server/package.json`, which declares it too (a test in the package fails while the two differ). Both lockfiles record the dependency as `git+ssh://git@github.com/...#<commit>`, with no integrity hash. That is how npm writes every GitHub dependency, and no `package.json` spelling changes it (tried: the `git+https://` form resolves to the same line). It is not what an install does: npm fetches such a dependency over https first (the commit's tarball, then a clone) and tries ssh only after that fails, so CI needs no ssh key; checked by running `npm ci` with ssh unavailable. With no hash in the lockfile, what vouches for the binary is `pcre2.wasm.sha256`, which `scripts/check-wasm-checksum.mjs` verifies in every job that installs it.

### Supply-chain checks

`supply-chain.yml` watches what Dependabot cannot. It runs `npm run check:overrides` (the `overrides` below against what the lockfile resolves) on pull requests that touch `package.json`, the lockfile or `.nvmrc`, and monthly. Monthly it also compares `.nvmrc` with the newest release on its Node line (`scripts/check-node-patch.mjs`) and fails when it is behind; on a pull request that check only annotates. The deploy attests the `dist/` it uploads, in a job with the signing permissions and nothing else, and refuses to upload anything the attestation does not cover; the comments in `azure-static-web-apps.yml` say what that proves and what it does not. To check a deployed bundle later, `gh attestation verify` the `dist.sha256` manifest from that run's `dist-attestation` artifact (kept a day) with `--signer-workflow`.

### The Radix overrides

The exact `@radix-ui/*` pins in `package.json`'s `overrides` dedupe the Radix primitives ([#147](https://github.com/Bimmiest/propslab/issues/147), [#152](https://github.com/Bimmiest/propslab/pull/152)). `cmdk` asks for older ranges of them than `react-dialog`, `react-tooltip` and `react-context-menu` resolve to, and without the overrides npm hoisted cmdk's copies and nested a second copy of each primitive under every current Radix package — both shipped, since they are distinct files (about 12 kB gzip at the time). The pinned versions are the ones `@radix-ui/react-dialog` pins exactly, directly or through its own dependencies. When you bump a Radix package, move the overrides to the versions it pins, and check with `npm ls @radix-ui/react-primitive` that there is still one copy.

One override is not Radix: `typed-rest-client` → `qs`. `@stryker-mutator/core` 10 asks for `typed-rest-client ~2.3.0`, which pins `qs` 6.15.1 exactly, and that version carries denial-of-service advisories (GHSA-q8mj-m7cp-5q26, GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g). The override lifts it to a fixed release; drop it once Stryker depends on a `typed-rest-client` whose own `qs` is fixed.

## Adding or changing a simulated directive

This is the part with rules of its own, because the project's whole claim is that its output matches Splunk.

1. **Implement it in `src/engine/`**, with a unit test that asserts the behaviour.
2. **Classify it in `directiveSupport.ts`** as `simulated`, `documented` or `ignored`. This is not optional — a test fails if a registry key is unclassified, and another fails if a `simulated` key never reaches `runPipeline` in an engine test (measured from the confs the tests pass in, not searched for in their source). Anything `ignored` needs a tracking issue.
3. **Assert against the documentation, and say so.** Several long-standing bugs were reasonable readings of `props.conf.spec` that real Splunk contradicts, so a doc-derived test can encode a wrong answer confidently; keep the assertion narrow. Put the citation in one comment block that says "Doc-derived", names the spec (`props.conf.spec` or `transforms.conf.spec`) and names the directive, in a test file that runs the directive through `runPipeline` (`docDerivedDirectives.test.ts` is the pipeline-level home for these). `directiveEvidence.test.ts` fails on a `simulated` directive with no such citation, and the only alternatives are to reclassify it `documented` or to sit in its `DOC_UNCITED` list, which may not grow.
4. **If real Splunk contradicts a doc-derived test,** open an issue with the input, the stanza and what Splunk produced. That is genuinely useful on its own, and it is how a wrong reading gets corrected without a capture.

## Changing behaviour a test already asserts

If an issue shows Splunk producing something an existing doc-derived test contradicts, change the engine and the test together, and leave a comment saying which issue corrected it and what the old reading was. Several tests carry exactly that note.

## Recipes

### Add a directive
1. Add a `DirectiveInfo` entry to the props or transforms data file under `src/engine/registry/` (the `*SpecDirectives.ts` files hold the spec-completeness sweep; anything new goes in `propsDirectives.ts` or `transformsDirectives.ts`). `directiveRegistry.ts` assembles them, and autocomplete, hover, linting and the dictionary pick it up.
2. If it needs processing logic: create or edit a processor in `src/engine/processors/` and wire it into `src/engine/pipeline.ts` at the correct position, wrapped in `safeProcessor()`. It reads the run's clock, limits and diagnostics from the `RunContext` (`src/engine/runContext.ts`) it is passed, never from defaults of its own; a warning that should appear once per run goes through `ctx.diagnostics.report(key, …)`, not a set local to the call.
3. Follow the classification and citation rules above — the support-table tests enforce them.

### Add an eval function
Add a `case` to the `evalBuiltin` switch in `src/engine/processors/eval/builtins.ts`. A function that must evaluate only some of its arguments (like `if` or `coalesce`) goes in `evalCall` in `eval/evaluator.ts` instead.

### Add a preview sub-tab
1. Create the component in `src/components/preview/tabs/`.
2. Add the ID to `PreviewSubTabId` in `src/engine/types.ts`.
3. Add the entry to `PREVIEW_SUB_TABS` and render it in `PreviewSubTab.tsx`.

### Add or update a CIM model
`CIM_MODELS` in `src/engine/cim/cimModelsData.ts` is generated, not hand-maintained.
To refresh it, download the CIM add-on from
[Splunkbase](https://splunkbase.splunk.com/app/1621), extract it, and run:

```bash
node scripts/generate-cim-models.js /path/to/Splunk_SA_CIM
```

The script reads `default/data/models/*.json` (the model definitions Splunk itself
runs) and takes `CIM_VERSION` from the add-on's `app.conf`. Which datasets are
presented, and their labels, live in the `INCLUDE` table at the top of the script;
everything else — fields, the required/recommended split, constraint tags — is read
out of the add-on, and a dataset that Splunk has renamed or removed fails the run
rather than disappearing quietly. Nothing here runs at build or install time, and
the add-on is not vendored.

CI cannot run the generator: the add-on is behind a Splunkbase login and under
Splunk's licence, so it is not vendored. `src/__tests__/generateCimModels.test.ts`
covers what does not need it: the transformation, on a small synthetic add-on in
`src/__tests__/fixtures/cim` (invented models, no Splunk content), and the output
format, by requiring that `render()` writes the committed `cimModelsData.ts`
byte for byte from its own contents. What still needs a person is checking the
field lists against a newer add-on, by running the script and reading the diff.

To add a dataset by hand instead, read the derivation rules in the generated file's
header first — the fields must come from the model JSON, not from memory or docs prose:

```typescript
{
  name: 'Your_Model',          // or 'Your_Model.Dataset' for a second root dataset
  displayName: 'Your Model',
  description: 'Description',
  requiredFields: ['field1', 'field2'],
  recommendedFields: ['field3'],
  tags: ['your_tag'],          // ALL tags must be present for the dataset to populate
}
```

## Commits and PRs

- Explain **why** in the commit body, not just what.
- Reference issues with a closing keyword **per issue** — `Closes #1, #2` only closes #1.
- Add a `CHANGELOG.md` entry for anything a user would notice. Keep it to one or two sentences stating the user-visible change, with the issue link.
- **Design rationale and history go in [`docs/adr/`](docs/adr/README.md)**, not in code comments or the changelog. A comment describes what the code does now and any non-obvious constraint; when the reason needs history ("we tried X, #123 showed Y"), write or extend an ADR and point to it from the comment (`See docs/adr/NNNN-….md.`).

## Release process

**Versioning** follows [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH). Breaking changes increment MAJOR; new features increment MINOR; bug fixes increment PATCH.

**Gate:** All open fidelity questions (issues labeled `question`) must be resolved or closed before a release. A fidelity question represents an outstanding discrepancy with Splunk that needs investigation or clarification.

**What a release is here.** There is no release workflow. Every commit that lands on `main` with a passing CI run is deployed to production by `azure-static-web-apps.yml` (it runs when CI finishes, builds that commit, then checks the served headers), and nothing is triggered by a tag. A release is therefore a marker: a version number in `package.json` (shown in the status bar), a dated heading in `CHANGELOG.md`, and optionally a tag on the merge commit.

**Release checklist:**

1. Check the fidelity gate above: no open issue labeled `question`.
2. On a branch, rename the `## Unreleased` heading in `CHANGELOG.md` to `## x.y.z — YYYY-MM-DD` (an em dash, as in the existing headings, e.g. `## 1.2.0 — 2026-09-19`) and put a fresh, empty `## Unreleased` above it.
3. Set the version in `package.json` and `package-lock.json` to `x.y.z` (`npm version x.y.z --no-git-tag-version` does both).
4. Open a pull request and merge it once CI is green. Merging is what deploys: watch the "Azure Static Web Apps CI/CD" run on `main` until "Verify the deployed headers" passes.
5. Optionally tag the merge commit, `git tag -s vx.y.z <sha> -m "Release x.y.z"` then `git push origin vx.y.z` (`-s` needs a GPG or SSH signing key; without one use `-a`). The tag is a bookmark for people; no workflow reads it.
6. The `production` environment and `main`'s protection are verified by `environment.yml`, weekly. It has no per-release trigger; if the release touched repository settings, run it from the Actions tab (`workflow_dispatch`) and expect it to pass.

**Note:** `packages/mcp-server` is versioned independently and is not published anywhere (its `package.json` is `private`). Its version, which the server reports in the MCP `initialize` handshake, changes in `packages/mcp-server/package.json` and needs no separate release; if you want a bookmark for it, tag `mcp-server-vx.y.z` the same way.
