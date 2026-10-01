# Propslab

Browser-based simulator for Splunk's `props.conf` and `transforms.conf` processing pipeline. All simulation runs in the browser; no backend, no network calls, no persisted user data.

> **Not a Splunk product.** Propslab is an independent project. It is not
> affiliated with, endorsed by, or sponsored by Splunk Inc. or Cisco Systems,
> Inc. Splunk is a registered trademark of Splunk Inc.; the name is used here
> only to describe what this simulator models. See [NOTICE](NOTICE) for
> attribution of the third-party material this project derives data from.

## Build

**Prerequisites:** Node 24 (see `.nvmrc`; use `nvm use` or `fnm use`), npm, Git.

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

**If setup fails:**

- **Old Node version:** Check `.nvmrc` and use `nvm use` or `fnm use` to switch.
- **Missing Playwright browser:** `npx playwright install chromium` (needed on first e2e run).
- **Stale node_modules:** `rm -rf node_modules && npm install`.
- **Stale dist/ causing E2E failures:** `rm -rf dist/ && E2E_SKIP_BUILD=0 npm run test:e2e`.

## Architecture

Input (raw log + metadata + props.conf + transforms.conf) flows through a single Zustand store. `useProcessingPipeline` debounces changes 300 ms, posts a request to a Web Worker running the full simulation, and writes the result back. A 5 s watchdog kills hung workers and replays the last in-flight request on restart. Each processor is wrapped in `safeProcessor()` — a failure records a diagnostic rather than crashing the pipeline, and only the events it failed on pass through that stage unchanged (stages that read across events, such as line breaking and timestamping, fall back as a whole).

Design decisions and their rationale are recorded in [docs/adr/](docs/adr/README.md). Contributor-facing internals — store layout, Monaco bundling, accessibility patterns — are in [docs/architecture.md](docs/architecture.md).

### Processing order

Runs in Splunk's actual order.

**Processing Pipeline**
1. Line breaking — `LINE_BREAKER`, `SHOULD_LINEMERGE`, `BREAK_ONLY_BEFORE`, `MUST_BREAK_AFTER`, `MAX_EVENTS`
2. Truncation — `TRUNCATE`
3. Timestamp extraction — `TIME_PREFIX`, `TIME_FORMAT`, `MAX_TIMESTAMP_LOOKAHEAD`, `TZ`, `DATETIME_CONFIG`, and the sanity bounds (`MAX_DAYS_AGO`, `MAX_DAYS_HENCE`, `MAX_DIFF_SECS_AGO`, `MAX_DIFF_SECS_HENCE`)
4. Indexed extractions — `INDEXED_EXTRACTIONS` (json, csv, tsv, psv, w3c)
5. Sed commands — `SEDCMD-<class>`
6. Transforms — `TRANSFORMS-<class>` (regex routing and `INGEST_EVAL` interleaved in `TRANSFORMS-<class>` list order; class names applied in ASCII order)
7. Field extraction — `EXTRACT-<class>`
8. Report transforms — `REPORT-<class>`
9. KV mode — `KV_MODE` (auto, auto_escaped, json, xml, multi) — runs *after* `REPORT`, as Splunk documents
10. Field aliases — `FIELDALIAS-<class>`
11. Eval — `EVAL-<class>`

### Stanza precedence

`[source::<pattern>]` > `[host::<pattern>]` > `[<sourcetype>]` > `[default]`. Within a type, `priority` decides, and between stanzas of equal priority the name first in ASCII order wins; a more specific pattern gets no preference ([#443](https://github.com/Bimmiest/propslab/issues/443)). Directives from all matching stanzas merge in precedence order.

A `host::` pattern is a PCRE regular expression, matched case-insensitively against the whole host name unless it contains `(?-i)`. A `source::` pattern is one too, case-sensitive, when it contains `*` or `...`; without either it is compared with the source exactly as written, and matches nothing if it contains `|` ([#442](https://github.com/Bimmiest/propslab/issues/442)). In the regex, `...` matches anything, `*` anything but a path separator, and `.` a period.

The engine also accepts layered conf input (`default/` + `local/`) and returns full override provenance — the two halves of what `btool … --debug` prints. That is engine API only, not reachable from the app's UI; see [docs/engine.md](docs/engine.md).

### Layout

Header, an icon-only activity rail, the active view, and a bottom status bar. The rail switches between two top-level views:

- **Simulator** — two-panel split (inputs left, output right). The left column stacks Raw log → Metadata → props.conf → transforms.conf in a resizable group; editors collapse to fixed-height bars at the bottom so the resize handle reclaims their space.
- **Dictionary** — a browsable reference for every directive and stanza kind (see below).

Both views stay mounted and switch with `hidden` rather than rendering conditionally, so moving to the dictionary and back preserves Monaco's undo history, cursor and folding state along with the output filters. Each major panel is wrapped in an `ErrorBoundary`.

Below 768px the rail is replaced by `MobileShell`'s labelled tab strip — the rail's labels live in hover tooltips, which touch has no way to reach.

**Keyboard:** `Ctrl/Cmd+K` opens the command palette (examples, navigate, look up a directive, actions). The header info button (ⓘ) opens a slide-out reference to the 11 pipeline stages.

**Status bar:** worker status, pipeline timing, event count, distinct-field count, error/warning counts, and a "Per-event pipeline" chip when that setting is on.

## Using the engine directly

`src/engine/**` is pure logic with no React imports, and it runs unchanged in the browser, in a Web Worker, and under Node. Its one runtime dependency is the regex engine: every user pattern runs on PCRE2 compiled to WebAssembly ([`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16)), which is initialised once before the first run. `runPipeline` is the entry point. [docs/engine.md](docs/engine.md) covers the API: `PipelineOptions`, layered conf input with override provenance, the regex engine and its semantics, and the caveats that matter when running user-supplied regexes.

[`packages/mcp-server`](packages/mcp-server) is the Node consumer of that API: an MCP server exposing `simulate`, `validate`, `explain_precedence` and `lookup_directive` tools, so an LLM agent can run a config against real sample data instead of guessing about it. It implements the untrusted-regex discipline engine.md prescribes — every engine run happens in a terminatable worker thread under a wall-clock budget. See its [README](packages/mcp-server/README.md).

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

**Top-level:** Preview, CIM Models, Fields, Pipeline, Effective config, Architecture.

**Preview sub-tabs** (order: Raw → Timestamp → Extractions → Diff → Regex):

| Sub-tab | Shows |
|---|---|
| Raw | Events after line/event breaking, with line numbers and timestamp regions. Truncated events carry a `Truncated` badge, and a `CLONE_SOURCETYPE` copy a `Cloned from <sourcetype>` one; expand/collapse handles long events. |
| Timestamp | Matched prefix, format pattern, and parsed `_time` per event. |
| Extractions | Field extractions inline within `_raw`, classified as auto (KV_MODE / INDEXED_EXTRACTIONS), manual (EXTRACT / REPORT / TRANSFORMS / SEDCMD), or calc (EVAL). Filter pills: `Auto / Manual / Calculated / All`. A collapsible sidebar supports search, hover-focus, and pin-to-filter. |
| Diff | Character-level unified diff between original raw data and processed `_raw`. |
| Regex | Interactive regex tester against event text; shows matches only, with empty-state prompt when no pattern is entered. `Add to props.conf` upserts the built `EXTRACT-` line into the event's sourcetype stanza. When the event has no sourcetype it writes a placeholder stanza *and* points the metadata at it, since a stanza the event cannot match would be scaffolding that does nothing — the panel says so before the click. |

**Field highlighting** prefers authoritative byte offsets recorded at extraction time (for positional EXTRACT captures against `_raw`). It falls back to context-aware matching (`"key":"value"`, `key="value"`, `key: value`, `key=value`) for EVAL-computed, aliased, JSON-flattened, and KV-mode fields. Single-character values only highlight when context-matching succeeds — a bare substring search on `"0"` would light up the whole event.

**Fields tab** lists every extracted field with phase (index-time vs search-time) and the processors that produced it. Filter pill: `All / Index-time / Search-time`.

**TIME_FORMAT preview.** Hovering a `TIME_FORMAT` value renders the current time with that pattern, tries it against the first line of the loaded raw data — honouring `TIME_PREFIX`, and anchoring after it exactly as the engine does — and names any specifier the simulator does not implement. The strftime completions carry the same rendering, so the choice between five opaque token strings is made by looking at what each produces. An unsimulated specifier also gets an informational marker in the editor: the config may be correct for a real indexer, but this preview will not resolve `_time` from it.

**"Did not fire"** appears in the Pipeline and Extractions tabs whenever a directive ran against the loaded events and changed nothing — the failure mode the preview otherwise renders as an ordinary unchanged event. Each row names the directive, how many events it had no effect on, and why: the transforms stanza it references is not defined, its pattern did not compile, its `SOURCE_KEY` was empty, the pattern did not match (with the character where it stopped agreeing), the fields it produces were already set, or an `EVAL` expression evaluated to null. Covers `EXTRACT`, `TRANSFORMS`/`REPORT`, `SEDCMD`, `FIELDALIAS` and `EVAL`. Clicking the line reference jumps the editor to it.

**Effective config tab** is what `splunk btool props list <sourcetype> --debug` prints, resolved for the metadata you configured: every directive that actually applies, the stanza it won from, and — expandable per row — the definitions in lower-precedence stanzas it beat. Clicking a line reference jumps the props.conf editor to it. `Show contested only` narrows to the keys more than one matching stanza defines, which is where precedence surprises live. It resolves configuration rather than output, so it answers before any data has been processed.

**CIM Models tab** validates extracted fields against 27 CIM datasets: Alerts, Authentication, Certificates, Change, Data Access, Databases, DLP, Email, Endpoint (Filesystem, Ports, Processes, Registry, Services), Event Signatures, Interprocess Messaging, Intrusion Detection, Inventory, JVM, Malware, Network Resolution (DNS), Network Sessions, Network Traffic, Performance, Ticket Management, Updates, Vulnerabilities, Web.

The field lists, required/recommended split and constraint tags are all derived from the model JSON that ships in Splunk's own CIM add-on (`Splunk_SA_CIM` **8.5.0**) — see the header of `src/engine/cim/cimModelsData.ts` for the exact derivation rules. Entries are one per CIM *root dataset*, so Endpoint (which has five root datasets and no model-wide `tag=endpoint`) appears five times. Three models — Databases, JVM and Interprocess Messaging — declare no key fields in the CIM, so their required score reads `n/a` rather than a meaningless 100%.

## Monaco editor

Custom `splunk-conf` language:

- Monarch tokenizer; `\` line continuations preserve the parent directive's context (eval, regex, alias values) via dedicated continuation states.
- Autocomplete — directive keys at line start, enum/boolean/strftime values after `=`, stanza types inside `[`.
- Hover tooltips — rich markdown: description, default, example, category, phase, value type, valid values.
- Stanza and consecutive-comment folding.
- Linting via `setModelMarkers` — unknown directives, invalid regex, type mismatches, duplicate stanzas, missing brackets, best-practice warnings.
- Light / dark themes (`splunk-light`, `splunk-dark`) tracking the app's zinc/indigo palette.

`directiveRegistry.ts` drives all three features. Add a `DirectiveInfo` entry and autocomplete, hover, and linting pick it up automatically — as does the dictionary. How Monaco is bundled (the slim `monaco-editor/editor` entry, the hand-picked `features/*/register` contributions, the lazy load and the `codeSplitting` group around it) is covered in [docs/architecture.md](docs/architecture.md).

## Dictionary

A reference view for every `props.conf` and `transforms.conf` setting the simulator knows about, plus the four stanza header kinds. Search by key or description, filter by phase (index-time / search-time) and conf file, hide deprecated keys, and read each entry's description, example, default, valid values and pipeline stage.

Every row in the browse list carries two designations — which conf file it belongs in, and which phase it runs at — so both are answerable without opening the entry. That is also what distinguishes `MATCH_LIMIT` and `DEPTH_LIMIT`, the two keys the registry defines once per conf file with file-specific wording.

There is no prose here that the editor does not also have: entries are built from `directiveRegistry.ts` and `stanzaRegistry.ts`, so the dictionary and the hover tooltips cannot drift apart. The pipeline reference drawer and the dictionary answer different questions — "what runs when" versus "what does this key do" — and cross-link both ways.

Three routes in: the activity rail, `Ctrl/Cmd+K` → "Dictionary: KEY", and the "Open in dictionary" link at the bottom of any directive hover.

## Eval expression engine

Full tokenizer and recursive-descent parser in [`src/engine/processors/eval/`](src/engine/processors/eval/) — `tokenizer.ts`, `parser.ts`, `evaluator.ts`, and the function library in `builtins.ts`.

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

All expressions are evaluated per-event before any are applied, matching Splunk's semantics.

## Tests

Tests live in `src/**/__tests__/` and run under vitest. Engine tests target the highest-risk modules — line breaking, eval, regex transforms, dest-key routing, stanza matching, indexed extractions, and a statelessness regression suite. Component smoke tests cover StatusBar, HighlightedTab, FieldsTab, and RegexTab in jsdom. (`npm test` prints the current total; a number written here has gone stale three times.)

Engine tests default to the `node` environment; component tests opt into jsdom with `// @vitest-environment jsdom` at the top of each file so engine tests don't pay the jsdom cost.

### End-to-end (`npm run test:e2e`)

A small Playwright suite in `e2e/` runs Chromium against a **production build** — `playwright.config.ts` rebuilds before serving, because a stale `dist/` produces confident wrong answers. `npm run test:e2e:ui` opens the interactive runner.

It exists for the things vitest structurally cannot reach, each of which has failed silently here before:

- **The Content-Security-Policy.** It lives in `index.html` as a `<meta>` tag and only means anything in a browser. A `<meta>` policy covers the document alone, so `public/staticwebapp.config.json` also sends it as a response header — the only way it reaches the three workers — along with `frame-ancestors`, `Cross-Origin-Opener-Policy` and a `Permissions-Policy`; a unit test (`src/__tests__/deployHeaders.test.ts`) fails if the header drops any directive the meta tag has. `img-src` was missing for the entire life of the policy, so Chromium refused every one of Monaco's `data:` squiggle SVGs and the lint underlines never drew — visible only as a console error nobody was watching. The suite asserts zero CSP violations and zero console errors on boot. The policy also requires Trusted Types (`require-trusted-types-for 'script'`), allowing only Monaco's named policies and a `default` policy (`src/trustedTypes.ts`) that admits same-origin worker URLs; a smoke test drives the editor, a hover, the palette and the dictionary and fails on any violation.
- **Worker bundling.** The whole simulation runs in a Web Worker created via `new Worker(new URL(…), { type: 'module' })`. Whether Vite emits a loadable chunk for that is a build-time question with a runtime answer.
- **The regex engine.** PCRE2 is a WebAssembly asset the page and each worker load from the one same-origin URL the build fixed. The suite checks that it loads under the CSP (`'wasm-unsafe-eval'`), that every load is of that one asset, that it answers in all three workers, and that fetch, compile and instantiate stay inside a 2 s budget (about 80 ms measured).
- **The Monaco chunk split.** `MonacoEditor.tsx` imports the slim `monaco-editor/editor` entry and `vite.config.ts` hand-rolls a `codeSplitting` group around it. A bad split type-checks, builds, and then fails to mount an editor. Each hand-picked editor contribution (suggest, code actions, folding, find, hover) has a test, since a missing one fails silently too.
- **Accessibility.** `a11y.spec.ts` runs axe-core over every main view — simulator, each output tab, dictionary, command palette, settings, pipeline reference, mobile layout — in both themes, and fails on any WCAG 2.2 AA or best-practice violation. Nothing is excluded, Monaco included: its colours come from our own themes.
- **Performance.** `perf.spec.ts` pastes 20k events into the raw log, runs a regex-heavy config over large events and renders a 3,000-field event, and holds the pipeline and every tab switch to a budget several times what a local run measures. `perf-vitals.spec.ts` loads the production build cold and holds LCP, total blocking time and transferred bytes to budgets set from measurement; per-chunk sizes alone once let the entry preload all of Monaco. These run in the `perf` Playwright project, which has no retries, and write their numbers, with the budget beside each, to the job summary.

One note if you extend it: the app runs the pipeline once on mount with an empty raw log, and `runPipeline` returns a real result for empty input (`eventCount: 0`). So the status bar reads "Worker idle · 0 events" *before* anything is loaded — wait on a non-zero event count, as `loadExample` does, not on the idle state.

`@playwright/test` is pinned to `~1.63.0` to match a specific Chromium revision for local development consistency. Bump it freely — CI installs each version's matching browser, so the pin does not affect CI runs.

`ci.yml` runs on every PR, on pushes to main, weekly, and on demand, as independent jobs: `ci` (lint → build (`tsc -b && vite build`) → per-chunk gzip budgets (`scripts/check-bundle-size.mjs`) → tests with coverage → e2e smoke), `mcp-server` (the MCP server's typecheck, bundle and tests), and `audit` (`npm audit` over both lockfiles — high-severity advisories in production dependencies fail it, dev-only ones are reported), `workflow-lint` (actionlint and zizmor over `.github/`), and, on PRs, `dependency-review`. CodeQL runs through GitHub's default code-scanning setup rather than a workflow file.

The Azure SWA deploy (`azure-static-web-apps.yml`) builds and deploys only; it has no test job of its own because it does not run until CI has passed. It triggers on `workflow_run` when a CI run finishes, and proceeds only if that run succeeded and was for a push to main. It then deploys the **newest commit on main with a green push CI** — not necessarily the commit that triggered it, since CI runs for two quick pushes can finish in either order — building it with the `.nvmrc` Node and `npm ci --ignore-scripts`, and uploading `dist/` with the app build skipped. Build and deploy are separate jobs: `build` resolves and checks the commit, installs and builds it, and uploads `dist/` as an artifact without ever seeing the deployment token; `deploy` runs in the `production` environment, checks nothing out, and only hands that artifact to the Azure action. A manual `workflow_dispatch` on `main` is the redeploy and rollback path, and it is not gated on CI: with the `sha` input empty it redeploys the newest green commit on main, and with `sha` set it deploys that commit — refusing any commit that is not an ancestor of `main`, so only something that was once merged can be put back. Dispatching from any other branch or tag fails. Those checks live in the workflow file, which a dispatch runs from the dispatched ref, so what actually keeps a branch or tag from deploying has to be the `production` environment's settings — and naming the environment does nothing until a repo admin configures it: move `AZURE_STATIC_WEB_APPS_API_TOKEN` from the repository secrets to the environment's secrets (deleting the repository-level copy), and under the environment's deployment branches and tags choose "Selected branches and tags" and allow `main` only, with no tag patterns. The comment above the `deploy` job has the details; until both are done, any workflow on any branch can read the token. The weekly [`environment.yml`](.github/workflows/environment.yml) workflow checks both settings through the API and fails when either is missing; its secret check needs a `SECRETS_READ_TOKEN` repository secret, a fine-grained token for this repository with the Secrets permission set to read-only, which lists secret names and never their values.

A rollback only sticks while the automatic path is paused. Unpaused, the next green push CI on main — or a re-run of the bad commit's CI — redeploys the newest green commit over it, and a dispatch still queued behind a running deploy can be silently cancelled by the next automatic run, because a concurrency group keeps only the newest pending run. The repository variable `DEPLOY_PAUSED` is the switch: while it is `true`, automatic runs neither deploy nor join the deploy queue, and dispatches are unaffected. A dispatch made after setting it is guaranteed not to be cancelled or overwritten by an automatic deploy for as long as it stays set; one made without it gets no such guarantee. To roll back:

1. Under Settings → Secrets and variables → Actions → Variables, set `DEPLOY_PAUSED` to `true`.
2. Dispatch the deploy workflow on `main` with `sha` set to the commit to put back.
3. Once the fix is merged and main's push CI is green, delete `DEPLOY_PAUSED` (or set it to anything but `true`), then dispatch with `sha` empty, or wait for the next push, to resume automatic deploys.

The Azure action is pinned to a commit, but that pins only its wrapper: its Dockerfile builds on `mcr.microsoft.com/appsvc/staticappsclient:stable`, a movable tag, so the client that receives the deployment token is whatever Microsoft currently publishes there. The workflow file explains why that is left as it is.

Node is pinned once, in `.nvmrc`, which both workflows and `package.json`'s `engines` follow. `supply-chain.yml` checks the Radix overrides and, monthly, that `.nvmrc` is the newest patch of its line, and the deploy attests the bundle it uploads and verifies the attestation before handing it to Azure (see CONTRIBUTING.md).

## Simulation fidelity

A simulator's correctness oracle is "matches real Splunk", which is a closed-source, versioned, partly undocumented target — so fidelity can never be *proven* complete. It can be bounded. This section is that boundary in one place: what is simulated, what is deliberately not, and where the simulation knowingly diverges. Verify anything suspicious against a real indexer before relying on the output.

**Not simulated** — the following are deliberately out of scope or stubbed:

- Lookups (`LOOKUP-*` directives and lookup tables)
- Input-layer directives (`EVENT_BREAKER`, `EVENT_BREAKER_ENABLE`, `CHARSET`, `NO_BINARY_CHECK`, `LEARN_SOURCETYPE`)
- Segmentation (`SEGMENTATION` — changes search-time term segmentation, not event output)
- Search-time optimization (`CAN_OPTIMIZE`, `OPTIMIZE_IE_EXTRACT`)
- Line-breaker lookbehind across chunk boundaries (`LINE_BREAKER_LOOKBEHIND`)
- Stub eval functions (`md5()`, `sha1()`, `sha256()`, `sha512()`; `searchmatch()`, `relative_time()`, `strptime()`, `mvfilter()`, `sigfig()`, `exact()` are partial stubs)

Recorded outputs from Splunk Enterprise are not distributed with Propslab and are not part of its source, test suite, build, CI or releases. Engine tests assert against the documentation and say so ([ADR 0016](docs/adr/0016-recorded-splunk-output-is-not-distributed.md)).

Every directive the registry knows about carries one of three support levels, declared in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts):

| Level | Count | Meaning |
|---|---|---|
| **simulated** | 77 | The engine implements it and tests assert the behaviour. |
| **documented** | 72 | Recognised on purpose, outside the simulation for a reason that is not going to change — it belongs to a layer a browser has no access to, or it has no observable effect on output. |
| **ignored** | 0 | Should be simulated, is not yet, and names the issue tracking it. Every one of these is a known wrong answer. |

The counts are asserted by a test against the table itself, so they cannot go stale.

A fourth state sits outside that table, for attributes the registry does not know about at all — valid in Splunk, unknown here, so the preview neither honours them nor says anything. **0** attributes are valid in Splunk 10.4.3 and absent from the registry: [#178](https://github.com/Bimmiest/propslab/issues/178) closed that gap by registering every attribute in `props.conf.spec` and `transforms.conf.spec` for Splunk 10.4.3, so a valid directive is always classified even when it is not simulated. The registry is hand-maintained deliberately rather than generated: conf attributes move rarely between versions, and a generator would need `.spec` files this project has no licensed route to. `UNDOCUMENTED_ATTRIBUTES` in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts) stays as the place the next unknown lands — by name only, because value types and defaults are facts belonging to the spec, and a guessed one would be a confident wrong answer.

Writing a directive that is not `simulated` produces a diagnostic under its editor — a warning for `ignored`, an informational note for `documented`. The dictionary and the editor hover say the same thing on the entry itself. The point is that the tool never silently renders output as though a line you wrote were absent.

One `simulated` entry carries a caveat rather than a clean bill of health: `INDEXED_EXTRACTIONS` simulates csv, tsv, psv, w3c, json and the xml family (`xml`, `xmlkv`, `xmlkv-winevt`) with their supporting attributes, but not `hec`, and the xml modes' field naming is not specified by `props.conf.spec` — it is borrowed from `KV_MODE = xml` and the `xmlkv` search command, and says so on the entry.

### Not simulated yet (`ignored`)

Each of these is a directive the preview accepts and then does not honour — a known wrong answer. The roster lives in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts): every `ignored` entry states what is missing and names its tracking issue, and the same text appears verbatim on the directive's hover, its editor warning, and its dictionary entry. A [scheduled workflow](.github/workflows/roster.yml) checks those issues are still open, because an entry pointing at a closed one is how this roster goes stale.

The roster is empty. The last entries were the index-time surface [#178](https://github.com/Bimmiest/propslab/issues/178) uncovered when it completed the registry against the 10.4.3 spec files — XML indexed extraction ([#271](https://github.com/Bimmiest/propslab/issues/271)), the header-side delimited overrides ([#272](https://github.com/Bimmiest/propslab/issues/272)), the index-time timestamp fields ([#273](https://github.com/Bimmiest/propslab/issues/273)), `KV_TRIM_SPACES` and `JSON_TRIM_BRACES_IN_ARRAY_NAMES` ([#274](https://github.com/Bimmiest/propslab/issues/274)), and rulesets, `STOP_PROCESSING_IF` and age-based routing ([#275](https://github.com/Bimmiest/propslab/issues/275)) — and all are simulated now. `OPTIMIZE_IE_EXTRACT` and `CAN_OPTIMIZE_IE` moved to `documented` instead: they skip work for the fields a particular search asks for, and the preview runs no search. The roster check keeps running, and fails again the day an entry returns.

### Deliberately out of scope (`documented`)

Lookups (`LOOKUP` and every `transforms.conf` lookup attribute) need a lookup table, and a browser tool with no backend has nowhere to get one — `LOOKUP-*` directives are parsed and warn, but fields sourced from lookups will not appear. `EVENT_BREAKER`, `EVENT_BREAKER_ENABLE`, `CHARSET`, `NO_BINARY_CHECK` and `LEARN_SOURCETYPE` belong to the forwarder and input layers, upstream of everything simulated here. `SEGMENTATION` changes how the indexer segments terms for search rather than the event or its fields. `CAN_OPTIMIZE` lets the search optimiser skip a transform, which changes no result. `LINE_BREAKER_LOOKBEHIND` governs how far Splunk looks back across an internal chunk boundary, and the simulator holds the whole input in memory with no chunk boundaries to look across. `CHECK_FOR_HEADER` is deprecated by Splunk in favour of `INDEXED_EXTRACTIONS`, which is simulated.

### Stubbed eval functions

The directive levels above do not cover eval *functions*, which have their own boundary:

- **Crypto functions.** `md5()`, `sha1()`, `sha256()`, `sha512()` return a placeholder string (e.g. `[md5() not simulated]`) and emit a warning.
- **Partial stubs.** `searchmatch()`, `relative_time()`, `strptime()`, `mvfilter()` (returns its input unfiltered), and `sigfig()` / `exact()` (return the value unrounded) have simplified implementations; results may not match Splunk on edge cases. Every one of them emits a warning when evaluated, so a stubbed result is never mistaken for a computed one.

### Simplified

- **`SEDCMD` occurrence flag.** The `s/` substitute and `y/` transliterate forms are both simulated. The numeric occurrence flag (`s/…/…/2`), a value that is not a sed expression at all, a `y///` whose two character sets differ in length, and a pattern that will not compile each emit a warning rather than being dropped in silence.
- **Delimited `INDEXED_EXTRACTIONS` overrides apply to `csv`/`tsv`/`psv` only.** `FIELD_DELIMITER`, `FIELD_QUOTE`, `FIELD_NAMES`, `HEADER_FIELD_LINE_NUMBER`, `PREAMBLE_REGEX`, `FIELD_HEADER_REGEX`, the header-side delimiters (`HEADER_FIELD_DELIMITER`/`HEADER_FIELD_QUOTE`) and `MISSING_VALUE_REGEX` are honoured for the delimited formats; `w3c` keeps its own `#Fields` header mechanism, which they do not override there. `TIMESTAMP_FIELDS` is honoured for `json` and `w3c` as well, and `w3c` without it reads its timestamp from the `date` and `time` columns rather than from anywhere in the row. `KEEP_EMPTY_VALS`/`CLEAN_KEYS` in this context remain unimplemented. transforms.conf's own `CLEAN_KEYS` **is** simulated.
- **`priority` rules are taken from the documentation.** `priority` orders stanzas *within* a kind and cannot reach across kinds: `source` > `host` > `sourcetype` > `default` holds regardless of what any stanza declares, which is what `props.conf.spec` says explicitly. A stanza that declares nothing defaults by how it matches rather than by its kind — 100 when the stanza matches literally (`[my_sourcetype]`, `[source::/var/log/app.log]`), 0 when it matches by pattern (`[source::...app...]`, `[host::web*]`, and a host pattern with any regex syntax other than `.`, such as `[host::web\d+]`) — so a pattern stanza needs `priority` above 100 to beat a literal sibling. The tests assert our reading of the docs, and the docs contradict themselves once on the cross-kind question ([#198](https://github.com/Bimmiest/propslab/issues/198)). `sourcetype` and `rename` are in the same position, though their rules are less ambiguous.
- **`KV_MODE = xml`.** Read by the engine's own XML reader (`src/engine/utils/xmlReader.ts`), not `DOMParser`, which no Web Worker or Node process has. It is as strict as a conforming parser — malformed XML extracts nothing — and does not expand entities declared in a DOCTYPE's internal subset. Element fields are named by their dotted path from the document root, including the root itself (`<event><user>…` gives `event.user`), which the Splunk 10.4.0 capture pins. Attribute naming is *not* pinned by any capture: attributes keep their bare names, except that a `Name` attribute follows the Windows event-log convention and names the field itself.
- **`PAIR_RE` in transform `FORMAT` does not handle escaped quotes in quoted values.** `"([^"]*)"` stops at the first inner `"`, so `field::"say \"hi\""` parses as `field=say \`. Real Splunk behaviour here is under-documented; treat as an edge case.

### Opt-in

- **`DEST_KEY = MetaData:*` re-routing.** By default, writing `MetaData:Sourcetype` updates the event's metadata field but search-time processors still use the original stanza match. Enable **"Re-match stanzas after metadata rewrites"** in Settings (gear icon) to run a fresh `matchStanzas` + `mergeDirectives` pass after index-time transforms, so search-time directives come from the new sourcetype. Batch mode emits a warning when any event had its routing metadata rewritten; per-event mode auto-enables manual-apply to keep the editor responsive.

### Other

- **Regexes run on PCRE2, bounded by its limits and by worker watchdogs.** Every user pattern runs on PCRE2 compiled to WebAssembly, so the preview matches what Splunk's PCRE matches — `$` before a final newline, `.` matching `\r`, possessive quantifiers, recursion, `\K` — instead of a JavaScript translation of it, and no pattern is refused for looking prone to catastrophic backtracking. `MATCH_LIMIT` and `DEPTH_LIMIT` bound each field-extraction match, as in Splunk (see [docs/engine.md](docs/engine.md#the-regex-engine), including where PCRE2 differs from the PCRE1 those limits were named for). The limits bound each match, not a whole run, so no user-supplied regex from a directive is matched on the main thread either: the main processing pipeline (5 s watchdog), the **Regex tab's live tester** and the **Create-EXTRACT dialog's** live capture (both through the same regex-match worker, 2 s watchdog), the **Timestamp tab** (2 s) and the editor's `TIME_FORMAT` hover preview, whose `TIME_PREFIX` match shares the Timestamp tab's worker (1 s of the match itself — a worker still loading the engine is waited for, not blamed; the hover says "preview timed out" when it fires, and has no inline fallback), all run it inside a Web Worker, which is terminated and restarted rather than freezing the UI. The main thread only *compiles* user patterns, to report syntax errors, and compiling cannot backtrack. Stanza patterns are the exception: the Effective config and Timestamp tabs resolve stanzas on the main thread, matching `[source::…]` and `[host::…]` patterns against the one source and host in the metadata panel. Every stanza-pattern match, there and in the pipeline, is held to Splunk's default `MATCH_LIMIT` and `DEPTH_LIMIT`. The one regex the hover still matches on the main thread is the `TIME_FORMAT` side: a pattern the app builds from strptime specifiers, not one the user wrote, run over at most 4 KB of the sample line.
- **Raw data capped at 1 MB.** The cap is applied inside the pipeline, not at the store: a larger input is accepted, stored and sent to the worker in full, then *truncated* for processing — cut back to the last complete line, so the trailing partial event is dropped rather than mis-broken, with a warning saying so. Nothing rejects the input, and the editor still holds all of it. Line breaking likewise stops at 25,000 events (a `LINE_BREAKER` that breaks on every character would otherwise make a million), and warns from which line the input was dropped.
- **Sourcetype stanzas match by strict equality.** This matches real Splunk — sourcetype names are literal, no wildcards — noted here so contributors don't add wildcard support by analogy with `source::` / `host::`.
- **Monaco find-widget tooltip flicker.** Upstream bug in Monaco's hover service ([microsoft/monaco-editor#5208](https://github.com/microsoft/monaco-editor/issues/5208)); no local fix.

See [CHANGELOG.md](CHANGELOG.md) for fix history

## Tech stack

React 19, Vite 8, TypeScript 5.9, Tailwind CSS 4 (CSS-first config), Monaco Editor 0.57 (mounted directly by `MonacoEditor.tsx`), Zustand 5, react-resizable-panels 4.13, `diff` 9, `cmdk` (command palette), Radix UI primitives (`react-tooltip`, `react-dialog`, `react-context-menu`), PCRE2 10.48 compiled to WebAssembly ([`pcre2-wasm-utf16`](https://github.com/Bimmiest/pcre2-wasm-utf16)).

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the CI checks, where a change goes, and the recipes for adding directives, eval functions, CIM models, and preview tabs. Contributor-facing internals are in [docs/architecture.md](docs/architecture.md).
