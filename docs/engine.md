# Using the engine as a library

`src/engine/**` is pure logic with no React imports and no runtime dependencies, and it runs unchanged in the browser, in a Web Worker, and under Node. `runPipeline` is the entry point:

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

## Running the engine under Node

**Set `captureOffsets: false` if you are not rendering highlights.** It is not a micro-optimisation. V8 can abandon backtracking mid-match and finish on its linear-time engine:

```
node --enable-experimental-regexp-engine-on-excessive-backtracks \
     --regexp-backtracks-before-fallback=1000 your-script.mjs
```

but **that engine cannot compile a regex carrying `d`, `i` or `u`**. `captureOffsets` is what decides whether every `EXTRACT` gets `d`. Measured on `^(a|a)*(?<f>b)$` against 30 characters, with those flags set:

| | elapsed |
|---|---|
| compiled bare | 8.3 ms |
| compiled with `d` | 91,696 ms |

The flags must be set **before the first regex they protect is compiled** — in ESM, before the first import of the entry point.

**This narrows the unbounded surface; it does not remove it.** A pattern still declines the fallback if it uses a lookahead or a backreference, and both are ordinary in Splunk regexes — the `rfc5424` pattern in this repo's own sample data uses `(?=\s|$)`. The `safeRegex` ReDoS heuristic is likewise structural and documents what it cannot see, notably alternation-overlap forms like `(a|aa)+`.

**So a consumer that executes patterns it did not write needs a thread it can terminate**, with a wall-clock budget — which is what the browser app does, and what the flags are not a substitute for. Treat the flags as a second layer that lowers how often the watchdog fires.

[`packages/mcp-server`](../packages/mcp-server) is the Node consumer this section describes: every engine run it performs happens in a `worker_threads` worker under a wall-clock budget with hard termination, `captureOffsets` defaults to `false`, and its launcher re-execs node with the flags above before the first engine import.
