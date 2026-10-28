---
type: how-to
---

# Recipes

Where each change goes, the steps for a simulated directive, and the recipes for the common changes. [CONTRIBUTING.md](../CONTRIBUTING.md#where-a-change-goes) has the summary of the rules.

## Where a change goes

| What | Where |
|---|---|
| Simulation logic | `src/engine/` — pure, no React imports, runs under Node and in a Web Worker |
| Directive metadata (description, default, phase, valid values) | `src/engine/registry/`, assembled by `src/engine/directiveRegistry.ts` |
| Whether the engine actually honours a directive | `src/engine/directiveSupport.ts` |
| Editor behaviour (hover, completion, lint markers) | `src/monaco/` |
| UI | `src/components/` |

`src/engine/**` has one runtime dependency, the PCRE2 WebAssembly module [`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16), and must not gain another — it is consumed directly as a library (see [engine.md](engine.md)), not only by this app. A user-written pattern compiles through `safeRegex` in `src/utils/splunkRegex.ts`, never `new RegExp`: that is what keeps the preview, the editor and the MCP server on Splunk's regex semantics. The engine's own fixed patterns (wildcards, strftime formats) stay JavaScript regexes. Replacement templates (`SEDCMD`, `FORMAT`, eval `replace()`) are expanded by each directive's own code from the match's groups; do not route them through PCRE2's substitution syntax, which Splunk does not use.

An export from `src/engine`, `src/monaco` or a vendored file in `src/utils` is public. propslab-sb and propslab-ent vendor these files, and their own code imports from them. Before you remove or rename an export, search those two repositories too. A search of this repository alone found `FALLBACK_TIME_SOURCES` unused, and its removal broke both (#570).

## Adding or changing a simulated directive

This is the part with rules of its own, because the project's whole claim is that its output matches Splunk.

1. **Implement it in `src/engine/`**, with a unit test that asserts the behaviour.
2. **Classify it in `directiveSupport.ts`** as `simulated`, `documented` or `ignored`. This is not optional — a test fails if a registry key is unclassified, and another fails if a `simulated` key never reaches `runPipeline` in an engine test (measured from the confs the tests pass in, not searched for in their source). Anything `ignored` needs a tracking issue.
3. **Assert against the documentation, and say so.** Several long-standing bugs were reasonable readings of `props.conf.spec` that real Splunk contradicts, so a doc-derived test can encode a wrong answer confidently; keep the assertion narrow. Put the citation in one comment block that says "Doc-derived", names the spec (`props.conf.spec` or `transforms.conf.spec`) and names the directive, in a test file that runs the directive through `runPipeline` (`docDerivedDirectives.test.ts` is the pipeline-level home for these). `directiveEvidence.test.ts` fails on a `simulated` directive with no such citation, and the only alternatives are to reclassify it `documented` or to sit in its `DOC_UNCITED` list, which may not grow. The directive must be in a stanza that applies to the run. A props stanza that matches no metadata of the run, or a transforms stanza that no applied props stanza names, does not count. The check runs only in a full run (`npm test`) and on CI. A run of one file, one project or one shard skips it.
4. **If real Splunk contradicts a doc-derived test,** open an issue with the input, the stanza and what Splunk produced. That is genuinely useful on its own, and it is how a wrong reading gets corrected without a capture.

## Changing behaviour a test already asserts

If an issue shows Splunk producing something an existing doc-derived test contradicts, change the engine and the test together, and leave a comment saying which issue corrected it and what the old reading was. Several tests carry exactly that note.

## Add a directive
1. Add a `DirectiveInfo` entry to the props or transforms data file under `src/engine/registry/` (the `*SpecDirectives.ts` files hold the spec-completeness sweep; anything new goes in `propsDirectives.ts` or `transformsDirectives.ts`). `directiveRegistry.ts` assembles them, and autocomplete, hover, linting and the dictionary pick it up.
2. If it needs processing logic: create or edit a processor in `src/engine/processors/` and wire it into `src/engine/pipeline.ts` at the correct position, wrapped in `safeProcessor()`. It reads the run's clock, limits and diagnostics from the `RunContext` (`src/engine/runContext.ts`) it is passed, never from defaults of its own; a warning that should appear once per run goes through `ctx.diagnostics.report(key, …)`, not a set local to the call.
3. Follow the classification and citation rules above — the support-table tests enforce them.

## Add an eval function
Add a `case` to the `evalBuiltin` switch in `src/engine/processors/eval/builtins.ts`. A function that must evaluate only some of its arguments (like `if` or `coalesce`) goes in `evalCall` in `eval/evaluator.ts` instead.

## Add a preview sub-tab
1. Create the component in `src/components/preview/tabs/`.
2. Add the ID to `PreviewSubTabId` in `src/engine/types.ts`.
3. Add the entry to `PREVIEW_SUB_TABS` and render it in `PreviewSubTab.tsx`.

## Add or update a CIM model
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
