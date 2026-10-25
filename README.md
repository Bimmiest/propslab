# Propslab

Propslab is a browser-based simulator of the Splunk pipeline that applies `props.conf` and `transforms.conf`. All of the simulation runs in the browser. Propslab has no backend, it makes no network calls, and it does not store user data.

> **Not a Splunk product.** Propslab is an independent project. Splunk Inc. and
> Cisco Systems, Inc. do not endorse or sponsor Propslab, and Propslab has no
> affiliation with them. Splunk is a registered trademark of Splunk Inc. This
> project uses the name only to describe what the simulator models. The
> [NOTICE](NOTICE) file gives the attribution for the third-party material that
> this project derives data from.

## Build

**Prerequisites:**

- Node 24. The file `.nvmrc` gives the exact version. To select that version, run `nvm use` or `fnm use`.
- npm.
- Git.

```bash
npm install
npm ci --prefix packages/mcp-server  # lint is type-aware over the MCP server too
npm run dev          # Dev server on http://localhost:5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # Serve production build
npm run lint         # ESLint
npm run format       # Prettier: rewrite the TypeScript and JavaScript sources
npm run format:check # …or only report what it would change, as CI does
npm test             # vitest (one-shot)
npm run test:coverage # …with the coverage floor enforced, as CI runs it
npm run test:watch   # vitest watch mode
npm run test:e2e     # Playwright smoke tests (builds, then serves dist/)
npm run test:e2e:ui  # …in Playwright's interactive runner
npm run test:mutation # Stryker mutation testing
npm run test:mutation:canary # 40-second check that Stryker still kills mutants (the vitest shim)
npm run check:overrides # Verify the @radix-ui overrides match what the Radix packages pin
```

**If the installation or a test fails:**

- **The Node version is too old:** Read `.nvmrc`. To change to that version, run `nvm use` or `fnm use`.
- **The Playwright browser is not installed:** Run `npx playwright install chromium`. The first e2e run needs it.
- **`node_modules` is not current:** Run `rm -rf node_modules && npm install`.
- **An old `dist/` causes E2E failures:** Run `rm -rf dist/ && E2E_SKIP_BUILD=0 npm run test:e2e`.

## Architecture

The input has four parts: the raw log, the metadata, `props.conf` and `transforms.conf`. All of the input goes through one Zustand store. `useProcessingPipeline` debounces each change for 300 ms. Then it posts a request to a Web Worker, which runs the full simulation, and it writes the result back to the store. A 5 s watchdog stops a worker that hangs. When the worker starts again, the watchdog sends the last request that had no answer.

`safeProcessor()` wraps each processor. If a processor fails, `safeProcessor()` records a diagnostic, and the pipeline does not crash. Only the events that the processor failed on go through that stage without change. Some stages read across events, for example line breaking and timestamp extraction. If one of these stages fails, all of the events go through it without change.

[docs/adr/](docs/adr/README.md) records the design decisions and the reasons for them. [docs/architecture.md](docs/architecture.md) describes these internals for contributors:

- the store layout
- how Monaco is bundled
- the accessibility patterns.

### Order of the stages

The pipeline runs its stages in the order that Splunk uses.

**Pipeline stages**

1. Line breaking: `LINE_BREAKER`, `SHOULD_LINEMERGE`, `BREAK_ONLY_BEFORE`, `MUST_BREAK_AFTER`, `MAX_EVENTS`
2. Truncation: `TRUNCATE`
3. Timestamp extraction: `TIME_PREFIX`, `TIME_FORMAT`, `MAX_TIMESTAMP_LOOKAHEAD`, `TZ`, `DATETIME_CONFIG`, and the sanity bounds (`MAX_DAYS_AGO`, `MAX_DAYS_HENCE`, `MAX_DIFF_SECS_AGO`, `MAX_DIFF_SECS_HENCE`)
4. Indexed extractions: `INDEXED_EXTRACTIONS` (json, csv, tsv, psv, w3c)
5. Sed commands: `SEDCMD-<class>`
6. Transforms: `TRANSFORMS-<class>`. Regex routing and `INGEST_EVAL` run interleaved, in the list order of `TRANSFORMS-<class>`. The class names apply in ASCII order.
7. Field extraction: `EXTRACT-<class>`
8. Report transforms: `REPORT-<class>`
9. KV mode: `KV_MODE` (auto, auto_escaped, json, xml, multi). This stage runs *after* `REPORT`, as Splunk documents.
10. Field aliases: `FIELDALIAS-<class>`
11. Eval: `EVAL-<class>`

### Stanza precedence

The order of precedence is `[source::<pattern>]` > `[host::<pattern>]` > `[<sourcetype>]` > `[default]`. Within one type, `priority` decides. If two stanzas have the same priority, the name that is first in ASCII order wins. A more specific pattern gets no preference ([#443](https://github.com/Bimmiest/propslab/issues/443)). The directives from all of the stanzas that match merge in the order of precedence.

A `host::` pattern is a PCRE regular expression. It matches against the whole host name. The match ignores case, unless the pattern contains `(?-i)`.

A `source::` pattern that contains `*` or `...` is also a regular expression, and case is significant. Propslab compares a `source::` pattern without `*` or `...` with the source exactly as written. Such a pattern matches nothing if it contains `|` ([#442](https://github.com/Bimmiest/propslab/issues/442)). In the regular expression, `...` matches anything, `*` matches anything except a path separator, and `.` matches a period.

The engine also accepts layered conf input (`default/` + `local/`), and it returns the full override provenance. These are the two halves of what `btool … --debug` prints. This is engine API only, and the UI of the app does not give access to it. [docs/engine.md](docs/engine.md) describes it.

### Layout

The layout has four parts:

- a header
- an activity rail that shows only icons
- the active view
- a status bar at the bottom.

The rail selects one of two top-level views:

- **Simulator**: two panels, with the inputs on the left and the output on the right. The left column holds Raw log → Metadata → props.conf → transforms.conf, in a group that you can resize. A collapsed editor becomes a bar of fixed height at the bottom, so that the resize handle can use its space.
- **Dictionary**: a reference that you can browse, for each directive and each stanza kind (see below).

The two views stay mounted. The app shows one of them with `hidden`, and does not render them conditionally. Thus, when you go to the dictionary and back, Monaco keeps its undo history, cursor and folding state. The output filters also stay as they were. An `ErrorBoundary` wraps each major panel.

Below 768px, the labelled tab strip of `MobileShell` replaces the rail. The rail shows its labels only in hover tooltips, and a touch screen cannot open a hover tooltip.

**Keyboard:** `Ctrl/Cmd+K` opens the command palette. The palette has four groups: Examples, Navigate, Look up (for a directive) and Actions. The header info button (ⓘ) opens a slide-out reference to the 11 pipeline stages.

**Status bar:** the status bar shows these items:

- the worker status
- the time that the pipeline took
- the event count
- the count of distinct fields
- the error and warning counts
- a "Per-event pipeline" chip, when that setting is on.

## Use the engine directly

`src/engine/**` is pure logic with no React imports. It runs without change in the browser, in a Web Worker and under Node. Its one runtime dependency is the regex engine. Each user pattern runs on PCRE2 compiled to WebAssembly ([`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16)), which is initialised one time, before the first run. `runPipeline` is the entry point.

[docs/engine.md](docs/engine.md) describes the API:

- `PipelineOptions`
- layered conf input with override provenance
- the regex engine and its semantics
- the caveats that are important when you run regexes that users supply.

[`packages/mcp-server`](packages/mcp-server) is the Node consumer of that API. It is an MCP server with four tools: `simulate`, `validate`, `explain_precedence` and `lookup_directive`. With these tools, an LLM agent can run a config against real sample data, and it does not have to guess. The server obeys the rules for untrusted regexes that engine.md gives. Each engine run occurs in a worker thread that the server can stop, within a wall-clock budget. Its [README](packages/mcp-server/README.md) gives more information.

## Project structure

```
src/
├── engine/                    # Splunk simulation (pure logic, no React)
│   ├── types.ts               # SplunkEvent, ProcessingResult, ConfDirective
│   ├── pipeline.ts            # runPipeline() — sole entry point
│   ├── pipelineWorker.ts      # Web Worker wrapper
│   ├── directiveRegistry.ts   # Directive lookup — drives completion,
│   │                          #   hover, linting AND the dictionary
│   ├── registry/              # The directive entries, props and transforms
│   ├── stanzaRegistry.ts      # The four stanza header kinds + precedence
│   ├── pipelineStages.ts      # The 11 stages, and key → stage lookup
│   ├── parser/
│   │   ├── confParser.ts      # INI parser + default/local layer merge → ParsedConf
│   │   ├── provenance.ts      # Locate a diagnostic at a directive/stanza (+ its layer)
│   │   └── stanzaMatcher.ts   # Precedence-based stanza matching
│   ├── processors/            # One file per processing stage
│   ├── transforms/            # regexTransform, destKeyRouter, ingestEval
│   ├── cim/                   # cimModels.ts + cimModelsData.ts (CIM 8.5.0)
│   ├── scaffold/              # Starter props.conf stanza from sample data
│   └── utils/
│       ├── epochTime.ts       # _time range guard for INGEST_EVAL / DEST_KEY
│       └── flattenJson.ts     # With prototype-pollution guard
│
├── monaco/                    # Monaco language support
│   ├── splunkConfCompletion.ts
│   ├── splunkConfHover.ts
│   ├── splunkConfFolding.ts
│   ├── splunkConfDiagnostics.ts
│   ├── splunkConfCodeActions.ts
│   ├── timeFormatPreview.ts   # TIME_FORMAT hover preview
│   ├── timePrefixMatcher.ts   #   and its off-thread TIME_PREFIX match
│   ├── markdown.ts            # Escape user text in hover Markdown
│   └── dictionaryCommand.ts   # "Open in dictionary" command id + URI
│
├── store/useAppStore.ts       # Zustand store (flat; subscribe per slice)
├── hooks/                     # useProcessingPipeline, useDebounce, useTheme, usePagination
├── utils/                     # splunkRegex (the PCRE2 adapter), regexEngineLoader,
│                              #   strftime, diffEngine, fieldHighlight, countLines
│
└── components/
    ├── layout/                # AppShell, ActivityRail, SimulatorView,
    │                          #   MobileShell, Header, StatusBar, lazyViews,
    │                          #   PipelineController (runs the pipeline in a leaf)
    ├── dictionary/            # DictionaryView + list, detail, badges, entries
    ├── raw/                   # RawPanel (Monaco plaintext)
    ├── metadata/              # MetadataPanel
    ├── editor/                # MonacoEditor, SplunkEditor + props/transforms editors,
    │                          #   EditorValidationList, editorRegistry
    ├── preview/
    │   ├── PreviewPanel.tsx   # Output container
    │   ├── PreviewFilterBar.tsx
    │   └── tabs/              # Raw, Timestamp, Highlighted, Diff, Regex,
    │       └── shared/        #   CimModels, Fields, Transforms, EffectiveConfig
    ├── settings/              # SettingsPanel (gear in header)
    ├── onboarding/            # FirstRunBanner
    ├── help/                  # HelpPanel (pipeline reference slide-out)
    ├── architecture/          # ArchitecturePanel
    ├── scaffold/              # ScaffoldModal
    └── ui/                    # Tabs, Badge, Tooltip, CommandPalette, ErrorBoundary,
                               #   RootErrorBoundary, retryableLazy, etc.

packages/
└── mcp-server/                # MCP server over the engine
    └── src/responseBudget.ts  #   Caps each tool response in bytes on the wire

e2e/                           # Playwright tests (production build, Chromium)
├── fixtures.ts                # Console/CSP error collection + readiness helpers
├── smoke.spec.ts
├── a11y.spec.ts               # axe-core over every main view, both themes
├── perf.spec.ts               # 20k-event, regex-heavy and 3,000-field budgets
├── perf-vitals.spec.ts        # LCP, TBT and transferred bytes on first load
└── perfSummary.ts             # Writes the perf numbers to the job summary
```

## Output tabs

**Top-level tabs:** Preview, CIM Models, Fields, Pipeline, Effective config, Architecture.

**Preview sub-tabs**, in this order: Raw → Timestamp → Extractions → Diff → Regex.

| Sub-tab | Shows |
|---|---|
| Raw | The events after line breaking and event breaking, with line numbers and timestamp regions. A truncated event has a `Truncated` badge. A copy that `CLONE_SOURCETYPE` makes has a `Cloned from <sourcetype>` badge. You can expand and collapse a long event. |
| Timestamp | For each event: the prefix that matched, the format pattern, and the parsed `_time`. |
| Extractions | The field extractions, inline in `_raw`. Each extraction has a class: auto (KV_MODE / INDEXED_EXTRACTIONS), manual (EXTRACT / REPORT / TRANSFORMS / SEDCMD) or calc (EVAL). The filter pills are `Auto / Manual / Calculated / All`. A sidebar that you can collapse has search, hover-focus and pin-to-filter. |
| Diff | A character-level unified diff of the original raw data and the processed `_raw`. |
| Regex | An interactive regex tester for the event text. It shows only the matches. When you enter no pattern, it shows an empty-state prompt. `Add to props.conf` upserts the `EXTRACT-` line that you built into the sourcetype stanza of the event. If the event has no sourcetype, the button writes a placeholder stanza *and* points the metadata to it. The event cannot match a stanza without this change, and such a stanza is a scaffold that does nothing. The panel says this before you click. |

**Field highlights.** A highlight uses the authoritative byte offsets that the extraction recorded, when they exist. These offsets exist for positional EXTRACT captures against `_raw`. For EVAL-computed, aliased, JSON-flattened and KV-mode fields, the highlight uses a context-aware match instead: `"key":"value"`, `key="value"`, `key: value` or `key=value`. A value of one character gets a highlight only when the context-aware match succeeds. Without this rule, a plain substring search for `"0"` highlights the whole event.

**Fields tab.** This tab lists each extracted field, with its phase (index-time or search-time) and the processors that made it. The filter pill is `All / Index-time / Search-time`.

**TIME_FORMAT preview.** When you hover over a `TIME_FORMAT` value, the editor does three things:

- It renders the current time with that pattern.
- It tries the pattern against the first line of the loaded raw data. It obeys `TIME_PREFIX`, and it anchors after it exactly as the engine does.
- It names each specifier that the simulator does not implement.

The strftime completions show the same rendered time. Thus you can choose between five opaque token strings when you see what each one makes. An unsimulated specifier also gets an informational marker in the editor. The config can be correct for a real indexer, but this preview does not resolve `_time` from it.

**"Did not fire".** This list appears in the Pipeline and Extractions tabs when a directive ran against the loaded events and changed nothing. Without the list, the preview shows this failure as a usual event that did not change. Each row gives the directive, the number of events that it had no effect on, and the reason. The reason is one of these:

- The transforms stanza that it references is not defined.
- Its pattern did not compile.
- Its `SOURCE_KEY` was empty.
- The pattern did not match. The row gives the character where the match stopped.
- The fields that it makes were already set.
- The pattern matched, but it has no named capture group, or none of its named groups took part in the match.
- An `EVAL` expression evaluated to null.

The list covers `EXTRACT`, `TRANSFORMS`/`REPORT`, `SEDCMD`, `FIELDALIAS` and `EVAL`. When you click the line reference, the editor moves to that line.

**Effective config tab.** This tab shows what `splunk btool props list <sourcetype> --debug` prints, resolved for the metadata that you configured. It shows these items:

- each directive that applies
- the stanza that the directive won from
- the definitions that the directive beat, in stanzas of lower precedence. You can expand each row to see them.

When you click a line reference, the props.conf editor moves to that line. `Show contested only` shows only the keys that two or more matched stanzas define. Precedence surprises occur in these keys. The tab resolves the configuration, not the output. Thus it gives an answer before Propslab processes any data.

**CIM Models tab.** This tab validates the extracted fields against 27 CIM datasets:

- Alerts
- Authentication
- Certificates
- Change
- Data Access
- Databases
- DLP
- Email
- Endpoint (Filesystem, Ports, Processes, Registry, Services)
- Event Signatures
- Interprocess Messaging
- Intrusion Detection
- Inventory
- JVM
- Malware
- Network Resolution (DNS)
- Network Sessions
- Network Traffic
- Performance
- Ticket Management
- Updates
- Vulnerabilities
- Web

These items all come from the model JSON in the CIM add-on of Splunk (`Splunk_SA_CIM` **8.5.0**):

- the field lists
- the split into required and recommended fields
- the constraint tags.

The header of `src/engine/cim/cimModelsData.ts` gives the exact rules for this derivation. There is one entry for each CIM *root dataset*. Endpoint has five root datasets and no model-wide `tag=endpoint`, so it appears five times. Three models declare no key fields in the CIM: Databases, JVM and Interprocess Messaging. Their required score shows `n/a`, not a 100% that means nothing.

## Monaco editor

The editor has a custom language, `splunk-conf`:

- A Monarch tokenizer. A `\` line continuation keeps the context of the parent directive (eval, regex, alias values), with dedicated continuation states.
- Autocomplete: directive keys at the start of a line, enum/boolean/strftime values after `=`, and stanza types inside `[`.
- Hover tooltips in rich Markdown: description, default, example, category, phase, value type and valid values.
- Folding for stanzas and for consecutive comments.
- Lint markers through `setModelMarkers`: unknown directives, invalid regex, type mismatches, duplicate stanzas, a stanza header without its `]`, and best-practice warnings.
- Light and dark themes (`splunk-light`, `splunk-dark`) that follow the zinc and indigo palette of the app.

`directiveRegistry.ts` drives all three features. When you add a `DirectiveInfo` entry, autocomplete, hover and lint use it automatically, and so does the dictionary. [docs/architecture.md](docs/architecture.md) describes how Monaco is bundled:

- the slim `monaco-editor/editor` entry
- the hand-picked `features/*/register` contributions
- the lazy load and the `codeSplitting` group around it.

## Dictionary

The dictionary is a reference view. It has each `props.conf` and `transforms.conf` setting that the simulator knows, and the four kinds of stanza header. In the dictionary, you can do these things:

- Search by key or by description.
- Filter by phase (index-time / search-time) and by conf file.
- Hide deprecated keys.
- Read the description, example, default, valid values and pipeline stage of each entry.

Each row in the browse list shows two designations: the conf file that it belongs in, and the phase that it runs at. Thus you know both before you open the entry. The designations also show the difference between the two entries of `MATCH_LIMIT`, and between the two entries of `DEPTH_LIMIT`. The registry defines each of these two keys one time for each conf file, with text for that file.

The dictionary has no text that the editor does not also have. Its entries come from `directiveRegistry.ts` and `stanzaRegistry.ts`, so the dictionary and the hover tooltips cannot become different. The pipeline reference drawer and the dictionary answer different questions. The drawer answers "what runs when", and the dictionary answers "what does this key do". Each one links to the other.

You can open the dictionary in three ways:

- from the activity rail
- with `Ctrl/Cmd+K` → "Dictionary: KEY"
- with the "Open in dictionary" link at the bottom of a directive hover.

## Eval expression engine

[`src/engine/processors/eval/`](src/engine/processors/eval/) has a full tokenizer and a recursive-descent parser. The files are `tokenizer.ts`, `parser.ts` and `evaluator.ts`, and `builtins.ts` holds the function library.

**Operators:** `+`, `-`, `*`, `/`, `%`, `.` (concat), `==`, `=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `NOT IN`.

**50+ functions:**

| Category | Functions |
|---|---|
| Conditional | `if`, `case`, `coalesce`, `nullif`, `validate` |
| String | `lower`, `upper`, `len`, `substr`, `replace`, `trim`, `ltrim`, `rtrim`, `urldecode`, `split` |
| Type | `tonumber`, `tostring`, `typeof`, `isnull`, `isnotnull`, `isint`, `isnum` |
| Math | `abs`, `ceiling`/`ceil`, `floor`, `round`, `sqrt`, `pow`, `log`, `ln`, `exp`, `pi`, `min`, `max`, `random`, `sigfig`, `exact` |
| Multivalue | `mvcount`, `mvindex`, `mvfilter`, `mvappend`, `mvdedup`, `mvsort`, `mvzip`, `mvfind`, `mvjoin` |
| Crypto | `md5`, `sha1`, `sha256`, `sha512` (stub placeholders) |
| Time | `now`, `time`, `strftime`, `strptime`, `relative_time` |
| Comparison | `like`, `match`, `cidrmatch`, `searchmatch` |

For each event, the engine evaluates all of the expressions before it applies any of them. This agrees with the semantics of Splunk.

## Tests

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

### End-to-end (`npm run test:e2e`)

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

`ci.yml` runs on each PR, on each push to main, weekly and on demand. It has these independent jobs:

- `ci`: lint → build (`tsc -b && vite build`) → per-chunk gzip budgets (`scripts/check-bundle-size.mjs`) → tests with coverage → e2e smoke.
- `mcp-server`: the typecheck, the bundle and the tests of the MCP server.
- `audit`: `npm audit` over both lockfiles. A high-severity advisory in a production dependency makes it fail. An advisory in a dev-only dependency does not make it fail, and the job only reports it.
- `workflow-lint`: actionlint and zizmor over `.github/`.
- `dependency-review`, on PRs only.

CodeQL uses the default code-scanning setup of GitHub, not a workflow file. [`security.yml`](.github/workflows/security.yml) is a separate workflow, and it calls the reusable workflow in [`Bimmiest/shared-workflows`](https://github.com/Bimmiest/shared-workflows). It runs gitleaks over the whole history, and Trivy over the tree and both lockfiles. It runs on each PR, on each push to main and weekly.

The Azure SWA deploy (`azure-static-web-apps.yml`) only builds and deploys. It has no test job of its own, because it does not run until CI has passed. A `workflow_run` event starts it when a CI run is complete. The workflow continues only if that run passed and was for a push to main.

The workflow then deploys the **newest commit on main with a green push CI**. This is not always the commit that started it, because the CI runs for two quick pushes can complete in either order. The workflow builds that commit with the `.nvmrc` Node and `npm ci --ignore-scripts`. Then it uploads `dist/`, and skips the app build.

Build and deploy are separate jobs:

- `build` resolves and checks the commit, installs and builds it, and uploads `dist/` as an artifact. This job never sees the deployment token.
- `deploy` runs in the `production` environment. It does not do a checkout, and it only gives that artifact to the Azure action.

A manual `workflow_dispatch` on `main` is the path for a redeploy and for a rollback. CI does not gate it.

- If the `sha` input is empty, the dispatch redeploys the newest green commit on main.
- If `sha` has a value, the dispatch deploys that commit. It refuses a commit that is not an ancestor of `main`. Thus it can restore only a commit that was merged before.

A dispatch from any other branch or tag fails. These checks are in the workflow file, and a dispatch runs the workflow file from the ref that it dispatches. Thus only the settings of the `production` environment can stop a deploy from a branch or a tag. The name of the environment in the workflow has no effect until a repository admin configures the environment. The comment above the `deploy` job has the details. To configure the environment, a repository admin must do these steps:

1. Move `AZURE_STATIC_WEB_APPS_API_TOKEN` from the repository secrets to the secrets of the environment.
2. Delete the copy of the token at the repository level.
3. Under the deployment branches and tags of the environment, choose "Selected branches and tags".
4. Allow `main` only, and add no tag patterns.

Until the admin completes these steps, any workflow on any branch can read the token. The weekly [`environment.yml`](.github/workflows/environment.yml) workflow checks both settings through the API. It fails when one of them is not in place. Its secret check needs a `SECRETS_READ_TOKEN` repository secret. This is a fine-grained token for this repository, with the Environments and Secrets permissions both set to read-only. The token lists the names of the secrets, and never their values.

A rollback stays in place only while the automatic path is paused. If the automatic path is not paused, two things can occur:

- The next green push CI on main redeploys the newest green commit over the rollback. A new run of the CI of the bad commit does the same.
- The next automatic run can silently cancel a dispatch that waits in the queue behind a deploy in progress. A concurrency group keeps only the newest run that waits.

The repository variable `DEPLOY_PAUSED` is the switch. While it is `true`, automatic runs do not deploy and do not join the deploy queue. The variable has no effect on dispatches. If you dispatch after you set the variable, no automatic deploy can cancel or overwrite that dispatch while the variable stays set. A dispatch without the variable has no such guarantee.

To do a rollback:

1. Under Settings → Secrets and variables → Actions → Variables, set `DEPLOY_PAUSED` to `true`.
2. Dispatch the deploy workflow on `main`, with `sha` set to the commit that you want to restore.
3. Wait until the fix is merged and the push CI on main is green.
4. Delete `DEPLOY_PAUSED`, or set it to a value other than `true`.
5. To start automatic deploys again, dispatch with `sha` empty, or wait for the next push.

The Azure action is pinned to a commit, but that pin applies only to its wrapper. Its Dockerfile uses `mcr.microsoft.com/appsvc/staticappsclient:stable` as its base, and that is a movable tag. Thus the client that receives the deployment token is the client that Microsoft publishes there at that time. The workflow file explains why this stays as it is.

Node is pinned one time, in `.nvmrc`. Both workflows and the `engines` field of `package.json` follow it. `supply-chain.yml` checks the Radix overrides. Monthly, it also checks that `.nvmrc` is the newest patch of its line. The deploy attests the bundle that it uploads, and it verifies the attestation before it gives the bundle to Azure. CONTRIBUTING.md has more information about this.

## Simulation fidelity

The correctness oracle of a simulator is "matches real Splunk". That target is closed-source, versioned and partly undocumented. Thus it is not possible to *prove* that the fidelity is complete, but it is possible to give it a boundary. This section gives that boundary in one place:

- what Propslab simulates
- what it does not simulate, on purpose
- where the simulation knowingly diverges from Splunk.

If an output looks suspicious, verify it against a real indexer before you rely on it.

**Not simulated.** These items are out of scope on purpose, or are stubs:

- Lookups (`LOOKUP-*` directives and lookup tables)
- Input-layer directives (`EVENT_BREAKER`, `EVENT_BREAKER_ENABLE`, `CHARSET`, `NO_BINARY_CHECK`, `LEARN_SOURCETYPE`)
- Segmentation (`SEGMENTATION`, which changes search-time term segmentation, not the event output)
- Search-time optimization (`CAN_OPTIMIZE`, `OPTIMIZE_IE_EXTRACT`)
- Line-breaker lookbehind across chunk boundaries (`LINE_BREAKER_LOOKBEHIND`)
- Stub eval functions (`md5()`, `sha1()`, `sha256()`, `sha512()`). These are partial stubs: `searchmatch()`, `relative_time()`, `strptime()`, `mvfilter()`, `sigfig()` and `exact()`.

Propslab does not distribute recorded outputs from Splunk Enterprise. These outputs are not part of its source, test suite, build, CI or releases. The engine tests assert against the documentation, and they say so ([ADR 0016](docs/adr/0016-recorded-splunk-output-is-not-distributed.md)).

Each directive that the registry knows has one of three support levels. [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts) declares them:

| Level | Count | What it means |
|---|---|---|
| **simulated** | 77 | The engine implements it, and tests assert the behaviour. |
| **documented** | 72 | Recognised on purpose, and outside the simulation for a reason that does not change. It belongs to a layer that a browser cannot access, or it has no observable effect on the output. |
| **ignored** | 0 | Must be simulated, but is not yet. Its entry names the issue that tracks it. Each one of these is a known wrong answer. |

A test asserts the counts against the table itself, so they cannot become incorrect.

A fourth state is outside that table. It is for attributes that the registry does not know at all. Such an attribute is valid in Splunk but unknown here, so the preview does not honour it and says nothing about it. **0** attributes are valid in Splunk 10.4.3 and absent from the registry. [#178](https://github.com/Bimmiest/propslab/issues/178) closed that gap, because it registered each attribute in `props.conf.spec` and `transforms.conf.spec` for Splunk 10.4.3. Thus a valid directive always has a classification, also when it is not simulated.

The project maintains the registry by hand on purpose, and does not generate it. Conf attributes change rarely between versions. A generator needs `.spec` files, and this project has no licensed route to them. `UNDOCUMENTED_ATTRIBUTES` in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts) stays as the place for the next unknown attribute. It holds only the name, because value types and defaults are facts that belong to the spec. A value type or a default that is a guess is a confident wrong answer.

If you write a directive that is not `simulated`, a diagnostic shows under its editor. The diagnostic is a warning for `ignored`, and an informational note for `documented`. The dictionary and the editor hover say the same thing on the entry itself. Thus the tool never silently renders output as if a line that you wrote does not exist.

One `simulated` entry has a caveat. `INDEXED_EXTRACTIONS` simulates csv, tsv, psv, w3c, json and the xml family (`xml`, `xmlkv`, `xmlkv-winevt`), with the attributes that support them. It does not simulate `hec`. `props.conf.spec` does not specify how the xml modes name their fields. The names come from `KV_MODE = xml` and the `xmlkv` search command, and the entry says so.

### Not simulated yet (`ignored`)

Each of these is a directive that the preview accepts and then does not honour. Each one is a known wrong answer. The roster is in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts). Each `ignored` entry states what the simulation does not do, and names the issue that tracks it. The same text appears verbatim in three places: the hover of the directive, its editor warning and its dictionary entry.

A [scheduled workflow](.github/workflows/roster.yml) checks that those issues are still open. An entry that points to a closed issue is how this roster becomes incorrect.

The roster is empty. The last entries were the index-time surface that [#178](https://github.com/Bimmiest/propslab/issues/178) found when it completed the registry against the 10.4.3 spec files:

- XML indexed extraction ([#271](https://github.com/Bimmiest/propslab/issues/271))
- the header-side delimited overrides ([#272](https://github.com/Bimmiest/propslab/issues/272))
- the index-time timestamp fields ([#273](https://github.com/Bimmiest/propslab/issues/273))
- `KV_TRIM_SPACES` and `JSON_TRIM_BRACES_IN_ARRAY_NAMES` ([#274](https://github.com/Bimmiest/propslab/issues/274))
- rulesets, `STOP_PROCESSING_IF` and age-based routing ([#275](https://github.com/Bimmiest/propslab/issues/275)).

All of them are simulated now. `OPTIMIZE_IE_EXTRACT` and `CAN_OPTIMIZE_IE` moved to `documented` instead. They skip work for the fields that a specific search asks for, and the preview runs no search. The roster check continues to run, and it fails again on the day that an entry returns.

### Deliberately out of scope (`documented`)

- **Lookups.** `LOOKUP` and each `transforms.conf` lookup attribute need a lookup table. A browser tool with no backend cannot get a lookup table. Propslab parses `LOOKUP-*` directives and shows a warning, but fields from lookups do not appear.
- **The forwarder and input layers.** `EVENT_BREAKER`, `EVENT_BREAKER_ENABLE`, `CHARSET`, `NO_BINARY_CHECK` and `LEARN_SOURCETYPE` belong to these layers. The layers are upstream of all that Propslab simulates.
- **`SEGMENTATION`** changes how the indexer segments terms for search. It does not change the event or its fields.
- **`CAN_OPTIMIZE`** lets the search optimiser skip a transform, which changes no result.
- **`LINE_BREAKER_LOOKBEHIND`** sets the distance of the Splunk lookbehind across an internal chunk boundary. The simulator holds the whole input in memory, and it has no chunk boundaries to look across.
- **`CHECK_FOR_HEADER`** has a replacement: Splunk deprecated it in favour of `INDEXED_EXTRACTIONS`, which is simulated.

### Stubbed eval functions

The directive levels above do not apply to eval *functions*. The functions have their own boundary:

- **Crypto functions.** `md5()`, `sha1()`, `sha256()` and `sha512()` return a placeholder string (for example, `[md5() not simulated]`), and they emit a warning.
- **Partial stubs.** `searchmatch()`, `relative_time()`, `strptime()`, `mvfilter()` and `sigfig()` / `exact()` have simplified implementations. `mvfilter()` returns its input without a filter. `sigfig()` and `exact()` return the value, and they do not round it.

  In edge cases, the results can be different from Splunk. Each of these functions emits a warning when it is evaluated. Thus a stub result is never mistaken for a computed result.

### Simplified

- **`SEDCMD` occurrence flag.** The `s/` substitute form and the `y/` transliterate form are both simulated. Each of these emits a warning, and Propslab does not drop it silently:
  - the numeric occurrence flag (`s/…/…/2`)
  - a value that is not a sed expression
  - a `y///` with two character sets of different lengths
  - a pattern that does not compile.
- **Delimited `INDEXED_EXTRACTIONS` overrides apply to `csv`/`tsv`/`psv` only.** Propslab honours these overrides for the delimited formats: `FIELD_DELIMITER`, `FIELD_QUOTE`, `FIELD_NAMES`, `HEADER_FIELD_LINE_NUMBER`, `PREAMBLE_REGEX`, `FIELD_HEADER_REGEX`, the header-side delimiters (`HEADER_FIELD_DELIMITER`/`HEADER_FIELD_QUOTE`) and `MISSING_VALUE_REGEX`. `w3c` keeps its own `#Fields` header mechanism, and the overrides do not change it there.

  Propslab also honours `TIMESTAMP_FIELDS` for `json` and `w3c`. Without it, `w3c` reads its timestamp from the `date` and `time` columns, not from any other part of the row. In this context, `KEEP_EMPTY_VALS`/`CLEAN_KEYS` are not implemented. The `CLEAN_KEYS` of transforms.conf itself **is** simulated.
- **`priority` rules come from the documentation.** `priority` orders stanzas *within* a kind, and it cannot reach across kinds. `source` > `host` > `sourcetype` > `default` is always true, whatever a stanza declares, and `props.conf.spec` says this explicitly. If a stanza declares no `priority`, its default depends on how it matches, not on its kind:
  - 100 when the stanza matches literally (`[my_sourcetype]`, `[source::/var/log/app.log]`)
  - 0 when it matches by pattern (`[source::...app...]`, `[host::web*]`, and a host pattern with any regex syntax other than `.`, such as `[host::web\d+]`).

  Thus a pattern stanza needs a `priority` above 100 to beat a literal stanza of the same kind. The tests assert our interpretation of the documentation. On the question across kinds, the documentation contradicts itself one time ([#198](https://github.com/Bimmiest/propslab/issues/198)). `sourcetype` and `rename` are in the same position, but their rules are less ambiguous.
- **`KV_MODE = xml`.** The engine's own XML reader (`src/engine/utils/xmlReader.ts`) reads it, not `DOMParser`, because no Web Worker or Node process has `DOMParser`. The reader is as strict as a parser that conforms to the XML standard, so malformed XML extracts nothing. It does not expand entities that the internal subset of a DOCTYPE declares. The name of an element field is its dotted path from the document root, and this path includes the root (`<event><user>…` gives `event.user`). The Splunk 10.4.0 capture pins this.

  No capture pins the names of attributes. An attribute keeps its bare name. The exception is a `Name` attribute: it follows the Windows event-log convention, and it names the field itself.
- **`PAIR_RE` in transform `FORMAT` does not handle escaped quotes in quoted values.** `"([^"]*)"` stops at the first inner `"`, so `field::"say \"hi\""` parses as `field=say \`. The behaviour of real Splunk here is under-documented. Treat it as an edge case.

### Opt-in

- **Metadata rewrites with `DEST_KEY = MetaData:*`.** By default, a write to `MetaData:Sourcetype` updates the metadata field of the event. But the search-time processors still use the original stanza match. To change this, enable **"Re-match stanzas after metadata rewrites"** in Settings (gear icon). Then a new `matchStanzas` + `mergeDirectives` pass runs after the index-time transforms, so the search-time directives come from the new sourcetype.

  Batch mode emits a warning when the routing metadata of an event was rewritten. Per-event mode enables manual-apply automatically, to keep the editor responsive.

### Other

- **Regexes run on PCRE2, bounded by its limits and by worker watchdogs.** Each user pattern runs on PCRE2 compiled to WebAssembly. Thus the preview matches what the PCRE of Splunk matches, not a JavaScript translation of it. Examples are `$` before a final newline, `.` that matches `\r`, possessive quantifiers, recursion and `\K`. Propslab refuses no pattern because it looks prone to catastrophic backtracking.

  `MATCH_LIMIT` and `DEPTH_LIMIT` bound each field-extraction match, as in Splunk. [docs/engine.md](docs/engine.md#the-regex-engine) gives more information. It also tells where PCRE2 differs from PCRE1, the version that gave these limits their names.

  The limits bound each match, not a whole run. Thus the main thread also does not match a user-supplied regex from a directive. These parts run it inside a Web Worker:
  - the main pipeline (5 s watchdog)
  - the **Regex tab's live tester** and the **Create-EXTRACT dialog's** live capture, which both use the same regex-match worker (2 s watchdog)
  - the **Timestamp tab** (2 s)
  - the `TIME_FORMAT` hover preview of the editor. Its `TIME_PREFIX` match uses the worker of the Timestamp tab, with 1 s for the match itself. If that worker has not loaded the engine yet, the hover waits for it, and does not blame it. When the limit fires, the hover says "preview timed out". The hover has no inline fallback.

  If a regex runs too long, the app stops the Web Worker and starts it again, and the UI does not freeze. The main thread only *compiles* user patterns, to report syntax errors, and a compile cannot backtrack.

  Stanza patterns are the exception. The Effective config and Timestamp tabs resolve stanzas on the main thread. They match the `[source::…]` and `[host::…]` patterns against the one source and the one host in the metadata panel. Each stanza-pattern match, there and in the pipeline, is held to the default `MATCH_LIMIT` and `DEPTH_LIMIT` of Splunk.

  The hover still matches one regex on the main thread: the `TIME_FORMAT` side. The app builds this pattern from strptime specifiers, and the user did not write it. It runs against a maximum of 4 KB of the sample line.
- **Raw data capped at 1 MB.** The pipeline applies the cap, not the store. The store accepts a larger input in full, and the app sends all of it to the worker. Then the pipeline *truncates* the input at the last complete line. Thus the pipeline drops the partial event at the end, and does not break it incorrectly. A warning says so.

  Nothing rejects the input, and the editor still holds all of it. Line breaking also stops at 25,000 events. Without this limit, a `LINE_BREAKER` that breaks on each character makes a million events. A warning gives the line from which the input was dropped.
- **Sourcetype stanzas match by strict equality.** Real Splunk does the same, because sourcetype names are literal, with no wildcards. This note is here so that contributors do not add wildcard support by analogy with `source::` / `host::`.
- **Monaco find-widget tooltip flicker.** This is an upstream bug in the hover service of Monaco ([microsoft/monaco-editor#5208](https://github.com/microsoft/monaco-editor/issues/5208)). There is no local fix.

[CHANGELOG.md](CHANGELOG.md) gives the history of the fixes.

## Tech stack

- React 19
- Vite 8
- TypeScript 5.9
- Tailwind CSS 4 (CSS-first config)
- Monaco Editor 0.57 (mounted directly by `MonacoEditor.tsx`)
- Zustand 5
- react-resizable-panels 4.14
- `diff` 9
- `cmdk` (command palette)
- Radix UI primitives (`react-tooltip`, `react-dialog`, `react-context-menu`)
- PCRE2 10.48 compiled to WebAssembly ([`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16))

## Contributions

[CONTRIBUTING.md](CONTRIBUTING.md) describes these topics:

- the development environment
- the CI checks
- where a change goes
- the recipes to add directives, eval functions, CIM models and preview tabs.

[docs/architecture.md](docs/architecture.md) describes the internals for contributors.
