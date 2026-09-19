# Propslab

Browser-based simulator for Splunk's `props.conf` and `transforms.conf` processing pipeline. All simulation runs in the browser; no backend, no network calls, no persisted user data.

> **Not a Splunk product.** Propslab is an independent project. It is not
> affiliated with, endorsed by, or sponsored by Splunk Inc. or Cisco Systems,
> Inc. Splunk is a registered trademark of Splunk Inc.; the name is used here
> only to describe what this simulator models. See [NOTICE](NOTICE) for
> attribution of the third-party material this project derives data from.

## Build

```bash
npm install
npm run dev          # Dev server on http://localhost:5173
npm run build        # tsc -b && vite build → dist/
npm run preview      # Serve production build
npm run lint         # ESLint
npm test             # vitest (one-shot)
npm run test:coverage # …with the coverage floor enforced, as CI runs it
npm run test:watch   # vitest watch mode
npm run test:e2e     # Playwright smoke tests (builds, then serves dist/)
npm run test:e2e:ui  # …in Playwright's interactive runner
```

First e2e run on a clean checkout needs the browser: `npx playwright install chromium`.

## Architecture

Input (raw log + metadata + props.conf + transforms.conf) flows through a single Zustand store. `useProcessingPipeline` debounces changes 300 ms, posts a request to a Web Worker running the full simulation, and writes the result back. A 5 s watchdog kills hung workers and replays the last in-flight request on restart. Each processor is wrapped in `safeProcessor()` — failures record a diagnostic and return the events unchanged rather than crashing the pipeline.

Contributor-facing internals — store layout, Monaco bundling, accessibility patterns — are in [docs/architecture.md](docs/architecture.md).

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

`[source::<pattern>]` > `[host::<pattern>]` > `[<sourcetype>]` > `[default]`. Within a type, more specific patterns win. Directives from all matching stanzas merge in precedence order.

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

`src/engine/**` is pure logic with no React imports and no runtime dependencies, and it runs unchanged in the browser, in a Web Worker, and under Node. `runPipeline` is the entry point. [docs/engine.md](docs/engine.md) covers the API: `PipelineOptions`, layered conf input with override provenance, and the caveats that matter when running user-supplied regexes under Node.

[`packages/mcp-server`](packages/mcp-server) is the Node consumer of that API: an MCP server exposing `simulate`, `validate`, `explain_precedence` and `lookup_directive` tools, so an LLM agent can run a config against real sample data instead of guessing about it. It implements the untrusted-regex discipline engine.md prescribes — every engine run happens in a terminatable worker thread under a wall-clock budget. See its [README](packages/mcp-server/README.md).

## Project structure

```
src/
├── engine/                    # Splunk simulation (pure logic, no React)
│   ├── types.ts               # SplunkEvent, ProcessingResult, ConfDirective
│   ├── pipeline.ts            # runPipeline() — sole entry point
│   ├── pipelineWorker.ts      # Web Worker wrapper
│   ├── directiveRegistry.ts   # Directive entries — drives completion,
│   │                          #   hover, linting AND the dictionary
│   ├── stanzaRegistry.ts      # The four stanza header kinds + precedence
│   ├── pipelineStages.ts      # The 11 stages, and key → stage lookup
│   ├── parser/
│   │   ├── confParser.ts      # INI parser + default/local layer merge → ParsedConf
│   │   ├── provenance.ts      # Locate a diagnostic at a directive/stanza (+ its layer)
│   │   └── stanzaMatcher.ts   # Precedence-based stanza matching
│   ├── processors/            # One file per processing stage
│   ├── transforms/            # regexTransform, destKeyRouter, ingestEval
│   ├── cim/                   # cimModels.ts + cimModelsData.ts (CIM 8.5.0)
│   └── utils/
│       └── flattenJson.ts     # With prototype-pollution guard
│
├── monaco/                    # Monaco language support
│   ├── splunkConfCompletion.ts
│   ├── splunkConfHover.ts
│   ├── splunkConfFolding.ts
│   ├── splunkConfDiagnostics.ts
│   └── dictionaryCommand.ts   # "Open in dictionary" command id + URI
│
├── store/useAppStore.ts       # Zustand store (flat; subscribe per slice)
├── hooks/                     # useProcessingPipeline, useDebounce, useTheme, usePagination
├── utils/                     # splunkRegex, strftime, diffEngine, fieldHighlight
│
└── components/
    ├── layout/                # AppShell, ActivityRail, SimulatorView,
    │                          #   MobileShell, Header, StatusBar
    ├── dictionary/            # DictionaryView + list, detail, badges, entries
    ├── raw/                   # RawPanel (Monaco plaintext)
    ├── metadata/              # MetadataPanel
    ├── editor/                # SplunkEditor + props/transforms editors, editorRegistry
    ├── preview/
    │   ├── PreviewPanel.tsx   # Output container
    │   ├── PreviewFilterBar.tsx
    │   └── tabs/              # Raw, Timestamp, Highlighted, Diff, Regex,
    │       └── shared/        #   CimModels, Fields, Transforms, Metadata
    ├── settings/              # SettingsPanel (gear in header)
    ├── onboarding/            # FirstRunBanner
    ├── help/                  # HelpPanel (pipeline reference slide-out)
    └── ui/                    # Tabs, Badge, Tooltip, CommandPalette, etc.

e2e/                           # Playwright smoke tests (production build, Chromium)
├── fixtures.ts                # Console/CSP error collection + readiness helpers
└── smoke.spec.ts
```

## Output tabs

**Top-level:** Preview, CIM Models, Fields, Pipeline, Architecture.

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

`directiveRegistry.ts` drives all three features. Add a `DirectiveInfo` entry and autocomplete, hover, and linting pick it up automatically — as does the dictionary. How Monaco is bundled (the `editor.api` / `editor.all` split and the `codeSplitting` group around it) is covered in [docs/architecture.md](docs/architecture.md).

## Dictionary

A reference view for every `props.conf` and `transforms.conf` setting the simulator knows about, plus the four stanza header kinds. Search by key or description, filter by phase (index-time / search-time) and conf file, hide deprecated keys, and read each entry's description, example, default, valid values and pipeline stage.

Every row in the browse list carries two designations — which conf file it belongs in, and which phase it runs at — so both are answerable without opening the entry. That is also what distinguishes `MATCH_LIMIT` and `DEPTH_LIMIT`, the two keys the registry defines once per conf file with file-specific wording.

There is no prose here that the editor does not also have: entries are built from `directiveRegistry.ts` and `stanzaRegistry.ts`, so the dictionary and the hover tooltips cannot drift apart. The pipeline reference drawer and the dictionary answer different questions — "what runs when" versus "what does this key do" — and cross-link both ways.

Three routes in: the activity rail, `Ctrl/Cmd+K` → "Dictionary: KEY", and the "Open in dictionary" link at the bottom of any directive hover.

## Eval expression engine

Full tokenizer and recursive-descent parser in `evalProcessor.ts`.

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

- **The Content-Security-Policy.** It lives in `index.html` and only means anything in a browser. `img-src` was missing for the entire life of the policy, so Chromium refused every one of Monaco's `data:` squiggle SVGs and the lint underlines never drew — visible only as a console error nobody was watching. The suite asserts zero CSP violations and zero console errors on boot.
- **Worker bundling.** The whole simulation runs in a Web Worker created via `new Worker(new URL(…), { type: 'module' })`. Whether Vite emits a loadable chunk for that is a build-time question with a runtime answer.
- **The Monaco chunk split.** `MonacoEditor.tsx` imports the slim `editor.api` entry and `vite.config.ts` hand-rolls a `codeSplitting` group around it. A bad split type-checks, builds, and then fails to mount an editor.

One note if you extend it: the app runs the pipeline once on mount with an empty raw log, and `runPipeline` returns a real result for empty input (`eventCount: 0`). So the status bar reads "Worker idle · 0 events" *before* anything is loaded — wait on a non-zero event count, as `loadExample` does, not on the idle state.

`@playwright/test` is pinned to `~1.56` to match the Chromium revision preinstalled in the dev container; bump it freely, since CI installs the matching browser itself.

`ci.yml` runs lint → build (`tsc -b && vite build`) → tests → e2e smoke → `npm audit` on every PR and on pushes to main. The Azure SWA deploy workflow is separate and has no test job of its own: it triggers on push to main and runs its own build, so it is gated by CI only in the sense that both run on the same commit. Node is pinned once, in `.nvmrc`, which `ci.yml` and `package.json`'s `engines` both follow.

## Simulation fidelity

A simulator's correctness oracle is "matches real Splunk", which is a closed-source, versioned, partly undocumented target — so fidelity can never be *proven* complete. It can be bounded. This section is that boundary in one place: what is simulated, what is deliberately not, and where the simulation knowingly diverges. Verify anything suspicious against a real indexer before relying on the output.

The fixtures under [`src/engine/__tests__/fixtures/`](src/engine/__tests__/fixtures/) are the only assertions here derived from Splunk itself: functional output observed on Splunk Enterprise 10.4.0, owned by the maintainer who captured them under section 18.2 of the Splunk General Terms, and kept as regression pins for behaviour the documentation gets wrong. They are not being re-captured, and the capture script is gone, because the General Terms that govern the free edition and the container do not permit a capture — [the fixtures README](src/engine/__tests__/fixtures/README.md) names the clauses. Everything else asserts against the documentation and says so.

Every directive the registry knows about carries one of three support levels, declared in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts):

| Level | Count | Meaning |
|---|---|---|
| **simulated** | 54 | The engine implements it and tests assert the behaviour. |
| **documented** | 25 | Recognised on purpose, outside the simulation for a reason that is not going to change — it belongs to a layer a browser has no access to, or it has no observable effect on output. |
| **ignored** | 0 | Should be simulated, is not yet, and names the issue tracking it. Every one of these is a known wrong answer. |

The counts are asserted by a test against the table itself, so they cannot go stale.

A fourth state sits outside that table, because the table can only classify what the registry knows about. **29** attributes are valid in Splunk 10.4.0 and are not in the registry at all; until [#178](https://github.com/Bimmiest/propslab/issues/178) generates the registry from the `.spec` files, writing one of them is the same experience as an `ignored` directive — the preview does not honour it and says so. They are named in `UNDOCUMENTED_ATTRIBUTES` in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts), by name only: their value types and defaults are facts belonging to the spec, and guessing them here is the failure the fidelity corpus exists to catch.

Writing a directive that is not `simulated` produces a diagnostic under its editor — a warning for `ignored`, an informational note for `documented`. The dictionary and the editor hover say the same thing on the entry itself. The point is that the tool never silently renders output as though a line you wrote were absent.

One `simulated` entry carries a caveat rather than a clean bill of health: `INDEXED_EXTRACTIONS` simulates every format it names — csv, tsv, psv, w3c and json — but the attributes that customise the delimited ones are `ignored` ([#184](https://github.com/Bimmiest/propslab/issues/184)).

### Not simulated yet (`ignored`)

**The roster is currently empty.** An `ignored` entry is a directive the preview accepts and then does not honour — a known wrong answer — and there are none at present: the last one, `TZ_ALIAS`, was implemented in [#227](https://github.com/Bimmiest/propslab/issues/227).

The mechanism stays, because the count is a measurement rather than a promise and the next unimplemented directive will land back here. It lives in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts): every `ignored` entry states what is missing and names its tracking issue, and the same text appears verbatim on the directive's hover, its editor warning, and its dictionary entry. A [scheduled workflow](.github/workflows/roster.yml) checks that those issues are still open, because an entry pointing at a closed issue is how this roster last went stale — `TZ_ALIAS` named #159 for months after the work it was waiting on had landed without it.

### Deliberately out of scope (`documented`)

Lookups (`LOOKUP` and all thirteen `transforms.conf` lookup attributes) need a lookup table, and a browser tool with no backend has nowhere to get one — `LOOKUP-*` directives are parsed and warn, but fields sourced from lookups will not appear. `EVENT_BREAKER`, `EVENT_BREAKER_ENABLE`, `CHARSET`, `NO_BINARY_CHECK` and `LEARN_SOURCETYPE` belong to the forwarder and input layers, upstream of everything simulated here. `SEGMENTATION` changes how the indexer segments terms for search rather than the event or its fields. `MATCH_LIMIT`, `DEPTH_LIMIT` and `CAN_OPTIMIZE` bound how hard a match tries, not what a successful match produces. `LINE_BREAKER_LOOKBEHIND` governs how far Splunk looks back across an internal chunk boundary, and the simulator holds the whole input in memory with no chunk boundaries to look across. `CHECK_FOR_HEADER` is deprecated by Splunk in favour of `INDEXED_EXTRACTIONS`, which is simulated.

### Stubbed eval functions

The directive levels above do not cover eval *functions*, which have their own boundary:

- **Crypto functions.** `md5()`, `sha1()`, `sha256()`, `sha512()` return a placeholder string (e.g. `[md5() not simulated]`) and emit a warning.
- **Partial stubs.** `cidrmatch()`, `searchmatch()`, `relative_time()`, `strptime()`, `mvfilter()` (returns its input unfiltered), and `sigfig()` / `exact()` (return the value unrounded) have simplified implementations; results may not match Splunk on edge cases. Every one of them emits a warning when evaluated, so a stubbed result is never mistaken for a computed one.

### Simplified

- **`SEDCMD` occurrence flag.** The `s/` substitute and `y/` transliterate forms are both simulated. The numeric occurrence flag (`s/…/…/2`), a value that is not a sed expression at all, a `y///` whose two character sets differ in length, and a pattern that will not compile each emit a warning rather than being dropped in silence.
- **Delimited `INDEXED_EXTRACTIONS` overrides apply to `csv`/`tsv`/`psv` only.** `FIELD_DELIMITER`, `FIELD_QUOTE`, `FIELD_NAMES`, `HEADER_FIELD_LINE_NUMBER`, `PREAMBLE_REGEX` and `TIMESTAMP_FIELDS` are honoured for the delimited formats; `w3c` keeps its own `#Fields` header mechanism, which they do not override there. `FIELD_HEADER_REGEX`, header-side delimiters (`HEADER_FIELD_DELIMITER`/`HEADER_FIELD_QUOTE`), `MISSING_VALUE_REGEX`, and `KEEP_EMPTY_VALS`/`CLEAN_KEYS` in this context remain unimplemented. transforms.conf's own `CLEAN_KEYS` **is** simulated, pinned to a Splunk 10.4.0 capture.
- **Stanza specificity is a heuristic.** Ranked by literal character count. Splunk's real tie-breaking for equal-score `source::` patterns is alphabetical; ordering can diverge for tied patterns.
- **`priority` rules are taken from the documentation, not from a capture.** `priority` orders stanzas *within* a kind and cannot reach across kinds: `source` > `host` > `sourcetype` > `default` holds regardless of what any stanza declares, which is what `props.conf.spec` says explicitly. A stanza that declares nothing defaults by how it matches rather than by its kind — 100 when the stanza matches literally (`[my_sourcetype]`, `[source::/var/log/app.log]`), 0 when it contains a wildcard (`[source::...app...]`, `[host::web*]`) — so a wildcard stanza needs `priority` above 100 to beat a literal sibling. No fidelity fixture pins any of this, so it is the one part of stanza resolution asserted only against our reading of the docs, and the docs contradict themselves once on the cross-kind question ([#198](https://github.com/Bimmiest/propslab/issues/198)). `sourcetype` and `rename` are in the same position, though their rules are less ambiguous.
- **`KV_MODE = xml`.** Uses `DOMParser` inside the Web Worker — works in Chromium, historically not in Firefox workers. A try/catch falls back silently, so XML extraction may produce no fields on unsupported browsers. Element fields are named by their dotted path from the document root, including the root itself (`<event><user>…` gives `event.user`), which the Splunk 10.4.0 capture pins. Attribute naming is *not* pinned by any capture: attributes keep their bare names, except that a `Name` attribute follows the Windows event-log convention and names the field itself.
- **`PAIR_RE` in transform `FORMAT` does not handle escaped quotes in quoted values.** `"([^"]*)"` stops at the first inner `"`, so `field::"say \"hi\""` parses as `field=say \`. Real Splunk behaviour here is under-documented; treat as an edge case.

### Opt-in

- **`DEST_KEY = MetaData:*` re-routing.** By default, writing `MetaData:Sourcetype` updates the event's metadata field but search-time processors still use the original stanza match. Enable **"Re-match stanzas after metadata rewrites"** in Settings (gear icon) to run a fresh `matchStanzas` + `mergeDirectives` pass after index-time transforms, so search-time directives come from the new sourcetype. Batch mode emits a warning when any event had its routing metadata rewritten; per-event mode auto-enables manual-apply to keep the editor responsive.

### Other

- **ReDoS protection is heuristic first, worker-backed second.** `safeRegex()` rejects a best-effort class of catastrophically backtracking patterns before compiling them — nested/grouped quantifiers (`(a+)+`, `(.*)*x`, `(.*,){20}`) and adjacent same-atom quantifiers (`a*a*`, `\d+\d+`) — but it does **not** catch alternation-overlap forms like `(a|aa)+` or `(a+|b)+` (detecting those without rejecting benign alternations such as `(foo|bar)+` needs a real overlap analysis). Both the main processing pipeline (5 s watchdog) and the **Regex tab's live tester** (its own 2 s watchdog) run matching inside a Web Worker, so a pattern that slips the heuristic hangs the worker — which is terminated and restarted — rather than freezing the UI. The one remaining main-thread matcher is the **Create-EXTRACT dialog's** live capture (a single event's text), still guarded only by the heuristic.
- **Raw data capped at 1 MB.** The cap is applied inside the pipeline, not at the store: a larger input is accepted, stored and sent to the worker in full, then *truncated* for processing — cut back to the last complete line, so the trailing partial event is dropped rather than mis-broken, with a warning saying so. Nothing rejects the input, and the editor still holds all of it.
- **Sourcetype stanzas match by strict equality.** This matches real Splunk — sourcetype names are literal, no wildcards — noted here so contributors don't add wildcard support by analogy with `source::` / `host::`.
- **Monaco find-widget tooltip flicker.** Upstream bug in Monaco's hover service ([microsoft/monaco-editor#5208](https://github.com/microsoft/monaco-editor/issues/5208)); no local fix.

See [CHANGELOG.md](CHANGELOG.md) for fix history

## Tech stack

React 19, Vite 8, TypeScript 5.9, Tailwind CSS 4 (CSS-first config), Monaco Editor 0.55 (mounted directly by `MonacoEditor.tsx`), Zustand 5, react-resizable-panels 4.6, `diff` 9, `cmdk` (command palette), `@radix-ui/react-tooltip`.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers setup, the CI checks, where a change goes, and the recipes for adding directives, eval functions, CIM models, and preview tabs. Contributor-facing internals are in [docs/architecture.md](docs/architecture.md).
