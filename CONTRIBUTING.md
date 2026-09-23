# Contributing

Thanks for looking at this. Most of what follows is already enforced by CI — it is written down here so you do not have to reverse-engineer it from `.github/workflows/ci.yml`.

## Getting set up

Node is pinned in [`.nvmrc`](.nvmrc), matched by `engines` in `package.json`, and used by CI. Use that version; a different major will produce failures that have nothing to do with your change.

```bash
nvm use            # or: fnm use
npm install
npm run dev        # http://localhost:5173
```

## The four checks

CI runs these in order, and a PR needs all of them:

```bash
npm run lint          # ESLint, including type-aware rules
npm run build         # tsc -b && vite build — this is the type-check
npm run test:coverage # vitest, with the coverage floor enforced
npm run test:e2e      # Playwright, against a production build
```

A few things worth knowing:

- **`npm run build` is the type-check.** There is no separate `tsc --noEmit` step, so a type error surfaces as a build failure.
- **The e2e suite runs against `dist/`, not the dev server.** A change that works under `vite dev` and not in a production build will pass locally and fail in CI. On a clean checkout the first run needs the browser: `npx playwright install chromium`.
- **Coverage is a floor, and a ratchet.** The thresholds live in `vitest.config.ts` so a local run gives the same verdict CI does. The engine is held to a higher bar than the app as a whole, because a simulator whose UI is under-tested is annoying while one whose pipeline is under-tested is wrong. Raise the floor when real work raises coverage; do not lower it to make a branch green.

## Where a change goes

| What | Where |
|---|---|
| Simulation logic | `src/engine/` — pure, no React imports, runs under Node and in a Web Worker |
| Directive metadata (description, default, phase, valid values) | `src/engine/directiveRegistry.ts` |
| Whether the engine actually honours a directive | `src/engine/directiveSupport.ts` |
| Editor behaviour (hover, completion, lint markers) | `src/monaco/` |
| UI | `src/components/` |

`src/engine/**` has no runtime dependencies and must keep it that way — it is consumed directly as a library (see [docs/engine.md](docs/engine.md)), not only by this app.

## Adding or changing a simulated directive

This is the part with rules of its own, because the project's whole claim is that its output matches Splunk.

1. **Implement it in `src/engine/`**, with a unit test that asserts the behaviour.
2. **Classify it in `directiveSupport.ts`** as `simulated`, `documented` or `ignored`. This is not optional — a test fails if a registry key is unclassified, and another fails if a `simulated` key is not mentioned by any test. Anything `ignored` needs a tracking issue.
3. **Assert against the documentation, and say so.** `src/engine/__tests__/fixtures/` holds cases whose ground truth was recorded from a real Splunk instance, and several long-standing bugs were reasonable readings of `props.conf.spec` that real Splunk contradicts — so a doc-derived test can encode a wrong answer confidently. Even so, no new fixtures are being captured: the Splunk General Terms that govern the free edition and the `splunk/splunk` container do not permit it, and [the fixtures README](src/engine/__tests__/fixtures/README.md) names the clauses. Write the unit test from the documentation, note in its comment that it is doc-derived, and keep the assertion narrow.
4. **If real Splunk contradicts a doc-derived test,** open an issue with the input, the stanza and what Splunk produced. That is genuinely useful on its own, and it is how a wrong reading gets corrected without a capture.

The existing fixture corpus is closed to new cases; the README in that directory says why and what would reopen it.

## Changing behaviour a test already asserts

If a captured fixture disagrees with an existing test, the fixture wins. Update the test, and leave a comment saying which capture corrected it and what the old reading was. Several tests carry exactly that note.

## Recipes

### Add a directive
1. Add a `DirectiveInfo` entry to `DIRECTIVES` in `src/engine/directiveRegistry.ts`. Autocomplete, hover, linting and the dictionary pick it up.
2. If it needs processing logic: create or edit a processor in `src/engine/processors/` and wire it into `src/engine/pipeline.ts` at the correct position, wrapped in `safeProcessor()`.
3. Follow the classification and fixture rules above — the support-table tests enforce them.

### Add an eval function
Add a `case` to the `evalBuiltin` switch in `src/engine/processors/eval/builtins.ts`. A function that must evaluate only some of its arguments (like `if` or `coalesce`) goes in `evalCall` in `eval/evaluator.ts` instead.

### Add a preview sub-tab
1. Create the component in `src/components/preview/tabs/`.
2. Add the ID to `PreviewSubTabId` in `src/engine/types.ts`.
3. Add the entry to `PREVIEW_SUB_TABS` and render it in `PreviewPanel.tsx`.

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

- Explain **why** in the commit body, not just what. The `CHANGELOG.md` entries are written the same way and are a fair guide to the house style.
- Reference issues with a closing keyword **per issue** — `Closes #1, #2` only closes #1.
- Add a `CHANGELOG.md` entry for anything a user would notice.
