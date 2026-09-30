# Changelog

All notable changes to Propslab are documented here, newest first. Entries say what changed for a user; the reasoning behind larger design choices is in [`docs/adr/`](docs/adr/README.md).

---

## Unreleased

### Added

- **An entry-graph gate and an initial-load budget** ([#467](https://github.com/Bimmiest/propslab/issues/467)). `check-entry-graph.mjs` fails the build if the startup path reaches the Monaco chunk; `check-bundle-size.mjs` budgets the modulepreload set and the codicon font.
- **Governance files** ([#520](https://github.com/Bimmiest/propslab/issues/520)): CODEOWNERS, issue forms (bug, fidelity question, enhancement), a PR template, a code of conduct, and a release process in CONTRIBUTING; the environment check now asserts `main`'s branch protection.
- **Directive evidence test** ([#505](https://github.com/Bimmiest/propslab/issues/505)). Every simulated directive must be backed by a Splunk fixture or a test that sets it; the fixture-backed count is ratcheted, and the fidelity suite can no longer skip silently.
- **Table-driven eval builtin fidelity test** ([#512](https://github.com/Bimmiest/propslab/issues/512)), a model-based property test of the worker lifecycle ([#513](https://github.com/Bimmiest/propslab/issues/513)), a lint/editor diagnostics parity property ([#500](https://github.com/Bimmiest/propslab/issues/500)), a Monaco `fakeModel` contract test and a grammar/parser agreement property ([#516](https://github.com/Bimmiest/propslab/issues/516)), and a docs consistency test ([#519](https://github.com/Bimmiest/propslab/issues/519)).

- **A weekly check of the `production` environment** ([#456](https://github.com/Bimmiest/propslab/issues/456)). `environment.yml` verifies through the API that deploys come from `main` only and that the deployment token is an environment secret; the secret check needs a read-only `SECRETS_READ_TOKEN`.
- **CI lints the workflows and reviews each PR's dependencies** ([#456](https://github.com/Bimmiest/propslab/issues/456)). New `workflow-lint` and `dependency-review` jobs, a Dependabot cooldown, a `pcre2.wasm` checksum check, and stricter type and switch checks.
- **The MCP server runs under Node's permission model** ([#455](https://github.com/Bimmiest/propslab/issues/455)). The server and its workers can read only `dist/`, and cannot write files, start processes or load addons.
- **The MCP server package installs on its own** ([#455](https://github.com/Bimmiest/propslab/issues/455)). It declares `pcre2-wasm-utf16` itself, has a coverage floor, and its request-id scan, message limiter and serializer are mutation-tested.
- **The CSP enforces Trusted Types** ([#458](https://github.com/Bimmiest/propslab/issues/458)). A new `innerHTML` or script-URL sink fails loudly; only Monaco's, `dompurify` and a same-origin-worker `default` policy are allowed.
- **A close or reload asks first when there are unsaved edits** ([#453](https://github.com/Bimmiest/propslab/issues/453)). Collapsing a panel or switching mobile tabs now keeps each editor's undo history, cursor and scroll.
- **The Fields table and sidebar render only the rows near the viewport** ([#454](https://github.com/Bimmiest/propslab/issues/454)), with `aria-rowcount`/`aria-rowindex`; the Extractions events pane is keyboard-focusable.
- **Regex-heavy configs are covered by the perf test** ([#454](https://github.com/Bimmiest/propslab/issues/454)), and existing budgets are tightened.
- **Mutation testing for the engine** ([#370](https://github.com/Bimmiest/propslab/issues/370)). `npm run test:mutation` runs Stryker over `src/engine/**`; `mutation.yml` runs it weekly and on changed files in engine PRs, with a 78% floor. The tests it prompted raised the score from 73.2% to 79.6%.
- **Wrap markers and two-cell full-width characters in the raw-log editor** ([#392](https://github.com/Bimmiest/propslab/issues/392)). Display only; match positions are unchanged.
- **Structured output and tool annotations for the MCP server** ([#389](https://github.com/Bimmiest/propslab/issues/389)). Each tool declares an `outputSchema` and returns `structuredContent`, and all four are annotated read-only, idempotent and closed-world.
- **Property-based tests for conf parsing, timestamps and the MCP tools** ([#371](https://github.com/Bimmiest/propslab/issues/371)). They found, and this fixes:
  - an indented comment or header, a backslash before whitespace, `[]`, and a broken header containing `=` read differently by the linter and the parser;
  - four-digit years below 100 read as 19xx;
  - a yearless 29 February landing in the future or failing to parse;
  - a yearless stamp from a zone already in the new year placed a year early ([ADR 0005](docs/adr/0005-yearless-timestamps-take-the-most-recent-year.md)).
- **Accessibility checks in the end-to-end suite** ([#372](https://github.com/Bimmiest/propslab/issues/372)). Every main view is scanned with axe-core against WCAG 2.2 AA in both themes. The contrast fixes change the palette visibly, and several landmarks, names and target sizes are corrected.
- **A bundle-size budget** ([#375](https://github.com/Bimmiest/propslab/issues/375)). The editor loads after the page and ships only the Monaco features used (Monaco 913 → 800 kB gzip, initial script 162 → 146 kB); CI fails if a chunk exceeds its budget.
- **A large-input performance budget** ([#376](https://github.com/Bimmiest/propslab/issues/376)). A 20,000-event paste is timed end to end, including switching to every output tab.

- **Property-based tests for the eval parser and the PCRE→JS translation** ([#340](https://github.com/Bimmiest/propslab/issues/340)). fast-check, run with a fixed seed, checks that:
  - the parser throws only its own errors;
  - keyword casing and whitespace never change a result;
  - the operator equivalences hold;
  - an AST survives being printed and parsed again;
  - translation leaves JS-compatible patterns, `(?i)` scoping and class contents intact.
- **Every directive the registry knows is simulated or deliberately out of scope** ([#271](https://github.com/Bimmiest/propslab/issues/271)–[#275](https://github.com/Bimmiest/propslab/issues/275)). Counts finish at 75 simulated, 74 documented, 0 ignored; the new simulations are doc-derived.
  - **`INDEXED_EXTRACTIONS = xml`, `xmlkv` and `xmlkv-winevt`** ([#271](https://github.com/Bimmiest/propslab/issues/271)), with all nine supporting attributes; line merging stays on ([ADR 0008](docs/adr/0008-structured-formats-default-line-merging-off.md)).
  - **The header-side delimited overrides** ([#272](https://github.com/Bimmiest/propslab/issues/272)): `FIELD_HEADER_REGEX`, `HEADER_FIELD_DELIMITER`, `HEADER_FIELD_QUOTE`, `HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS` and `MISSING_VALUE_REGEX`. Spaces in header names are still replaced with `_`.
  - **Index-time timestamp fields** ([#273](https://github.com/Bimmiest/propslab/issues/273)): `ADD_EXTRA_TIME_FIELDS` writes `date_*`, `timestartpos` and `timeendpos`, and `DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME` dates a time-only stamp instead of 1 January.
  - **`KV_TRIM_SPACES` and `JSON_TRIM_BRACES_IN_ARRAY_NAMES`** ([#274](https://github.com/Bimmiest/propslab/issues/274)). Automatic KV trims quoted values unless `KV_TRIM_SPACES = false`; the brace trim applies to `INDEXED_EXTRACTIONS = json` only.
  - **`RULESET-<class>`, `STOP_PROCESSING_IF` and `ROUTE_EVENTS_OLDER_THAN`** ([#275](https://github.com/Bimmiest/propslab/issues/275)). `OPTIMIZE_IE_EXTRACT` and `CAN_OPTIMIZE_IE` are `documented`, since the preview runs no search.
- **`transforms.conf.spec` 10.4.3 is covered, and `UNDOCUMENTED_ATTRIBUTES` is empty** ([#178](https://github.com/Bimmiest/propslab/issues/178)). 23 more attributes, mostly lookup and metrics settings, are registered.
- **The undocumented-attribute warning no longer cites a closed issue** ([#227](https://github.com/Bimmiest/propslab/issues/227)). It asks for a report instead, and its tests check each attribute against the conf file it belongs to.
- **The registry covers `props.conf.spec` 10.4.3** ([#178](https://github.com/Bimmiest/propslab/issues/178)). 47 attributes that got no completion, hover or warning are registered with their type, default and values ([#153](https://github.com/Bimmiest/propslab/issues/153)).
- **A README link to a closed issue is replaced** ([#184](https://github.com/Bimmiest/propslab/issues/184) → [#272](https://github.com/Bimmiest/propslab/issues/272)).

### Changed

- **Every CI install runs with `--ignore-scripts`, and the wasm checksum is verified in every job and in the MCP build** ([#504](https://github.com/Bimmiest/propslab/issues/504)). `pcre2-wasm-utf16` is pinned by commit ([#518](https://github.com/Bimmiest/propslab/issues/518)); a weekly job runs the suite shuffled under a non-UTC zone and locale, and the MCP job runs on Windows and macOS too.
- **Deploy hardening** ([#509](https://github.com/Bimmiest/propslab/issues/509)): the CSP test pins every directive's exact sources, a post-deploy step checks the served headers and wasm MIME type, `Strict-Transport-Security` is sent, and the Trusted Types policy is installed by a side-effect module imported first.
- **Test hygiene** ([#507](https://github.com/Bimmiest/propslab/issues/507)): property seeds come from `FC_SEED` when set, mocks and globals are restored per test, Playwright pins a time zone and locale and never reuses a stale server.
- **Booleans**: an unrecognised value now reads as false everywhere, as Splunk's `normalizeBoolean` does, and the engine lint and editor diagnostics share one set of value predicates ([#473](https://github.com/Bimmiest/propslab/issues/473), [#500](https://github.com/Bimmiest/propslab/issues/500)).
- **Editor**: completion no longer fires in comments or continuation lines, inserts a bare key over an existing value, and offers stanza kinds per file ([#501](https://github.com/Bimmiest/propslab/issues/501)); the TIME_FORMAT hover reads the effective stanza through the engine's parser ([#502](https://github.com/Bimmiest/propslab/issues/502)); the Monarch grammar and folding model continuations as the parser does ([#503](https://github.com/Bimmiest/propslab/issues/503)).
- **Lint and TypeScript** ([#510](https://github.com/Bimmiest/propslab/issues/510), in part): config files are linted, the engine cannot import UI modules, and `noImplicitOverride` is on.

- **Large inputs reach the preview faster** ([#454](https://github.com/Bimmiest/propslab/issues/454)). The pipeline worker sends each event's trace without its prose and snapshots, shared between events whose steps match, and summarises the Pipeline tab itself. At 20,000 events the paste to status bar drops from about 2 s to 1.7 s, and the Pipeline tab opens in about 15 ms instead of 95 ([ADR 0013](docs/adr/0013-the-preview-receives-a-reduced-result.md)).
- **Lint runs typescript-eslint's `strictTypeChecked`** ([#456](https://github.com/Bimmiest/propslab/issues/456)), with three rules tuned and the remaining findings fixed.
- **Design rationale lives in [`docs/adr/`](docs/adr/README.md), and changelog entries are short** ([#457](https://github.com/Bimmiest/propslab/issues/457)). History-style code comments moved into ADRs, and older entries are cut to a sentence or two.
- **Every pipeline stage reads one run context** ([#452](https://github.com/Bimmiest/propslab/issues/452)). Stages share one clock, diagnostics list and "already warned" ledger; output is otherwise unchanged.
- **The Timestamp tab's format breakdown and strptime reference agree with the parser** ([#457](https://github.com/Bimmiest/propslab/issues/457)). Both use the parser's tokeniser, so `%j`, `%N`, `%Q` and `%:z` show and `%%Y` is not a year ([ADR 0003](docs/adr/0003-one-strftime-directive-table.md)).
- **The strptime reference marks specifiers the preview does not simulate** ([#457](https://github.com/Bimmiest/propslab/issues/457)), such as `%c`, `%x` and `%U`.
- **Dragging a panel divider previews the split and applies it on release** ([#391](https://github.com/Bimmiest/propslab/issues/391)). Arrow keys still resize per press, and editors collapse only from their header buttons.
- **Monaco is imported through its supported entry points** ([#390](https://github.com/Bimmiest/propslab/issues/390)), `monaco-editor/editor` and `features/<name>/register`; only the suggest controller and editor worker still use internal paths. The hidden find widget no longer takes Tab focus.
- **The largest functions are split into named steps, and ESLint keeps them small** ([#374](https://github.com/Bimmiest/propslab/issues/374)). `max-lines-per-function` (100) and `complexity` (25) are lint errors outside tests. No behaviour change.
- **Code comments state the rule in force, not the issue history behind it** ([#373](https://github.com/Bimmiest/propslab/issues/373)). About 200 files, comments only; the history stays in git and this changelog.
- **Every user-written regex runs on PCRE2 compiled to WebAssembly, and `MATCH_LIMIT` / `DEPTH_LIMIT` are simulated** ([#368](https://github.com/Bimmiest/propslab/issues/368)). The pipeline, editor and MCP server run PCRE2 10.48 from [pcre2-wasm-utf16](https://github.com/Bimmiest/pcre2-wasm-utf16).
  - A match that reaches `MATCH_LIMIT` or `DEPTH_LIMIT` is no match; `DEPTH_LIMIT` is approximate.
  - The structural ReDoS check no longer refuses patterns; replacement syntax (SEDCMD, FORMAT, `replace()`) is unchanged.
  - The CSP allows `'wasm-unsafe-eval'`; cost is about 84 KB gzipped and 5–8% on a 20k-event run.
- **Line breaking, timestamping and the scaffold share one timestamp recogniser** ([#369](https://github.com/Bimmiest/propslab/issues/369)). A line's date starts an event only if it becomes `_time` (#352, #353; [ADR 0007](docs/adr/0007-line-breaking-follows-recorded-splunk-behaviour.md)).
  - An epoch is recognised only at line start or after a delimiter, and only when plausible.
  - Month and weekday names match in any case; a bare month and day is not a date.
  - ctime and RFC 2822 stamps are read whole.
  - A `TIME_PREFIX` that will not compile finds no date for line breaking either.
- **Rollbacks stay in place while the `DEPLOY_PAUSED` repository variable is `true`** ([#345](https://github.com/Bimmiest/propslab/issues/345)).
  - **Before.** A rollback could be displaced or undone by the next automatic run.
  - **Now.** While the variable is set, automatic runs neither queue nor deploy; manual dispatches still work.
  - **The `sha` input** is matched as a whole string and never echoed; every `$GITHUB_OUTPUT` value is validated.
  - **The workflow comments** say the action's SHA pins only its wrapper, not its `:stable` client image.
- **Rollback is a dispatch on `main` with a `sha` input, and build and deploy are separate jobs** ([#333](https://github.com/Bimmiest/propslab/issues/333)).
  - **Why the tag route is gone.** A dispatch from a tag could remove the ancestor check from its own copy of the workflow; only `main` is accepted now.
  - **How rollback works.** The `sha` must look like a hash and be an ancestor of `main`.
  - **Where code runs.** The build job has no environment and installs with `--ignore-scripts`; the deploy job holds the token and runs only the Azure action.
  - **Credentials.** Checkouts no longer keep the GitHub token.
  - **Docs.** CONTRIBUTING no longer claims every deploy is gated on CI.
- **A manual deploy can only ship a commit already on main, from a `production` environment** ([#314](https://github.com/Bimmiest/propslab/issues/314)). The job installs with `--ignore-scripts`; full enforcement needs the token in the environment's secrets.
- **The deploy waits for CI** ([#298](https://github.com/Bimmiest/propslab/issues/298)). It runs on `workflow_run` after CI passes on main and deploys the newest green commit.
- **The MCP server bounds each call's memory and concurrency** ([#299](https://github.com/Bimmiest/propslab/issues/299)). Workers get a 512 MB heap, at most four run at once, an out-of-memory run is a tool error, and signals and exit codes pass through the launcher.
- **Conf booleans are read one way everywhere** ([#301](https://github.com/Bimmiest/propslab/issues/301)). Every boolean accepts true/false, t/f, yes/no, y/n, on/off and 1/0 in any case, and repeated keys in a transforms stanza resolve to the last definition.
- **The largest engine modules are split** ([#301](https://github.com/Bimmiest/propslab/issues/301)): eval into `processors/eval/`, the registry data into `registry/`, and FORMAT parsing out of `regexTransform.ts`. Existing imports still work.
- **Config lint moved out of `runPipeline`** ([#301](https://github.com/Bimmiest/propslab/issues/301)) into `configLint.ts`, and a throw in the line breaker no longer fails the whole run ([ADR 0001](docs/adr/0001-stage-failures-degrade-to-diagnostics.md)).
- **The support counts move to 54 simulated, 50 documented, 22 ignored.** Each real gap names a tracking issue ([#271](https://github.com/Bimmiest/propslab/issues/271)–[#275](https://github.com/Bimmiest/propslab/issues/275)), and three transforms.conf attributes were left for a separate pass.
- **The registry generator proposed in #178 is deliberately not built.** The registry stays hand-maintained, and the drift test that depended on a generator is removed.

### Fixed

- **Coverage floors sit one point under the measured figures** ([#506](https://github.com/Bimmiest/propslab/issues/506)), with per-directory floors for components, hooks, monaco, store and utils, and a CI step fails when any floor falls more than 3 points behind. `main.tsx` and the worker entry points are measured rather than excluded.
- **The weekly randomised run is random** ([#513](https://github.com/Bimmiest/propslab/issues/513)): it draws a fresh property-test seed, uses it for test order too, and prints it with a replay command. Unset, every property test had run on its fixed default.
- **Tests no longer assert wall-clock time** in the wildcard matcher or the MCP server's end-to-end cancellation tests; a shared `makeEvent` helper is introduced and Playwright pins `colorScheme` ([#507](https://github.com/Bimmiest/propslab/issues/507), in part).
- **The mutation gate has a warning band (82 over a break of 78), a canary that fails if the test-name shim breaks, and a monthly report-only run with static mutants** ([#508](https://github.com/Bimmiest/propslab/issues/508)). The worker lifecycle and the store are now mutation-tested.
- **Applying a suggestion over a backslash-continued directive replaces the whole directive** ([#484](https://github.com/Bimmiest/propslab/issues/484)). Only its first line was replaced before, leaving the continuation lines behind as a corrupt props.conf.
- **The weekly production-environment check reads `main`'s rulesets as well as classic branch protection** ([#509](https://github.com/Bimmiest/propslab/issues/509), [#520](https://github.com/Bimmiest/propslab/issues/520)). Either source can meet each requirement, an empty required-checks list no longer counts as configured, and an unreadable classic protection is a warning instead of a failure. The logic is unit-tested.
- **The `docs/engine.md` examples are type-checked in the test suite** and the layered-conf example is run, and CONTRIBUTING's release section describes the process as it works ([#519](https://github.com/Bimmiest/propslab/issues/519)).
- **Dev-dependency advisories are resolved, and `main`'s workflow lint is green again.** `brace-expansion` moves to 5.0.12 and `qs` (under Stryker) to 6.16.0, clearing three high and three moderate `npm audit` findings; an unused loop variable in the post-deploy header check no longer fails `actionlint`.
- **The entry-graph and bundle-size gates parse `dist/index.html` instead of matching tags with a regex.** The regex missed upper-case tags, single-quoted or unquoted attributes and a `>` inside an attribute value, so a startup reference written that way escaped both checks (CodeQL `js/bad-tag-filter`).
- **Directive completion pops up again while a key is being typed.** A key with no `=` yet was coloured as a string, and the editor's quick suggestions are off inside strings, so completion appeared only on Ctrl+Space (a regression from [#501](https://github.com/Bimmiest/propslab/issues/501)).
- **The entry chunk statically imported the whole Monaco chunk** ([#467](https://github.com/Bimmiest/propslab/issues/467)). First load fell from 1108 kB to 232 kB gzip.
- **The windowed field tree stopped following scroll when it mounted past the threshold** ([#469](https://github.com/Bimmiest/propslab/issues/469)).
- **A crash of a superseded worker request was blamed on the newest queued request** ([#491](https://github.com/Bimmiest/propslab/issues/491)).
- **Manual-apply mode**: loading an example now runs it, Ctrl/Cmd+Enter runs, and the empty state says so ([#492](https://github.com/Bimmiest/propslab/issues/492)).
- **eval**: `trim(X, Y)` honours Y and the three trims share one default set ([#474](https://github.com/Bimmiest/propslab/issues/474)); a multivalue operand compares as any-match ([#475](https://github.com/Bimmiest/propslab/issues/475)); a NULL later argument to `split`, `substr` and `mvjoin` yields NULL ([#481](https://github.com/Bimmiest/propslab/issues/481)); non-finite math results yield NULL; deep expressions are rejected with a clear message, `1e3` parses, and `- - x` parses ([#485](https://github.com/Bimmiest/propslab/issues/485)).
- **INDEXED_EXTRACTIONS = json** strips a BOM and reports invalid JSON ([#482](https://github.com/Bimmiest/propslab/issues/482)); **KV_MODE = xml** no longer creates a field named the empty string, and both XML processors share one walker ([#483](https://github.com/Bimmiest/propslab/issues/483)); the KV_MODE and XML reader dedupe loops are linear ([#480](https://github.com/Bimmiest/propslab/issues/480), in part).
- **Completion item kinds** were wrong for Monaco 0.57 ([#499](https://github.com/Bimmiest/propslab/issues/499)); loading an example now has its own undo stop and a remount no longer pushes spurious undo entries on CRLF ([#503](https://github.com/Bimmiest/propslab/issues/503)).
- **Small UX** ([#497](https://github.com/Bimmiest/propslab/issues/497), [#511](https://github.com/Bimmiest/propslab/issues/511), in part): the header shows the platform's modifier key, Enter during IME composition no longer applies a directive, the clipboard fallback restores focus and selection, a loading line shows while the wasm loads, and the error boundary uses the status tokens.

- **A stage that fails on one event no longer drops out for the whole batch** ([#452](https://github.com/Bimmiest/propslab/issues/452)). Per-event stages are re-run per event, and only the failing events pass through unchanged ([ADR 0001](docs/adr/0001-stage-failures-degrade-to-diagnostics.md)).
- **"Did not fire" explanations are capped at 50 missed events per directive** ([#452](https://github.com/Bimmiest/propslab/issues/452)). Later misses read "Not analysed: explanation limit reached for this directive".
- **The `TIME_FORMAT` hover e2e test no longer fails when its worker loads slowly** ([#408](https://github.com/Bimmiest/propslab/issues/408)).

Entries #414–#441 are the seventh review's findings. Its questions about Splunk's own behaviour are filed as #442–#451; the Splunk 10.4.0 fixtures still pass.

- **MCP tool responses are capped in bytes, and a large one no longer crashes the server** ([#414](https://github.com/Bimmiest/propslab/issues/414)). Every tool is held to 8 MiB of UTF-8, a cut list says so in `truncationNote`, and a failed stdout write exits cleanly.
- **No-op explanations no longer slow large previews to a crawl** ([#415](https://github.com/Bimmiest/propslab/issues/415)). They use their own regex cache and a binary search: 5,000 events against 16 non-matching `EXTRACT`s take about 1 s instead of 18 s.
- **`TIMESTAMP_FIELDS` no longer replaces `_time` with the wall clock** ([#416](https://github.com/Bimmiest/propslab/issues/416)). It uses the pipeline's `now` and replaces `_time` only when a stamp was read from the fields.
- **An out-of-range `_time` from `INGEST_EVAL` or `DEST_KEY` no longer breaks the preview or the MCP server** ([#417](https://github.com/Bimmiest/propslab/issues/417)). The event keeps its previous `_time`, with a warning.
- **`INGEST_EVAL` reports each error and warning once per run, not once per event** ([#418](https://github.com/Bimmiest/propslab/issues/418)).
- **`CLONE_SOURCETYPE` no longer repeats transforms warnings once per clone** (follow-up to [#418](https://github.com/Bimmiest/propslab/issues/418)), and `STOP_PROCESSING_IF` de-duplicates with a per-run set.
- **The MCP server stops its work when the client disconnects** ([#419](https://github.com/Bimmiest/propslab/issues/419)). Workers are terminated at EOF, queued calls never start, and the server exits.
- **Typing while a worker is still loading no longer restarts its download** ([#420](https://github.com/Bimmiest/propslab/issues/420)). No watchdog runs until the worker is ready; a load timer bounds the wait.
- **An input that crashed the pipeline worker can no longer end up running on the main thread** ([#421](https://github.com/Bimmiest/propslab/issues/421)), via a sticky `crashed` flag.
- **A `CLONE_SOURCETYPE` copy is its own row in the Raw tab** ([#422](https://github.com/Bimmiest/propslab/issues/422)), and a token selection clears when a re-run changes the event's text.
- **A failed chunk or overlay no longer white-screens the app** ([#423](https://github.com/Bimmiest/propslab/issues/423)). Overlays have their own error boundaries, "Try Again" refetches a failed chunk, and a root screen offers "Copy config" and "Reload".
- **Typing and hovering no longer re-render the whole app** ([#424](https://github.com/Bimmiest/propslab/issues/424)). The pipeline runs in a leaf component, heavy views are memoised, and a hover updates only the spans it changes.
- **An empty `MATCH_LIMIT` or `DEPTH_LIMIT` no longer removes the limit** ([#425](https://github.com/Bimmiest/propslab/issues/425)); blank or non-numeric values use the default.
- **Directive names like `constructor` or `toString` are treated as unknown names** ([#426](https://github.com/Bimmiest/propslab/issues/426)) instead of matching `Object.prototype` members.
- **Automatic KV and the extract-name dialog stay fast on long input** ([#427](https://github.com/Bimmiest/propslab/issues/427)). Both are now linear (32k quoted pairs took 7.5 s).
- **The preview no longer stalls on events with long runs of whitespace** ([#427](https://github.com/Bimmiest/propslab/issues/427)); the change check uses `trimEnd()`.
- **Deeply nested XML no longer strips XML fields from the whole batch** ([#428](https://github.com/Bimmiest/propslab/issues/428)). The walkers are iterative, and a failing event no longer affects the others.
- **eval `strftime()` and the `TIME_FORMAT` preview render every specifier the parser reads; `%j` is right after DST** ([#429](https://github.com/Bimmiest/propslab/issues/429)). Parsing, formatting and linting read one token table ([ADR 0003](docs/adr/0003-one-strftime-directive-table.md)).
- **The Regex tab keeps a capture group named `__proto__`, and draws a group inside a lookahead once** ([#430](https://github.com/Bimmiest/propslab/issues/430)).
- **Apply edits the definition of a directive that takes effect** ([#431](https://github.com/Bimmiest/propslab/issues/431)), the last one, not the first.
- **Preview UI fixes** ([#432](https://github.com/Bimmiest/propslab/issues/432)). The Extractions split is restored, pinned counts are exact, vanished fields stop filtering, tinted fills render again via one `color-mix` helper, and jump-to-line expands a collapsed editor.
- **Escape works again while the pipeline reference is closed, and the panel slides** ([#433](https://github.com/Bimmiest/propslab/issues/433)). The panel unmounts when closed and animates on Radix `data-state`.
- **Screen-reader fixes** ([#434](https://github.com/Bimmiest/propslab/issues/434)). The progress bar is named, disclosures expose `aria-expanded`, and the dictionary's `aria-activedescendant` never points at a hidden entry.
- **MCP server hardening** ([#435](https://github.com/Bimmiest/propslab/issues/435)). `NODE_OPTIONS` heap flags cannot lift the sandbox limit, worker `console.log` goes to stderr, the README setup works on a fresh clone, and `simulate` hides `_queue`.
- **The time-format cache is bounded** ([#436](https://github.com/Bimmiest/propslab/issues/436)) to the 256 most recently used formats ([ADR 0004](docs/adr/0004-bounded-time-format-cache.md)); a Regex tab request that threw during load no longer blocks the queue.
- **`SOURCE_KEY = _meta` no longer shows `_queue`** ([#437](https://github.com/Bimmiest/propslab/issues/437)); `SOURCE_KEY = queue` still reads it.
- **The scaffold keeps a pretty-printed JSON or XML object as one event** ([#438](https://github.com/Bimmiest/propslab/issues/438)) by also suggesting `SHOULD_LINEMERGE = false` and a top-level `LINE_BREAKER`.
- **The scaffold's `TRUNCATE` covers the events its line breaking produces** (follow-up to [#438](https://github.com/Bimmiest/propslab/issues/438)), measured in UTF-8 bytes.
- **Web Workers run under the Content-Security-Policy** ([#439](https://github.com/Bimmiest/propslab/issues/439)). The policy is sent as a header, with `form-action 'none'`, COOP and a `Permissions-Policy`; `vite preview` serves the same headers.
- **Smaller UI fixes** ([#440](https://github.com/Bimmiest/propslab/issues/440)). No dark-theme flash, "Set TIME_PREFIX" validates its pattern, "Open the pipeline reference at this stage" works, and the palette confirms before overwriting edits.
- **The Regex tab keeps its pattern and class name across tab switches, and examples from the empty output panel count as unedited** ([#440](https://github.com/Bimmiest/propslab/issues/440)).
- **The README, Dependabot comments and workflow checkouts match the code again** ([#441](https://github.com/Bimmiest/propslab/issues/441)). Unused `ValidationPanel` and a redundant override are removed, and CI checkouts no longer persist the token.

Entries #398–#404 are the sixth review's findings. Engine tests say whether they are doc- or convention-derived, and the Splunk 10.4.0 fixtures still pass.

- **`EXTRACT` trims whitespace from the ends of extracted values** ([#411](https://github.com/Bimmiest/propslab/issues/411)), as checked on Splunk 10.4.0; a value empty after trimming creates no field, and the preview says so.
- **`EXTRACT … in <field>` can read a field an earlier `EXTRACT` produced** ([#410](https://github.com/Bimmiest/propslab/issues/410)). Extractions run once in class-name order; `KV_MODE` fields remain out of reach.
- **`BREAK_ONLY_BEFORE` breaks before any line it matches, not only a line it starts** ([#323](https://github.com/Bimmiest/propslab/issues/323)), as checked on Splunk 10.4.0; add `^` to anchor it ([ADR 0007](docs/adr/0007-line-breaking-follows-recorded-splunk-behaviour.md)).
- **eval `substr()` matches Splunk at a start of 0 and before the string** ([#397](https://github.com/Bimmiest/propslab/issues/397)): `substr("hello", 0, 3)` is `"hel"` and `substr("hello", -10, 3)` is NULL.
- **Automatic timestamp recognition reads the whole stamp, not a prefix** ([#398](https://github.com/Bimmiest/propslab/issues/398)). Comma fractions, 12-hour clocks, trailing zone names, zoneless Apache and date(1) stamps are read whole.
- **DST gaps and overlaps resolve correctly west of UTC as well as east** ([#399](https://github.com/Bimmiest/propslab/issues/399)), and `%Z` reads `GMT+05:30` whole ([ADR 0006](docs/adr/0006-time-zone-resolution.md)).
- **Re-initialising the regex engine no longer breaks cached patterns** ([#400](https://github.com/Bimmiest/propslab/issues/400)).
- **Mutation testing covers every engine file and the utils it runs on** ([#401](https://github.com/Bimmiest/propslab/issues/401)), including files directly under `src/engine/`, `strftime.ts` and `splunkRegex.ts`.
- **An oversized MCP request fails at once instead of hanging the client** ([#402](https://github.com/Bimmiest/propslab/issues/402)); its `id` is recovered from the ends of the dropped line.
- **Slow worker loads are no longer blamed on the input, and the inline fallback is visible** ([#403](https://github.com/Bimmiest/propslab/issues/403)) as "Main thread (no watchdog)".
- **Stale text about the old regex engine, worker hand-off and Monaco entry points is corrected** ([#404](https://github.com/Bimmiest/propslab/issues/404)), including the MCP `capture_offsets` description.

Entries #351–#366 are the fifth review's findings. Engine tests are doc-derived and say so, and the Splunk 10.4.0 fixtures still pass.

- **BREAK_ONLY_BEFORE_DATE recognises dates by the stanza's own timestamp settings** ([#352](https://github.com/Bimmiest/propslab/issues/352)), matching where the extractor would look.
- **Automatic recognition keeps the zone after long fractions and after a space** ([#353](https://github.com/Bimmiest/propslab/issues/353)); a zone running into a word (`Zookeeper`) is not `Z`.
- **A backslash continuation takes the next line whatever it contains** ([#354](https://github.com/Bimmiest/propslab/issues/354)), as the editor's linter already did.
- **Yearless timestamps take the most recent year, from UTC** ([#356](https://github.com/Bimmiest/propslab/issues/356); [ADR 0005](docs/adr/0005-yearless-timestamps-take-the-most-recent-year.md)). `%b`/`%B` and `%a`/`%A` accept full and abbreviated names.
- **Hitting the JSON depth limit no longer drops the rest of the event** ([#357](https://github.com/Bimmiest/propslab/issues/357)); only the part past the limit is skipped.
- **PCRE syntax that JavaScript reads differently is translated or refused, never passed through** ([#355](https://github.com/Bimmiest/propslab/issues/355)). `\A`, `\z`, `\h`, `\R`, `\Q…\E`, POSIX classes, flag groups and comments are translated; anything else is refused with a reason.
- **Eval reads strings as numbers one way, in decimal** ([#358](https://github.com/Bimmiest/propslab/issues/358)). `substr()` with a negative length returns `""`, and assigning a comparison reports "Fields cannot be assigned a boolean result".
- **`DEST_KEY = _meta` keeps every match and every value** ([#359](https://github.com/Bimmiest/propslab/issues/359)), as multivalue indexed fields.
- **Three smaller regex and FORMAT slips** ([#365](https://github.com/Bimmiest/propslab/issues/365)): an empty-prefix "agreement" in the no-op explainer, one-pass `$N`/`${name}` substitution, and a false ReDoS match on `\d+d+`.
- **The MCP `simulate` response is bounded however many events the sample breaks into** ([#351](https://github.com/Bimmiest/propslab/issues/351)). The worker shapes the response, capped at 2M characters, with a `truncationNote`.
- **MCP `validate` checks every stanza's regexes, and says nothing about text you never sent** ([#360](https://github.com/Bimmiest/propslab/issues/360)); an unclosed group is a syntax error, not a ReDoS risk.
- **Deploy runs that can never deploy no longer displace ones that will** ([#361](https://github.com/Bimmiest/propslab/issues/361)); they get their own concurrency group.
- **Autocomplete lists each directive once** ([#362](https://github.com/Bimmiest/propslab/issues/362)), and the completion and folding providers have tests.
- **Ctrl/Cmd+K opens the command palette from inside an editor** ([#363](https://github.com/Bimmiest/propslab/issues/363)), and the three editors have distinct accessible names.
- **The worker watchdog times a run, not a queue** ([#364](https://github.com/Bimmiest/propslab/issues/364)). A request's budget starts when the worker reaches it, and a slow-loading replacement now receives its input.
- **The Pipeline tab no longer stalls on large inputs** ([#366](https://github.com/Bimmiest/propslab/issues/366)); deduplication uses Sets and details render 100 rows at a time.

Entries #341 and #343–#349 are the rest of the fourth review's findings. Engine tests are doc-derived and say so, and the Splunk 10.4.0 fixtures still pass.

- **Eval comparisons with a missing field give NULL, not a comparison against `""`** ([#343](https://github.com/Bimmiest/propslab/issues/343)).
  - **The bug.** `missing!="a"` was true, so a `level!="INFO"` guard dropped every event without `level`.
  - **The fix.** These now return NULL for a NULL operand:
    - the comparison operators, `LIKE`, and `IN` / `NOT IN` / `in()`;
    - `like()`, `match()` and `cidrmatch()`.
  - **How NULL is treated.** False in `if()`, `case()` and STOP_PROCESSING_IF, three-valued in NOT/AND/OR/XOR, and an EVAL that yields NULL writes no field.
- **A `]` straight after `[` or `[^` in a regex is a literal, as in PCRE** ([#341](https://github.com/Bimmiest/propslab/issues/341)), found by the #340 property tests.
- **XML_IE_* wildcard lists are matched as globs in linear time** ([#344](https://github.com/Bimmiest/propslab/issues/344)) instead of backtracking regexes.
- **INGEST_EVAL rewrites now show in the trace** ([#346](https://github.com/Bimmiest/propslab/issues/346); [ADR 0010](docs/adr/0010-engine-decisions-are-structured-data-on-the-event.md)).
  - A `_raw=` rewrite records before, after and the fields it destroyed, like `DEST_KEY = _raw`.
  - Metadata assignments show old → new.
  - A matched stanza that extracts nothing no longer prints an empty field list.
- **UI fixes** ([#347](https://github.com/Bimmiest/propslab/issues/347)).
  - **Last-run inputs.** Effective config and the Timestamp tab show the inputs of the last run, not unrun edits.
  - **Toggle labels.** Fields and metadata toggles keep a fixed name and use `aria-expanded`.
  - **Regex tab while re-matching.** Cards come from the current events, reusing finished results.
- **Each MCP stdio message is capped at 8 MiB before it is parsed** ([#349](https://github.com/Bimmiest/propslab/issues/349)).
  - **Before.** The whole message was buffered and parsed first; one line over 10 MB could close the transport.
  - **Now.** An oversize line is dropped as it streams and answered with a JSON-RPC error.
- **End-to-end tests check that both match workers and the TIME_FORMAT hover actually load** ([#348](https://github.com/Bimmiest/propslab/issues/348)).

Entries #337–#341 came from a fourth review, which targeted the causes of earlier regressions: one worker lifecycle module (#339) and property tests for eval and PCRE translation (#340).

- **`NOT IN` works in any casing again** ([#337](https://github.com/Bimmiest/propslab/issues/337)), fixing a regression from #332.
- **The Regex tab's "Add to props.conf" waits for a successful test and rejects unreadable class names** ([#338](https://github.com/Bimmiest/propslab/issues/338)), following the Create EXTRACT dialog's rule from #329.
- **A worker that throws while loading counts as a load failure everywhere, and the worker lifecycle exists once** ([#339](https://github.com/Bimmiest/propslab/issues/339)). Before, the first worker's load failure was misread as:
  - the pipeline's mount request having "crashed repeatedly";
  - a matcher timeout;
  - a hover fault, rebuilding the worker on every hover.

  Each worker now posts a ready signal, and `createManagedWorker` owns the lifecycle; see the Workers section of [docs/architecture.md](docs/architecture.md).
- **`"x" . .5` parses** ([#340](https://github.com/Bimmiest/propslab/issues/340)).

Entries #326–#335 came from a third review, which also went back over #324's fixes. Engine tests are doc-derived and say so, and the Splunk 10.4.0 fixtures still pass.

- **An input that crashes a worker is never run on the main thread** ([#326](https://github.com/Bimmiest/propslab/issues/326)), fixing a regression from #309; only load failures count toward the cap.
- **`INGEST_EVAL` can set index, host, source and sourcetype, and `:=` is an assignment** ([#327](https://github.com/Bimmiest/propslab/issues/327)). Metadata is rewritten as `DEST_KEY = MetaData:*` does.
- **The Timestamp and Effective config tabs agree with the pipeline** ([#328](https://github.com/Bimmiest/propslab/issues/328); [ADR 0010](docs/adr/0010-engine-decisions-are-structured-data-on-the-event.md)).
  - The Timestamp tab probes the text the extractor read (`timestampText`), not the final `_raw`.
  - An empty `TIME_PREFIX` is unset on both sides.
  - Both follow a sourcetype assigned by a `[source::]` or `[host::]` stanza.
- **The Create EXTRACT dialog enables Add only after the pattern has compiled and its capture has settled** ([#329](https://github.com/Bimmiest/propslab/issues/329)); stale Regex tab results show as "updating…".
- **An input-time sourcetype assignment no longer marks every event "Metadata Modified"** ([#330](https://github.com/Bimmiest/propslab/issues/330)), and clones get their own re-match warning ([ADR 0002](docs/adr/0002-input-time-sourcetype-and-rename.md)).
- **Line breaker fixes** ([#331](https://github.com/Bimmiest/propslab/issues/331)). An event's end line is its last character's, and `BREAK_ONLY_BEFORE_DATE` reads a `MAX_TIMESTAMP_LOOKAHEAD` of `0` or `-1` as no limit.
- **Eval supports `in()`, and fields named `like`, `xor`, `and`, `or` or `in` parse again** ([#332](https://github.com/Bimmiest/propslab/issues/332)).
- **Hovering a TIME_FORMAT can no longer freeze the tab** ([#334](https://github.com/Bimmiest/propslab/issues/334)). The sample runs in a worker behind a 1 s watchdog, so no user regex runs on the main thread.
- **Smaller fixes** ([#335](https://github.com/Bimmiest/propslab/issues/335)).
  - Clicking Run within the debounce no longer leaves a stale "unapplied changes" flag.
  - Regex reference rows stay table rows, with a real button.
  - The Fields and Raw toggles say what they toggle and carry `aria-expanded`.
  - The preview search filters 200 ms after typing stops.
  - Shared constants live in `hooks/workerLifecycle.ts`.
  - The MCP server rejects conf input over 2M characters and calls beyond a full queue.
  - The architecture doc lists the settings kept in localStorage.

Entries #309–#322 came from a second review. The engine tests are doc-derived and say so, and all Splunk 10.4.0 fixtures still pass. `BREAK_ONLY_BEFORE` anchoring ([#323](https://github.com/Bimmiest/propslab/issues/323)) was left for real Splunk output to settle.

- **A worker whose script fails to load is no longer recreated forever** ([#309](https://github.com/Bimmiest/propslab/issues/309)). After two load failures processing runs on the main thread; a mid-run crash restarts and replays once.
- **Assigning `sourcetype =` in a `[source::]` or `[host::]` stanza no longer triggers a `DEST_KEY` rewrite warning** ([#310](https://github.com/Bimmiest/propslab/issues/310)) or a per-event re-match ([ADR 0002](docs/adr/0002-input-time-sourcetype-and-rename.md)).
- **A `LINE_BREAKER` written in PCRE, such as `(?i)([\r\n]+)date`, is used as written** ([#311](https://github.com/Bimmiest/propslab/issues/311)); its groups are counted on the translated pattern.
- **Eval rejects characters it does not recognise, so `.5 * 2` is 1, not 10** ([#312](https://github.com/Bimmiest/propslab/issues/312)). `LIKE` and `XOR` are supported and `NOT NOT x` parses.
- **The Timestamp tab no longer highlights a timestamp the pipeline does not read** ([#313](https://github.com/Bimmiest/propslab/issues/313)); both share one matching function.
- **The Regex tab shows results as pending until matching catches up with the pattern** ([#315](https://github.com/Bimmiest/propslab/issues/315)).
- **Editing the metadata no longer marks every event "Metadata Modified", and typing no longer triggers heavy recomputation** ([#316](https://github.com/Bimmiest/propslab/issues/316)).
  - `ProcessingResult.inputMetadata` is the baseline each event is compared against.
  - The Timestamp tab uses the config of the run beside it.
  - Fields aggregates once per result, and its child counts are no longer O(n²).
- **A merged event's line range covers the blank lines and CRLF breaks it spans** ([#317](https://github.com/Bimmiest/propslab/issues/317); [ADR 0009](docs/adr/0009-truncate-caps-line-breaker-segments.md)).
- **Stanzas tied on kind, `priority` and specificity resolve in ASCII order** ([#318](https://github.com/Bimmiest/propslab/issues/318)), not file order.
- **`propslab-mcp` runs as a command and reports its package.json version** ([#319](https://github.com/Bimmiest/propslab/issues/319)), with an end-to-end SDK client test.
- **Accessibility** ([#320](https://github.com/Bimmiest/propslab/issues/320)).
  - Regex reference rows work from the keyboard.
  - Reference disclosures report `aria-expanded`.
  - The sorted Fields column reports `aria-sort`.
  - Phase filters report `aria-pressed`.
- **Out-of-date docs** ([#321](https://github.com/Bimmiest/propslab/issues/321)).
  - README: the Playwright pin, deploy trigger and tab list.
  - CONTRIBUTING: the MCP server install lint needs, and all three CI jobs.
  - SECURITY.md: covers the MCP server.
  - The command palette: gains the Effective config tab.
- **Smaller issues** ([#322](https://github.com/Bimmiest/propslab/issues/322)).
  - Timers and an interrupted column-resize drag are cleaned up on unmount.
  - A crash in timestamp matching shows its message instead of "timed out".
  - ESLint checks `scripts/` and treats the MCP server as Node code.
  - The structured-format `SHOULD_LINEMERGE` default lives only in the line breaker ([ADR 0008](docs/adr/0008-structured-formats-default-line-merging-off.md)).

Entries #280–#300, and follow-ups #303 and #304, came from one review of the whole project. Engine assertions are doc-derived and say so; all 92 Splunk 10.4.0 fixtures still pass.

- **A valid attribute in the wrong conf file gets one warning naming the right file** ([#278](https://github.com/Bimmiest/propslab/issues/278)), e.g. `STOP_PROCESSING_IF belongs in transforms.conf; in props.conf it has no effect.`
- **Smaller engine gaps** ([#303](https://github.com/Bimmiest/propslab/issues/303)). `\\` in a stanza pattern is one backslash, `like()` with a run of `%` works, and index-time `REPEAT_MATCH` with named groups collects every match.
- **A cancelled MCP request frees its worker slot** ([#304](https://github.com/Bimmiest/propslab/issues/304)), whether queued, running, or cut off by a disconnect.
- **The inline-fallback pipeline tests stopped timing the engine's first load.**
- **`KV_MODE = xml` extracted nothing in the app** ([#280](https://github.com/Bimmiest/propslab/issues/280)). XML is read by a reader inside the engine, and the engine and workers are type-checked without DOM globals.
- **`DEST_KEY = _MetaData:Index` takes the bare index name** ([#281](https://github.com/Bimmiest/propslab/issues/281)); the lint now warns about an `index::` prefix instead of requiring it.
- **`CLONE_SOURCETYPE` copies get their new sourcetype's `SEDCMD` and `TRANSFORMS`** ([#282](https://github.com/Bimmiest/propslab/issues/282)).
- **Line breaking** ([#283](https://github.com/Bimmiest/propslab/issues/283), [#287](https://github.com/Bimmiest/propslab/issues/287)). Zero-width breaks, lookbehind and mid-window dates work; `TRUNCATE` caps each segment ([ADR 0009](docs/adr/0009-truncate-caps-line-breaker-segments.md)).
- **Stanza patterns honour `|` and `( )`** ([#284](https://github.com/Bimmiest/propslab/issues/284)).
- **Regex transforms** ([#285](https://github.com/Bimmiest/propslab/issues/285), [#288](https://github.com/Bimmiest/propslab/issues/288)). Index-time REGEX runs once without `REPEAT_MATCH`, `MV_ADD` and `CLEAN_KEYS` apply consistently, and `REPORT` has no default `FORMAT`.
- **Timestamp settings that failed silently** ([#286](https://github.com/Bimmiest/propslab/issues/286)): `MAX_DIFF_SECS_AGO`/`HENCE` accept the majority format, a lookahead of `0` or `-1` means no limit, and an invalid `TIME_PREFIX` is reported.
- **Spurious "not valid JSON" warnings** ([#289](https://github.com/Bimmiest/propslab/issues/289)) for events such as `[INFO] started`.
- **PCRE translation** ([#290](https://github.com/Bimmiest/propslab/issues/290)). One class- and escape-aware scan applies `(?x)`, scopes a mid-pattern `(?i)`, and reports what it cannot translate.
- **Eval** ([#291](https://github.com/Bimmiest/propslab/issues/291)). `cidrmatch()` matches IPv4 and IPv6, and an uncompilable pattern in `replace()`, `match()` or `mvfind()` warns once.
- **The pipeline reference overclaimed** ([#292](https://github.com/Bimmiest/propslab/issues/292)), and `docs/architecture.md` listed a store field that does not exist.
- **The fidelity suite no longer depends on the wall clock** ([#293](https://github.com/Bimmiest/propslab/issues/293)). `PipelineOptions.now` fixes the clock for every stage.
- **Stale results and stale markers in the app** ([#294](https://github.com/Bimmiest/propslab/issues/294), [#295](https://github.com/Bimmiest/propslab/issues/295)). Late worker answers no longer overwrite cleared requests, lint markers refresh on load, and a failed run says so.
- **Trusted hover Markdown carried the user's text** ([#296](https://github.com/Bimmiest/propslab/issues/296)). Document text is escaped in every hover, and trust is narrowed to the dictionary command.
- **The TIME_FORMAT hover ran `TIME_PREFIX` unguarded on the main thread** ([#297](https://github.com/Bimmiest/propslab/issues/297)); it now uses the ReDoS guard, with a 4 KB sample cap.
- **Accessibility** ([#300](https://github.com/Bimmiest/propslab/issues/300)). A global `:focus-visible` outline, keyboard raw-text selection, keyboard-operable tree rows and resize handles, and a corrected `MultiSelect` (jsx-a11y lint: #302).

---

## 1.2.0 — 2026-09-19

### Fixed

- **`TZ_ALIAS` is simulated, and the `ignored` roster is empty** ([#227](https://github.com/Bimmiest/propslab/issues/227)). An event's zone abbreviation can be remapped to an offset, abbreviation or IANA name, and `TZ = GMT-5` resolves to UTC-5 ([ADR 0006](docs/adr/0006-time-zone-resolution.md)).
- **A scheduled check that every `ignored` roster entry names an open issue** ([.github/workflows/roster.yml](.github/workflows/roster.yml)). It runs weekly, outside the hermetic `npm test`, and fails on a closed issue or a PR link.
- **The `dompurify` override is raised past GHSA-55q2-fjhq-7xh7** to `^3.4.13` (introduced in [#18](https://github.com/Bimmiest/propslab/issues/18)); `npm audit` now reports zero vulnerabilities.

### Changed

- **`@types/node` follows `.nvmrc` in both trees, and Dependabot stops proposing its majors** ([#243](https://github.com/Bimmiest/propslab/pull/243), [#265](https://github.com/Bimmiest/propslab/pull/265)). Both trees are back on the Node 24 types; the pin moves together with `.nvmrc`.
- **Lockstep peers are grouped for major updates** ([#260](https://github.com/Bimmiest/propslab/pull/260), #215, #217). vitest with `@vitest/coverage-v8`, and vite with `@vitejs/plugin-react`, now arrive as one installable PR.
- **The fixture capture script and its guide are removed; the committed fixtures stay.** The Splunk General Terms do not permit the capture it described, so CONTRIBUTING makes "assert against the documentation and say so" the rule; the fixtures README records their provenance.
- **The Azure deploy action is excluded from Dependabot** ([#219](https://github.com/Bimmiest/propslab/pull/219)). Dependabot resolves `v1` to a frozen 2021 tag rather than the maintained branch the workflow pins.
- **Node moves from 22 to 24, the Active LTS line.** `.nvmrc`, both `engines` floors and the MCP server's build target move; the MCP server's V8 regex fallback flags still work on 24.
  - Re-check those experimental V8 flags on every Node major.
  - Node 26 is deferred until it is LTS; its `localStorage` global collides with jsdom in 14 tests.
- **Vite 7 → 8 and `@vitejs/plugin-react` 5 → 6, together** ([#215](https://github.com/Bimmiest/propslab/pull/215), [#217](https://github.com/Bimmiest/propslab/pull/217)). The Monaco split moves to Rolldown's `codeSplitting.groups`, and the app chunk shrinks from 647 to 469 kB.
- **`@types/diff` is removed** ([#216](https://github.com/Bimmiest/propslab/pull/216)); `diff` ships its own types.
- **The docs are restructured by audience.** Engine-library material moves to [docs/engine.md](docs/engine.md), internals to [docs/architecture.md](docs/architecture.md), and recipes to CONTRIBUTING; the fidelity sections are merged.

---

## 1.1.0 — 2026-08-01

### Fixed

- **`priority` was inverted, and could override precedence it cannot touch** ([#198](https://github.com/Bimmiest/propslab/issues/198)). Found by reading `props.conf.spec` after #186.
  - **Defaults.** Literal stanzas default to 100 and pattern stanzas to 0, whatever their kind.
  - **Scope.** `priority` orders stanzas within a kind, never across kinds.
  - Both rules are doc-derived; the README records the caveats.
- **Deploys were authenticating the wrong way.** The OIDC token step, permission and input are removed; the deployment token is the credential.
- **The deploy action was pinned to a 2021 build.** It is now pinned to the maintained `v1` branch head.

### Changed

- **The project is now called Propslab** (formerly "Splunk Toolkit"). The `localStorage` prefix is now `propslab:`; old keys are still read, so settings carry over.
- **The project's independence from Splunk is stated** in the README and the pipeline reference footer.

### Added

- **A `NOTICE` file** attributing the CIM data and the fidelity fixtures.

### Fixed

- **The stanza-level directives `disabled`, `priority`, `sourcetype` and `rename` are honoured** (#186). See [ADR 0002](docs/adr/0002-input-time-sourcetype-and-rename.md) for `sourcetype` and `rename`.
  - **`disabled`** removes a stanza from resolution; a later `disabled = 0` re-enables it.
  - **`priority`** orders stanzas, with Splunk's documented defaults when undeclared.
  - **`sourcetype`** in a `[source::…]` or `[host::…]` stanza assigns the sourcetype at input, and matching re-runs against it.
  - **`rename`** applies at search time only, taking search-time config from the target alone; both rewrites are reported.

### Changed

- **All four are reclassified from `ignored` to `simulated`**, 32 → 36; the README notes they are doc-derived.

---

## 1.0.0 — 2026-08-01

The first released version, with its support boundary stated plainly.

### What is guaranteed

- **32 directives are simulated** and asserted by tests; the classification is in [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts).
- **The fidelity corpus carries no known mismatch.** All 73 cases assert against output captured from **Splunk 10.4.0** (build `f798d4d49089`).
- **Everything outside the boundary says so where you are looking**: diagnostic, hover, autocomplete marker and dictionary callout.
- **977 tests**, with coverage floored in CI (65% overall; 88% statements and 96% functions for `src/engine/**`).

### The support boundary

- **25 directives are `documented`**: outside the simulation for a lasting reason (lookups, forwarder and input settings, match limits).
- **22 directives are `ignored`**, each naming its tracking issue: #85, #87, #183, #184, #185, #186, #190.
- **`INDEXED_EXTRACTIONS`** simulates every format, but the delimited-format overrides are ignored (#184).
- **Known divergences** are listed in the README.
- **Layered conf parsing (`default/` + `local/`) is engine API only**; UI support is #86 ([ADR 0012](docs/adr/0012-layered-conf-input.md)).

### Verifying a claim

Every fidelity case is reproducible:

```bash
npx vitest run src/engine/__tests__/splunkFidelity.test.ts -t "<case-id>"
```

At the time, re-capturing against another Splunk version was a documented manual step; that guide has since been removed (see 1.2.0).

---

## Pre-1.0 — 2026-08-01

### Added

- **A real version, shown in the status bar** (#156). It comes from `package.json` through a build-time define.
- **The editor flags two silent config mistakes.** A transforms setting inert in its stanza's phase (#177), and a value that is not the directive's documented type (#179), checked conservatively.
- **`MUST_NOT_BREAK_BEFORE`, `MUST_NOT_BREAK_AFTER` and `LINE_BREAKER_LOOKBEHIND` are in the registry** (#176). The first two were `ignored` and tracked in #190; `LINE_BREAKER_LOOKBEHIND` is `documented`.
- **Test coverage is measured and floored in CI** (#155), with a higher floor for the engine than for the app.
- **`CONTRIBUTING.md` and `SECURITY.md`** (#157).
- **The simulator declares what it simulates** (#153). Every directive is `simulated`, `documented` or `ignored`, and a non-simulated one is flagged in the editor, hover, autocomplete and dictionary.
- **Tests stop the declared boundary drifting from the code.** Every key must be classified with a reason or issue, and every `simulated` key must appear in a test.
- **Issues filed for the gaps the classification exposed**: #183, #184, #185 and #186.
- **An activity rail and a browsable dictionary of every directive**, built from the same registries as autocomplete and hover; on mobile it is a fifth tab.
- **Stanza header descriptions and the pipeline stage list are shared data** (`stanzaRegistry.ts`, `pipelineStages.ts`), with a test that they agree.
- **Three routes into the dictionary**: a hover link, `Ctrl/Cmd+K` → "Dictionary: KEY", and the pipeline reference's directive chips.

### Changed

- **The dictionary's detail pane is a two-column reference.**
- **The dictionary list can be dragged much narrower**, with badges hidden below 260px.
- **Directive hovers wait 800ms** instead of Monaco's 300ms.

### Fixed

- **`INDEXED_EXTRACTIONS = JSON` extracted nothing because line merging glued records together** (#164). `SHOULD_LINEMERGE` now defaults to false under `INDEXED_EXTRACTIONS`, clearing the last fidelity mismatch ([ADR 0008](docs/adr/0008-structured-formats-default-line-merging-off.md)).
- **`TZ` resolves IANA zone names instead of treating them as UTC** (#159), via `Intl.DateTimeFormat`, including DST edges ([ADR 0006](docs/adr/0006-time-zone-resolution.md)).
- **Automatic KV no longer truncates values containing `=`** (#170).
- **A repeated key in auto-KV keeps the first value** (#169), as the Splunk 10.4.0 capture shows.
- **Auto-KV no longer extracts purely numeric field names** (#166).
- **`case()` fires its `true()` fallback branch** (#165).
- **The eval dot operator propagates null for a missing field** (#168).
- **`TRUNCATE` marks the events it cuts** with `meta = truncated` (#167).
- **`SEDCMD` transliteration (`y///`) is implemented** (#160); sets of differing length are rejected with a diagnostic.
- **A `LINE_BREAKER` with no capturing group falls back to breaking on newlines, with a warning** (#172; [ADR 0007](docs/adr/0007-line-breaking-follows-recorded-splunk-behaviour.md)).
- **`MUST_BREAK_AFTER` as the only rule breaks every line** (#161; [ADR 0007](docs/adr/0007-line-breaking-follows-recorded-splunk-behaviour.md)).
- **`MAX_EVENTS` counts continuation lines**, so `MAX_EVENTS = 3` gives four-line events (#162).
- **An event with no parseable timestamp inherits the previous event's `_time`** (#163), and the trace says so.
- **`$0` in a field-pairs `FORMAT` creates no field** (#175).
- **`MV_ADD` is honoured in the search-time `FORMAT`-pairs path** (#174).
- **The fidelity suite runs under jsdom**, so `KV_MODE = xml` is actually exercised (#171).
- **`KV_MODE = xml` names fields by their dotted path from the root** (#171), e.g. `event.user`.
- **`KV_MODE = xml` has test coverage** in `kvModeXml.test.ts`.
- **Tinted badges render their fill**, using `color-mix`.
- **`DELIMS`, `FIELDS`, `MV_ADD`, `CLEAN_KEYS` and `KEEP_EMPTY_VALS` apply at search time only**, with a warning for `DELIMS` via `TRANSFORMS-`.
- **`CLEAN_KEYS` is implemented** (#173), pinned by the `report-delims-field-and-value` capture.
- **The editor's hover, autocomplete, folding, find and multi-cursor work** again after importing `editor.all`.
- **Resizable panels' `minSize` values are percentages**, not pixels.

---

## Pre-1.0 — 2026-07-30

### Fixed

- **`getDirectiveValue` returns the last definition of a key in a stanza, not the first**, matching `mergeDirectives` (relevant to layered confs, #115).
- **CIM model definitions are regenerated from Splunk's CIM 8.5.0 add-on** (#37). Hand-written field lists are replaced by ones derived from the model JSON, with a `CIM_VERSION` export and no enrichment fields.
- **`Endpoint` is five datasets, each with its own tag pair and fields**, instead of one with a non-existent `tag=endpoint` constraint.

### Added

- **`props.conf`/`transforms.conf` can be parsed as ordered layers** (#115). `default/` and `local/` merge per attribute, and every directive and diagnostic keeps its layer ([ADR 0012](docs/adr/0012-layered-conf-input.md)).
- **`scripts/generate-cim-models.js`** regenerates the CIM data from an extracted add-on.
- **Eleven more CIM datasets** (27 in total); models with no key fields score `n/a` instead of 100%.

---

## Pre-1.0 — 2026-07-28

### Added

- **Index-time rewrites of `_raw` report the fields they devalued or destroyed.** `SEDCMD` and `DEST_KEY = _raw` steps fill `fieldsModified` and `fieldsRemoved`, shown as chips in the Transforms tab and a `masked` badge in Fields ([ADR 0011](docs/adr/0011-raw-rewrites-attributed-by-replay.md)).

### Fixed

- **`SEDCMD` trace snapshots show the region that changed**, with 80 characters of context and `…` elision, instead of a fixed 200-character prefix.
- **A `DEST_KEY = _raw` transform records before and after text** and field attribution, like `SEDCMD`.

---

## Pre-1.0 — 2026-07-04

### Fixed

- **`TIME_FORMAT` is anchored right after `TIME_PREFIX`** instead of matching anywhere in the lookahead window.
- **Duplicate stanzas and repeated transform keys resolve last-wins**, as in Splunk.
- **Index-time `FORMAT` follows transforms.conf.spec**: `_KEY_<n>`/`_VAL_<n>` groups, a default `<stanza>::$1`, and `$0` as the prior `DEST_KEY` value.
- **`TRUNCATE` applies per line, before merging, and cuts on a UTF-8 boundary** ([ADR 0009](docs/adr/0009-truncate-caps-line-breaker-segments.md)).
- **`KV_MODE=multi` tokenises rows by whitespace**, falling back to header offsets only when the token count differs.
- **Field names that collide with `Object.prototype` members are kept intact**, via a shared prototype-safe field writer.
- **Five TIME_FORMAT gaps are closed**: `%:z`, `%::z`, `%N`, the `%Q` family, `%s%3N`, unpadded numeric fields, the POSIX `%y` pivot, and `%%`-aware composites.

---

## Pre-1.0 — 2026-07-01

### Changed

- **The Regex tab matches in a terminatable Web Worker with a 2 s watchdog**, so a runaway pattern no longer freezes the tab.

### Fixed

- **The ReDoS heuristic catches more catastrophic patterns** (`(.*,){20}`, `a*a*`), and the Regex tab translates patterns once.

- **Automatic timestamp recognition prefers the earliest match**, then the more specific format.
- **Out-of-range timestamp fields fail to parse** instead of rolling over.
- **An unresolvable timezone warns** instead of silently becoming UTC.

- **"Create EXTRACT from selection" anchors on the occurrence you selected.**
- **"Create EXTRACT from selection" sanitises field names** into valid capture-group names and says when it did.

- **Monaco diagnostics no longer skip the line after a backslash-terminated header or garbage line.**
- **Field highlights no longer land inside the key or inside a larger number.**
- **Stanza specificity counts literal dots.**
- **`TRUNCATE` rejects malformed values** such as `0x10` or `1e3`, with a warning.
- **The scaffold's `TRUNCATE` suggestion is never below the longest event.**
- **`copyToClipboard` reports failure when the fallback copy fails.**

- **The eval parser rejects trailing tokens and lexes `expr - n` correctly.**
- **eval propagates NULL for non-numeric operands** instead of coercing to `0`.

- **KV `auto` no longer extracts fields from inside quoted values.**
- **`FORMAT` `$N` falls back like PCRE**, so `$10` with one group is group 1 then `0`.
- **`INGEST_EVAL` handles an escaped backslash before a closing quote.**
- **`DEST_KEY` routing applies an empty `FORMAT` result.**
- **`SEDCMD` unescapes the replacement like GNU sed.**
- **eval `mvzip` stops at the shorter field.**
- **eval `mvcount` returns NULL for a field with no values.**

### Added

- **eval `isbool()` and `isstr()`.**

---

## Pre-1.0 — 2026-05-31

### Added

- **Mobile layout.** Below 768px one panel shows at a time, switched by a segmented control.

### Fixed

- **The Raw Log editor uses the app's theme on first load**, via a shared `ensureSplunkMonaco` helper.
- **The first-run banner's dismiss button aligns** on narrow screens.
- **The output tab bar scrolls** instead of clipping on small screens.
- **The header collapses the "Commands" label** on narrow screens.

---

## Pre-1.0 — 2026-04-21

### Fixed

- **Collapsed editor headers match the expanded style.**
- **Azure SWA workflow: `actions/checkout` bumped to `@v4`.**
- **Azure SWA workflow: `actions/github-script` bumped to `@v7`.**
- **Azure SWA workflow: indentation normalised.**
- **Azure SWA workflow: `close_pull_request_job` removed**; PR preview environments are disabled.

---

## Pre-1.0 — 2026-04-21

### Added

- **React component smoke tests** with `@testing-library/react` and jsdom (112 tests in total).
- **`SplunkEvent.fieldOffsets`**: authoritative `[start, end]` ranges in `_raw` for each extracted field.
- **`fieldExtractor` records offsets** for EXTRACTs against `_raw`, one per multivalue occurrence.

### Fixed

- **The Extractions tab highlights regex-extracted values at the right occurrence**, using `fieldOffsets`.
- **Hard-coded hex colours are replaced with CSS tokens** in nine components.
- **A stale fieldHighlight test is updated.**

### Changed

- **`FIELD_COLORS` is defined once**, in `shared/fieldColors.ts`.
- **Monaco editor instances moved out of Zustand**, into `editorRegistry.ts`.
- **`window.monaco` is typed**, removing unsafe casts.
- **`buildContextPatterns` is memoised.**
- **The CIM compliance check is a single pass per field list.**
- **`eventBadgeCounts` is memoised** in `HighlightedTab`.
- **`normalise` is hoisted** to module scope in `PreviewPanel.tsx`.

---

## Pre-1.0 — 2026-04-20

### Added

- **A CI test gate** blocks the deploy when lint, type-check or tests fail.
- **A "Per-event pipeline" chip in the status bar** opens Settings.
- **A Phase column and filter in the Fields tab.**

### Fixed

- **`MAX_TIMESTAMP_LOOKAHEAD` defaults to `150`**, as documented.
- **The Regex tab shows only matching events again.**
- **Long diagnostic messages wrap** instead of clipping.
- **Extractions-tab fallback highlighting marks only the first hit.**

### Changed

- **The Fields sidebar drops its processor-name hover**; the badges are the single source.
- **Known limitations list the delimited `INDEXED_EXTRACTIONS` overrides** as not honoured.

---

## Pre-1.0 — 2026-04-19

### Added

- **A status bar** with worker status, timing, event and field counts, and diagnostics.
- **A command palette** (Ctrl/Cmd+K).
- **The Raw Log editor uses Monaco** in plain-text mode.
- **A pipeline reference panel** listing the 11 stages.
- **A first-run banner**, dismissed to `localStorage`.
- **A collapsible metadata strip** on Raw tab event cards.
- **A pill variant for sub-tabs.**
- **Expand/collapse for long event cards** in the Raw tab.
- **Truncated events are marked** in the trace and with a badge.
- **`SplunkEvent.fieldSourceKeys`** maps a stripped JSON field name to its original key.

### Fixed

- **Underscore-stripped JSON fields no longer steal each other's highlight**, and one-character values highlight.
- **Index-time extraction strips leading underscores** from field names, as Splunk does ([#1](https://github.com/Bimmiest/propslab/issues/1), [0a87733](https://github.com/Bimmiest/propslab/commit/0a87733ac322f7564d3dbaf29bf82d3f005d3b01)).
- **The Diff tab ignores line-ending and trailing-whitespace differences.**
- **EVAL-calculated fields take precedence over EXTRACT in field colouring**, and empty or null results are hidden.
- **A "Clear" link releases stuck pins.**
- **The preview filter bar drops its duplicate event count.**

### Changed

- **The Calc Fields sub-tab is merged into Extractions.**
- **Shared preview-tab components move to `tabs/shared/`**, removing about 350 duplicated lines.
- **Fields sidebar state moves into `HighlightedTab`.**
- **Sub-tabs are ordered Raw → Timestamp → Extractions → Diff → Regex.**
- **The favicon accent is corrected** to `#6366f1`.

---

## Pre-1.0 — 2026-04-18

### Added

- **Design system colour tokens**: zinc canvas, elevated surfaces, indigo accent.
- **Monaco themes follow the new palette**, at 14px.
- **IDE-style pane header typography.**
- **MetadataPanel is redesigned** with per-field info tooltips.
- **Radix tooltips replace `title=` attributes.**
- **A polished empty state** in the preview.
- **An empty-state overlay** in the Raw panel.
- **New icons**: terminal, shield, clipboard, info.
- **Info icons on TransformsTab section headers.**
- **Completion docs render examples as code blocks.**

### Fixed

- **Multiple spaces after `=` no longer flip boolean directives.**
- **`EXTRACT-*` splits at the right `in` keyword.**
- **Quoted `FORMAT` values (`field::"a b"`) parse.**
- **`flattenJson` guards against prototype pollution.**

### Changed

- **`pipeline.ts` uses `mergeDirectives()` output directly.**
- **`breakLines` compiles `LINE_BREAKER` once.**
- **`expandFormat` reuses one named-reference regex.**
- **`KV_MODE=json` tries up to five `{` positions** before giving up.
- **Internal dividers are softened**, and TransformsTab cards elevated.

---

## Pre-1.0 — 2026-04-17

### Fixed

- **EVAL `IN` / `NOT IN` works**, as used in Splunkbase TAs.
- **EVAL accepts a single `=` as equality.**
- **`INGEST_EVAL` splits assignments on top-level commas.**
- **`EXTRACT-*` produces multivalue fields** for repeated matches.
- **`tonumber()` rejects partial numbers.**
- **A restarted worker re-posts its in-flight request.**

### Changed

- **The stanza loop in `pipeline.ts` is a single pass.**
- **Transform stanza lookup uses a `Map`.**
