# Architecture notes

This file describes the internals for contributors: the project structure, the store, the workers, the Monaco bundle, the accessibility patterns and the tech stack. [pipeline.md](pipeline.md) gives the order of the stages and stanza precedence. [user-guide.md](user-guide.md) gives the layout. The architecture decision records in [`docs/adr/`](adr/README.md) give the reasons for the design choices of the engine, and the issues that caused them.

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

## State management

Single Zustand store (`src/store/useAppStore.ts`). The store is flat — components subscribe to individual slices rather than reading the whole store. A subscription re-renders its component on every change, so the ones that change per keystroke sit in leaves: the pipeline hook runs in `PipelineController`, which renders nothing, and PreviewPanel reads the run's inputs through a small provider rather than itself.

```
rawData / metadata / propsConf / transformsConf     User inputs (ephemeral)
processingResult / validationDiagnostics            Pipeline output
isProcessing / lastProcessingMs                     StatusBar telemetry
theme / activeOutputTab / collapsedPanels / ...     UI state
activeView / dictionarySelection                    Rail view + dictionary deep link
settings / pipelineDirty / manualRunTick            Simulator options and the manual-apply run trigger
```

localStorage holds preferences only: UI state (split-pane sizes, seen-intro flag, theme) and the simulator settings (`propslab:settings` — per-event pipeline and manual-apply, so a reload keeps the mode the user chose), each read inside try/catch with typed fallbacks. Raw logs and configuration are not persisted — a refresh clears them.

Monaco editor instances live in a module-level `Map` in `editorRegistry.ts`, not in the Zustand store.

## Workers

Three workers run user regexes off the main thread: the pipeline (`pipelineWorker.ts`), the Regex tab and Create EXTRACT dialog (`regexMatchWorker.ts`), and the Timestamp tab and TIME_FORMAT hover (`timestampMatchWorker.ts`). All three share one lifecycle, `createManagedWorker` in `src/hooks/workerLifecycle.ts`. It has no React import, so the hover can use it outside a component. Each caller passes in only its fallback policy, as callbacks.

The lifecycle rules:

- **Regex engine first, then ready.** Each worker entry runs through `serveWithRegexEngine` (`utils/regexEngineLoader.ts`): it loads the PCRE2 WebAssembly module itself, from the one same-origin asset URL fixed at build time, and only then posts `WORKER_READY` (`engine/workerProtocol.ts`). Requests that arrive while it loads wait, in order. The engine is never taken from a message, so no message can choose the code a worker compiles; loading costs a few milliseconds, and the page loads its own copy for the editor before the first render.
- **Ready signal.** An error before `WORKER_READY` is a *load failure*: the chunk didn't fetch, CSP blocked it, the module threw at top level, or the engine would not instantiate. An error after it is a *crash*.
- **Load failures are capped.** After `MAX_WORKER_LOAD_FAILURES`, no new worker is built. The pipeline and the matchers then run on the calling thread. The hover has no fallback and drops its sample line.
- **Crashes are never retried inline.** A request whose worker crashed never runs on the main thread (#326).
- **Classification uses the ready signal, not the work sent.** The first request is posted before the worker's script has run, so it can't be used to tell a load failure from a crash (#339).
- **A watchdog times the request's own run.** A worker runs its requests in order, so a request's budget starts when the one ahead of it is answered, not when it is posted. A request the caller has superseded keeps its watchdog; if it hangs, the newer requests go to the replacement worker unblamed (#364).
- **A load is never charged to a request.** Before ready no watchdog runs, however many requests are posted; the load timer (`LOAD_WAIT_FACTOR` run budgets) bounds the wait, and expiring counts as a load failure. A run budget against a worker still downloading would restart the download on every edit (#420).

A new worker entry must serve through `serveWithRegexEngine`, which posts `WORKER_READY`. A caller must not handle `onerror` itself.

### The live testers' requests

The Regex and Timestamp tabs match a changing pattern or config against the same events many times. Two rules keep that cheap (#496):

- **Inputs travel once.** `useWorkerRequest`'s `sendAhead` posts the events in an inputs message (`WorkerInputsMessage`) when they change, and each request names them by `inputsId` instead of carrying them; at 20k events that was about 10 MB cloned per keystroke. The lifecycle's `setInputs` re-sends the current inputs first to every replacement worker, so a request replayed after a crash or a timeout finds them there.
- **Superseded requests are skipped.** A request marked `latestOnly` waits one task in the worker (`createRequestQueue`), and is answered `skipped` without running when a newer `latestOnly` request has arrived behind it. With a slow pattern, the answer the user waits for no longer queues behind every pattern typed past. The pipeline worker's requests are `latestOnly` too, so an edit made during a slow run is answered after one more run, not after every request typed past it ([#562](https://github.com/Bimmiest/propslab/issues/562)). The TIME_FORMAT hover's requests are not `latestOnly`: several hovers can each be waited on.

### What the pipeline worker sends back

The pipeline worker does not post `runPipeline`'s result as is. At 20k events, cloning it cost as much as the run itself, and most of that was per-event traces: prose and before/after snapshots on every step, which no view reads per event. `toViewResult` (`utils/viewResult.ts`) reduces each step to its structured fields (`TraceStep`) and interns the traces, so events whose steps match share one array and structured clone sends it once; it also interns metadata and drops `timestampText` where it equals `_raw`. The Pipeline tab, the one view that shows step prose, reads `stepSummaries`, which the worker builds from the full traces. The store holds a `ViewResult`, and the inline fallback applies the same reduction, so the views see one shape either way. A view that needs something new from a step reads a structured field (`metadataChanges`, `truncation`, `timeSource`), never `description`.

The worker also counts the run's fields once (`fieldStats`, `utils/fieldStats.ts`): the distinct names in first-seen order, how many events have each, and which hold JSON containers. The status bar, the preview's field filter and the CIM, Extractions and Fields tabs read that rather than each walking every event's fields on the main thread after every run (#496).

## Monaco bundling

Monaco's widgets (hover, suggest, code actions, folding, find, multi-cursor) are *contributions*, imported separately from the API surface (`monaco-editor/editor`) in `MonacoEditor.tsx` — one `monaco-editor/features/*/register` module at a time, not all of them, which would also register sticky scroll, rename, code lens and ~40 more contributions the app never enables. `monaco-editor/editor` alone registers providers that nothing ever renders, so dropping a contribution silently removes its feature; the e2e suite exercises each one. `vite.config.ts` groups the slim `esm/vs` tree via `codeSplitting` (Rolldown's replacement for `manualChunks` — it claims modules the graph already reached rather than naming ids to pull in). A bad split passes the type-check and the build, and then the editor does not mount. The e2e suite exists to find this ([testing.md](testing.md#end-to-end-npm-run-teste2e)).

The whole editor loads lazily: `LazyEditors.tsx` is the only thing the shell imports, and it reaches `MonacoEditor`, `SplunkEditor` and `splunkMonacoSetup` through one dynamic import (`editorRuntime.tsx`), so the entry chunk neither contains nor waits for Monaco. Anything that imports monaco at runtime must stay behind that boundary — including `MonacoEnvironment`'s `?worker` import, which the chunk group claims. `scripts/check-bundle-size.mjs` holds each chunk to a gzip budget in CI.

## Accessibility

- Skip-to-content link (visible on focus).
- Semantic HTML and landmarks (`<header>`, `<nav>` around the activity rail, `<main>`, `<footer>` for the status bar, a labelled `<section>` for the first-run banner), with a heading hierarchy that does not skip levels.
- WAI-ARIA tablist: `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`, `aria-controls`, `aria-labelledby`.
- Arrow keys navigate tabs; Home/End jump to first/last. The activity rail is vertical and declares `aria-orientation`.
- The rail's buttons carry `aria-label`, not just a tooltip: they have no visible text, and a Radix tooltip contributes `aria-describedby`, which supplements an accessible name rather than supplying one.
- The dictionary list is a `role="listbox"` driven by `aria-activedescendant`, so one Tab stop covers 80-odd rows.
- Inputs have an accessible name: an associated `<label>` via `htmlFor`/`id` (ids from `useId`), or `aria-label` where there is no visible label.
- A global `:focus-visible` outline in `index.css` is the floor for every focusable element; components that draw their own `focus-visible:ring-*` take precedence over it. Do not add `outline-none` without a replacement ring.
- Colour tokens in `index.css` are chosen for 4.5:1 as text on every surface they meet, including their own 10% tint (status chips) — which is why the dark accent is light enough to need dark text on an accent fill (`--color-text-on-accent`). Do not reach for `text-white` on an accent or error fill, or for opacity to de-emphasise text; use `--color-text-muted`. Field highlight colours come in a light and a dark set for the same reason. Input borders use `--color-border-control`, which meets 3:1 against the surface (WCAG 1.4.11); `--color-border` is for dividers between surfaces, which need no contrast. `src/__tests__/themeContrast.test.ts` reads the tokens from `index.css` and the Monaco themes and checks every pair, and `e2e/a11y.spec.ts` checks the rendered app in both themes.
- Clickable spans and divs that cannot be `<button>`s go through `components/ui/pressable.ts`, which adds the tab stop, `role="button"` and Enter/Space. The highlighted spans inside raw event text are the deliberate exception: one tab stop per value would bury the page, and the field sidebar offers the same pin action.
- Raw-text selection (`SelectableRaw`) has a keyboard path: arrows select tokens, Shift extends, Shift+F10 or the Menu key opens the row's context menu.
- `eslint-plugin-jsx-a11y` is not wired into lint: its peer range ends at eslint 9. Tracked in #302.
- Panel-level `ErrorBoundary` with "Try Again" recovery; the header and each overlay have their own, and lazy chunks load through `retryableLazy` so "Try Again" refetches a chunk that failed. When a redeploy deleted the chunk, `staleChunkReload.ts` reloads onto the current build and keeps the inputs and the active view in `sessionStorage` over the reload. It does not reload when it cannot save them, when the browser is offline, or when a chunk fails again within 10 s after such a reload. A root boundary catches the rest and offers "Copy config" (inputs are not persisted) and "Reload".

### Overlays

Every overlay — command palette, settings, scaffold modal, pipeline reference,
metadata, directive and confirm dialogs — goes through `components/ui/Overlay.tsx`,
which wraps `@radix-ui/react-dialog`. That supplies the Escape layer stack (only
the topmost overlay closes), the focus trap, background inertness, scroll lock,
and focus return to the trigger.

An overlay is never force-mounted: closed content left in the tree keeps a Radix
DismissableLayer alive, and its capture-phase Escape handler then swallows Escape
for the whole app. Each one is rendered closed (`open={false}`) rather than not
at all, and Radix's Presence keeps it mounted while its exit animation runs. State
that belongs to one opening (a form's fields, Scaffold's suggestions) lives in a
component inside the content, which Presence mounts afresh on each opening and
unmounts after the exit, so a closed dialog holds nothing and computes nothing
(#702). Presence watches each direct child of the portal
separately, so the content element places itself (`fixed`, `z-50`) with no layout
wrapper around it: a wrapper with no animation of its own unmounts at once and
cuts the content's exit short (#696).

## Motion

`index.css` holds the motion tokens (`--motion-fast`, `--motion-base`,
`--motion-slow`, `--ease-out`, `--ease-in`) and the classes built on them. Use
these rather than a component's own `duration-*` or keyframes:

- `motion-fade`, `motion-pop`, `drawer-slide` and `motion-tooltip` enter and exit
  on Radix's `data-state`: a backdrop, a dialog or menu, a side drawer, a tooltip.
- `motion-pop-in`, `motion-fade-in` and `motion-reveal` are entrances only, for
  what React mounts itself: a popup, a tab's content, a disclosure's body. An
  open native `<details>` reveals the same way.
- `press` gives a button press feedback. It carries the colour transitions, so it
  replaces `transition-colors`.

Under `prefers-reduced-motion` every animation and transition is instant, and
`press` does not scale.

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
