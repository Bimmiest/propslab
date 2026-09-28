# Using the engine as a library

`src/engine/**` is pure logic with no React imports, and it runs unchanged in the browser, in a Web Worker, and under Node. Its one runtime dependency is the PCRE2 WebAssembly module every user pattern runs on ([below](#the-regex-engine)), which has to be initialised once before the first run. `runPipeline` is the entry point:

```ts
runPipeline(rawData, metadata, propsConfInput, transformsConfInput, options?)
```

`options` is `PipelineOptions`:

| Option | Default | What it does |
|---|---|---|
| `perEventPipeline` | — | Resolve stanzas per event rather than once for the batch, so metadata rewritten mid-pipeline takes effect downstream. |
| `captureOffsets` | `true` | Record capture spans for positional EXTRACTs into `fieldOffsets`. |
| `now` | `Date.now()` | The current time, in epoch milliseconds, for everything Splunk measures against the clock: the `MAX_DAYS_AGO` / `MAX_DAYS_HENCE` timestamp bounds, the year given to a yearless `TIME_FORMAT`, the index-time `_time` an event with no usable timestamp falls back to, and eval's `now()` / `time()` (in `EVAL-` and `INGEST_EVAL`). |

**Pass `now` when replaying recorded data.** A sample captured today carries absolute timestamps; replayed against the real clock years later, `MAX_DAYS_AGO` (2000 days by default) starts rejecting them and the output changes for no reason but the date. Pinning `now` to the moment of capture keeps the verdict fixed — the fidelity suite passes each fixture's `capturedAt` for exactly this reason.

## Conf layers (`default/` vs `local/`)

> **Engine API only.** The hosted app's editors hold a single flat props.conf and
> a single flat transforms.conf, and no control splits them into layers — nothing
> in this section is reachable from the browser UI. Surfacing it there is tracked
> in [#132](https://github.com/Bimmiest/propslab/issues/132) and would arrive
> alongside [#86](https://github.com/Bimmiest/propslab/issues/86).

`parseConf`, and therefore `runPipeline`, accept either the text of one flat conf or an ordered list of layers, **lowest precedence first** — which is how a caller reading an app off disk (or out of a Git worktree) hands over `$APP/default/props.conf` and `$APP/local/props.conf`:

```ts
runPipeline(raw, metadata,
  [{ layer: 'default', text: defaultProps }, { layer: 'local', text: localProps }],
  [{ layer: 'default', text: defaultTransforms }, { layer: 'local', text: localTransforms }]);
```

`layer` is a free-form label the engine only carries through as provenance (`app/local`, `system/local`, … are all fine); precedence comes from list order, since only the caller knows how its layers rank. Merging is per *attribute* within a stanza, not per file: a `local` stanza replaces only the attributes it names and the rest of the `default` stanza survives. That falls straight out of concatenating the layers in precedence order, because a repeated key in a stanza already resolves last-definition-wins.

What layered input adds to the result is provenance that parsing would otherwise destroy:

- every `ConfDirective` carries the `layer` it was read from — including the ones `mergeDirectives` returns, so "which file won this attribute" is answerable after resolution;
- the winner of a contested key carries `overrides` (nearest first, so `overrides[0]` is the value that would apply if that line were deleted) and each loser carries `overriddenBy`;
- every `ConfStanza` carries `layers` (all files defining it, lowest first) with `layer`/`lineRange` naming the highest-precedence one;
- every diagnostic derived from a directive or stanza carries `layer` alongside `line`, since both files have a line 7.

Passing a plain string produces exactly what it always did, with no provenance fields; passing one layer makes the merge a no-op. Together with stanza precedence (see the README), these are the two halves of what `btool … --debug` prints: which stanza won, and from which file.

This is within-stanza only — a directive that wins its stanza can still lose to a higher-precedence *stanza*, which `matchStanzas`/`mergeDirectives` resolve separately.

## The regex engine

Every pattern a user writes — `LINE_BREAKER`, `BREAK_ONLY_BEFORE`, `MUST_BREAK_AFTER`, `TIME_PREFIX`, `EXTRACT`, transforms `REGEX`, `SEDCMD`, `FIELD_HEADER_REGEX` and the other `INDEXED_EXTRACTIONS` patterns, eval's `match()`, `replace()`, `like()` and `mvfind()` — runs on **PCRE2 compiled to WebAssembly**, through `src/utils/splunkRegex.ts`. Splunk's regexes are PCRE, so this is the engine Splunk runs rather than a translation of it into JavaScript, and the pipeline, the editor's diagnostics, the Regex and Timestamp tabs and the MCP server all compile through that one module, so they cannot disagree about what a pattern means. The engine's own internal patterns (wildcard stanza matching, strftime formats, date recognition) stay JavaScript regexes.

The WebAssembly module is [`packages/pcre2-wasm`](../packages/pcre2-wasm): PCRE2 10.48, the 16-bit library in UTF mode, built reproducibly from the pinned release by its `build/build.sh` with plain clang and `wasm-ld`. Its offsets are UTF-16 code units, so they are JS string indices with nothing to transcode. See its README for the API and build.

### Initialising it

The engine API is synchronous, but a WebAssembly module has to be compiled before first use. Do it once, before the first pattern compiles:

```ts
import { initRegexEngine, initRegexEngineSync } from './src/utils/splunkRegex';

// Node, or a worker: synchronous is fine.
initRegexEngineSync(readFileSync('packages/pcre2-wasm/pcre2.wasm'));

// A browser's main thread: asynchronous.
await initRegexEngine(WebAssembly.compileStreaming(fetch(wasmUrl)));
```

Compiling a pattern before then throws. `runPipeline` itself stays synchronous.

The browser app loads the module on the page before its first render, and each worker loads its own from the same fixed, same-origin asset URL before it signals ready (see [architecture.md](architecture.md#workers)). A worker never takes the module from a message: that would let message data choose the code it compiles, for a saving of a few milliseconds. The MCP server compiles it once per process and passes it to each sandbox worker it spawns. Compilation is not charged to a request's watchdog on the server, and in the browser it is part of a worker's load, which the lifecycle already allows for. Measured cold: compiling takes 2–7 ms in headless Chromium and about 1 ms in Node, because V8 compiles WebAssembly lazily with its baseline compiler; forcing the optimising compiler up front for the whole module (`--no-liftoff --no-wasm-lazy-compilation`) takes 380–470 ms in Chromium and about 200 ms in Node. The page's fetch, compile and instantiate together measured 76 ms in the end-to-end suite, which holds it to a 2 s budget.

A browser needs `'wasm-unsafe-eval'` in the Content-Security-Policy's `script-src`, which permits compiling WebAssembly and nothing else.

### Semantics

What PCRE does, not what a JavaScript regex does — the differences that used to be translated or approximated are now simply PCRE's:

- `$` also matches before a final newline; `\z` is the very end, `\Z` the end or before a final newline; `\A` is the start even under `(?m)`.
- Newlines are LF: `.` matches `\r`.
- Possessive quantifiers, atomic groups, recursion, conditionals, `\K`, `\G`, `\Q…\E`, POSIX classes, `\h`/`\v`/`\R`, Unicode properties (`\p{…}`), and inline options anywhere in a pattern, scoped to their group.
- Patterns are compiled in UTF mode without UCP: `.` is one character (an astral one included), while `\w`, `\d`, `\b` and POSIX classes are ASCII, as in Splunk; `(*UCP)` opts in to Unicode classes. A lone surrogate in a subject matches as U+FFFD.
- Global iteration (`REPEAT_MATCH`, search-time `REPORT`, `SEDCMD …/g`, eval `replace()`) follows PCRE2's rule: after an empty match, the next attempt is at the same place with an empty match forbidden, as in Perl, rather than JavaScript's step forward by one code unit.
- A capture group inside a repeated group keeps its value from the last iteration that set it.

Replacement syntax is not PCRE2's. Splunk does not expose `pcre2_substitute`, so `SEDCMD` (sed's `\1` and `&`), transforms `FORMAT` (`$1`, `$0`) and eval `replace()` (`\1`) each expand their own template from the match's groups.

### MATCH_LIMIT and DEPTH_LIMIT

`EXTRACT` runs under its props.conf stanza's `MATCH_LIMIT` and `DEPTH_LIMIT`, `REPORT` and `TRANSFORMS` under the transform stanza's own; unset, they are Splunk's defaults of 100000 and 1000, and 0 means no limit. A match that reaches either is no match, as in Splunk, and the preview says which limit stopped it. Patterns outside field extraction run under PCRE2's own defaults (ten million each), and backtracking memory is capped at 64 MiB per match.

Two caveats, both from running PCRE2 rather than the PCRE1 the limits were named for:

- **The count is the interpreter's.** WebAssembly has no JIT, so every match runs `pcre2_match`'s interpreter, and `MATCH_LIMIT` counts what it counts. Under PCRE2's JIT the same limit counts differently; this models the interpreter.
- **`DEPTH_LIMIT` is approximate.** PCRE1's `match_limit_recursion` counted recursion on the C stack; PCRE2 counts nested backtracking frames on the heap. The same `DEPTH_LIMIT` stops a given pattern at a different depth.

### Known differences from Splunk's PCRE

Splunk documents its regexes as PCRE. Where PCRE2 and PCRE1 differ, this simulator does what PCRE2 10.48 does, and does not emulate PCRE1:

- `\K` inside a lookaround is a compile error in PCRE2 (10.38 and later); PCRE1 accepted it.
- PCRE2 accepts variable-length lookbehind (every branch bounded, up to 255 characters); PCRE1 required each branch to be fixed-length. A pattern using it compiles here and may not in Splunk.
- Error messages are PCRE2's wording.
- The limits count differently, as above.

Treat the pattern language as the common PCRE1/PCRE2 subset, and verify anything that relies on newer syntax against a real indexer.

### Bounding the work

PCRE2's limits bound each match. They do not bound a run: many events, several patterns each, every match within its limits, can still add up to seconds, and a stanza may set `MATCH_LIMIT = 0`. **So a consumer that executes patterns it did not write still needs a thread it can terminate**, with a wall-clock budget — which is what the browser app does (the pipeline, the Regex and Timestamp tabs and the `TIME_FORMAT` hover all run in watchdog-guarded workers) and what the MCP server does. The structural ReDoS heuristic that used to refuse patterns before compiling them no longer gates anything: refusing a valid pattern is not what Splunk does, and the limits stop the runaway cases it was guarding against. It survives as an advisory ranking in the MCP server's timeout report (`src/utils/redosHeuristic.ts`).

Measured on a 20,000-event synthetic key-value input (EXTRACT ×2, a `REPORT` with `MV_ADD`, `SEDCMD`, `TIME_PREFIX`) in Node, the pipeline took 2.3 s on PCRE2 against 1.7 s on V8's irregexp; on the two bundled examples scaled to the 1 MB input cap, 0–25% slower. A typical `EXTRACT` costs about 1.8 µs per event against irregexp's 1.4 µs. In the browser, the end-to-end suite's 20,000-event paste (`e2e/perf.spec.ts`) ran its pipeline in about 2.7 s against 2.5 s before, on the same machine.

Automatic timestamp recognition's format table (`timestampRecognizer.ts`) stays on JavaScript regexes: those patterns are generated from strftime formats, not written by a user, and run on every line.

## Running the engine under Node

`captureOffsets: false` skips recording the capture spans the highlighter reads; set it if you are not rendering highlights. It no longer changes which regex engine a pattern runs on.

The V8 flags `--enable-experimental-regexp-engine-on-excessive-backtracks --regexp-backtracks-before-fallback=1000` now protect only the engine's own JavaScript regexes, which are built from fixed shapes; user patterns do not run on V8's regex engine at all.

[`packages/mcp-server`](../packages/mcp-server) is the Node consumer this section describes: every engine run it performs happens in a `worker_threads` worker under a wall-clock budget with hard termination, with the regex engine compiled once by the server and handed to each worker.
