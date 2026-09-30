# propslab-mcp

An [MCP](https://modelcontextprotocol.io) server over the propslab simulation
engine (`src/engine/**`), so an LLM agent can *simulate* a Splunk config
against real sample data instead of guessing about it — draft a props.conf,
run it, read the per-event `processingTrace`, and fix its own mistake.
Implements [#202](https://github.com/Bimmiest/propslab/issues/202).

## Tools

| Tool | Wraps | Returns |
|---|---|---|
| `simulate` | `runPipeline` | Per-event `_time`, `fields`, indexed fields, and a `processingTrace` naming every processor that touched the event, plus diagnostics |
| `validate` | `parseConf` + `lintConfigs` (the pipeline's config-level lint) + a compile of every stanza's regexes | `ValidationDiagnostic[]` for conf text alone — no sample needed |
| `explain_precedence` | layered `parseConf` + `resolveStanzasForEvent` + `mergeDirectives` | btool-style provenance: which layer won each attribute (`overrides` / `overriddenBy` / `layers`), and the effective directive set for a sourcetype |
| `lookup_directive` | `directiveRegistry` | Curated directive documentation, including the simulation-support level, so an agent cites the registry instead of recalling spec |

Every tool declares an `outputSchema` and returns its result twice: as
`structuredContent` matching that schema, for clients that read it, and as
the same JSON, compact, in a text block, for those that do not. The
schemas, in `src/outputSchemas.ts`:

| Tool | `structuredContent` |
|---|---|
| `simulate` | `{ eventCount, returnedEvents, truncationNote?, events[], processingSteps[], diagnostics[], diagnosticCount? }`; each event is `{ _raw, _time (ISO-8601 or null), metadata, fields, indexedFields, lineNumbers, processingTrace[] }` |
| `validate` | `{ diagnostics[], diagnosticCount?, truncationNote? }` |
| `explain_precedence` | `{ parseErrors[], stanzas[], parseErrorCount?, stanzaCount?, truncationNote?, resolution? }`; each stanza may carry `directiveCount`; `resolution` (props.conf with a `sourcetype`) is `{ metadata, effectiveMetadata, assignedSourcetype?, matchedStanzas[], effectiveDirectives[], matchedStanzaCount?, effectiveDirectiveCount? }` |
| `lookup_directive` | Without `key`: `{ "props.conf"?: [...], "transforms.conf"?: [...] }`, one summary per directive. With `key`: `{ matches[], classBased? }` |

Objects the engine or registry defines — diagnostics, trace steps, directive
entries — are open schemas (further properties allowed), so a new engine
field does not fail validation; the envelopes are closed. An error result
(`isError: true`: `timeout`, `input_too_large`, `unknown_directive`, …)
carries its JSON in the text block only, with no `structuredContent`: the
output schema describes successes, and the SDK client validates
`structuredContent` whenever it is present. The response size cap (below)
counts both copies.

All four tools are annotated `readOnlyHint: true`, `destructiveHint: false`,
`idempotentHint: true`, `openWorldHint: false`: they read only their input
and the static registry, reach nothing outside the process, and answer the
same input the same way, so a client need not ask before running one.

`simulate`, `validate` and `explain_precedence` accept conf input as either
one flat string or an ordered list of layers, lowest precedence first — an
agent pointed at a real app directory hands over `default/` + `local/` and
gets btool-style provenance back.

## Setup

The server bundles the engine from the app's `src/`. The engine's one
dependency, its regex engine `pcre2-wasm-utf16`, is declared by this package
too, at the same release as the app's, and the build resolves the engine's
import to this package's copy — so the package installs on its own:

```bash
# from the repository root
cd packages/mcp-server
npm install
npm run build
```

Then register the server with your MCP client. Claude Code:

```bash
claude mcp add propslab -- node /path/to/propslab/packages/mcp-server/dist/index.js
```

Or in any client's JSON config:

```json
{
  "mcpServers": {
    "propslab": {
      "command": "node",
      "args": ["/path/to/propslab/packages/mcp-server/dist/index.js"]
    }
  }
}
```

`dist/index.js` starts with a `#!/usr/bin/env node` shebang (#319), so the
package's `propslab-mcp` bin also runs directly — e.g. after `npm link` here,
`claude mcp add propslab -- propslab-mcp`. Only the launcher carries it; the
worker bundle is loaded by `new Worker`, never executed as a command. The
launcher still re-execs node with the regex-fallback flags either way.

## Security model

The server executes regexes the agent wrote and the user may not have
reviewed. `docs/engine.md`'s closing section is the spec this implements:

- **Every engine run happens in a worker thread with a wall-clock budget**
  (default 5s, `timeout_ms` per call) and hard `worker.terminate()` on
  expiry. This is the mechanism; nothing else is.
- **Patterns run on PCRE2 in WebAssembly**, as they do in the app: the
  server compiles the module once and hands it to each worker with its
  request, so no request's budget pays for compilation. `MATCH_LIMIT` and
  `DEPTH_LIMIT` stop a runaway field-extraction match, as in Splunk; the
  watchdog bounds the run as a whole.
- **`captureOffsets` defaults to `false`** — nothing here renders highlights.
- **The launcher re-execs node with
  `--enable-experimental-regexp-engine-on-excessive-backtracks`** (plus a
  backtrack threshold) before anything compiles a regex. User patterns no
  longer run on V8's regex engine, so this now covers only the engine's own
  JavaScript regexes. `PROPSLAB_MCP_NO_REEXEC=1` opts out.
- **The server runs under Node's permission model**: the launcher re-execs
  node with `--permission --allow-worker --allow-fs-read=<dist/>`, and with
  `dist/` as the working directory. The server and its workers can read their
  own bundle and `pcre2.wasm` and nothing else, and cannot write files, start
  processes or load native addons. The working directory matters because a
  worker thread can read below it whatever `--allow-fs-read` says (measured
  on Node 22 and 24). `PROPSLAB_MCP_NO_REEXEC=1` turns this off along with
  the rest of the re-exec.
- **A timeout comes back structured**: budget, every regex-valued directive
  in the conf (file / stanza / key / line / layer), and which of them a
  structural ReDoS heuristic flags — so the agent can repair the pattern rather
  than retry blind. The heuristic is advisory and cannot see every form
  (e.g. `(a|aa)+`), and the error text says so. The list is built inside
  the worker, which posts it before the pipeline runs; the server never
  parses the caller's conf on its own thread, so a timeout cannot stall it
  (#468). A run that times out before posting the list, and a validate or
  explain run, which execute no directive's regex, report none.
- **Each worker has a heap limit** (V8 `resourceLimits`: 512 MB old
  generation, 64 MB young). A run that exceeds it kills only its own worker
  and comes back as `{"error": "out_of_memory", "heap_limit_mb": …}` with
  guidance to shrink the input, instead of growing until the whole server
  dies. The worst sample the schemas accept is 1 MB of one-character lines
  with `SHOULD_LINEMERGE = false`: 500,000 events, each with its own trace.
  While the worker posted the whole result for the server to trim, that ran
  out of 512 MB somewhere between 400k and 500k events; now that the worker
  trims it before posting (next bullet), 500k events were measured to
  complete within 512 MB — and within 256 MB. The limit covers the conf
  side too, which is why it has a combined bound:
  per field the schemas admit 20 layers of 1M characters, but
  `props_conf` and `transforms_conf` together may carry at most 2M
  characters across all their layers. More comes back as
  `{"error": "input_too_large", "conf_chars": …, "max_conf_chars": …}`
  before any worker starts. Measured: a 1 MB sample of one-character lines
  (500k events) beside 1.9M characters of conf (33,000 stanzas), with an
  EXTRACT, SEDCMD, FIELDALIAS and EVAL applying to every event and
  `include_snapshots` on, completes within 512 MB — in about 12 s, so it
  needs a `timeout_ms` above the 5 s default.
  Process-wide V8 heap flags override worker limits, so the launcher strips
  `--max-old-space-size` / `--max-semi-space-size` / `--max-heap-size` from
  its own arguments and from `NODE_OPTIONS` before re-exec'ing, and says so
  on stderr. It re-execs to do so even when the regex flags above are
  already on its command line. With `PROPSLAB_MCP_NO_REEXEC=1` nothing is
  stripped, and the launcher warns on stderr that the flags are in effect.
- **Every response is bounded** (#351, #414), at 8 MiB
  (`MAX_RESPONSE_BYTES`, `src/responseBudget.ts`) counted as UTF-8 bytes of
  the whole JSON-RPC line the server writes: both copies of the payload,
  the text copy's second round of escaping, and the envelope. A cap in
  characters of one copy let a response run to five times its nominal size
  on non-ASCII or quote-heavy output; 8 MiB stays below the 10 MiB at which
  the SDK's client drops a line. The worker shapes each response itself and
  posts only that, so a full result never reaches the server's own thread,
  where no heap limit applies. What does not fit is cut, with the list's
  total in a `…Count` field and a `truncationNote` saying which cut applied:
  - `simulate`: `max_events` bounds `events` and `processingSteps` alike
    (the latter covers the returned events only); events that would not fit
    are left out, and diagnostics may take at most half the budget.
  - `validate`: `diagnostics` (`diagnosticCount`).
  - `explain_precedence`: parse errors take at most a quarter of the budget,
    the resolution's `matchedStanzas` and `effectiveDirectives` at most a
    quarter and a half of what is left, and stanzas the rest; the last
    stanza may be cut part-way, with its `directiveCount`.
  - a `timeout` error: `regex_directives`, flagged patterns first
    (`regex_directive_count`, `truncation_note`).

  Should anything still come out over the cap, it is replaced by a
  `{"error": "response_too_large"}` error rather than written. And a failed
  write to stdout — the client gone, or the pipe refusing more — is logged
  to stderr and the server exits (0 for `EPIPE`, 1 otherwise) instead of
  dying on an unhandled `error` event.
- **At most `min(4, os.availableParallelism())` workers run at once**; further
  calls queue first come, first served. The `timeout_ms` budget starts when a
  call's worker starts, not when it is queued: a timeout is reported as "your
  regex backtracked", and time spent waiting behind other calls says nothing
  about this call's patterns. The trade-off is that a queued call can take
  its wait plus its budget end to end; each call ahead of it holds a slot for
  at most its own budget (30 s at the most), and the MCP client's request
  timeout stays the outer limit. A slot is freed when its worker has actually
  exited, so a terminated run still counts against the cap until it stops.
- **The queue is bounded too**, at four waiting calls per slot (16 at most).
  A queued call holds its whole input in the server's own heap, outside
  any worker's limit, so an unbounded queue only moved a burst from the
  workers onto the main thread — and the next bullet bounds each call's
  input, so the queue's total is bounded as well. A call that arrives with
  the queue full is refused at once with `{"error": "busy",
  "max_concurrent": …, "max_queued": …}`. Nothing is wrong with its input; retry once calls in
  flight finish. The bound also keeps any queued call's wait to at most
  four budgets.
- **Each message is bounded before it is parsed** (#349), at 8 MiB of
  UTF-8 on the wire. The input schemas' limits and the `input_too_large`
  check above only see a call after the SDK's stdio transport has buffered
  and `JSON.parse`d it on the server's own thread, so on their own they
  bound what reaches a worker, not what the server holds. A size limiter in
  front of the transport forwards each newline-delimited message only once
  it is complete and within the limit; a longer one is dropped as it
  arrives — its remainder skipped without being kept — and answered with a
  JSON-RPC `-32600` error (`data.error: "message_too_large"`), after which
  the messages behind it are processed as normal. The error carries the
  request's `id` (#402), so the client's call fails at once instead of
  waiting out its own timeout: the limiter keeps only the first and last
  4 KiB of a dropped line and scans them — not parses — for a top-level
  `id` (integer or string), at the head for clients that write it first and
  at the tail for those that write it last, as the SDK's own client does.
  Only if neither window shows it conclusively is the `id` left out. 8 MiB carries the largest
  call the schemas accept (3M characters of sample and conf) with JSON
  escaping doubling every character, plus room for non-ASCII. The server's
  own heap is therefore bounded per message by that limit, not only once a
  message has passed the schemas. (Recent SDK releases cap their read buffer
  at 10 MB by closing the transport, which took the whole server down with
  one oversized line; the limiter stays below that.)
- **A cancelled request gives up its slot.** When the client cancels a call
  (`notifications/cancelled`) or the transport closes, a call still in the
  queue leaves it without ever starting a worker, and a running call's
  worker is terminated rather than left to run to its `timeout_ms` — as with
  a timeout, its slot frees once the worker has exited. The SDK sends no
  response to a cancelled request; the handler's own result is
  `{"error": "cancelled", "started": …}`, where `started` says whether a
  worker had begun.

## Process lifecycle

The client starts `dist/index.js`, which re-execs node (see above) and so
holds the *launcher's* pid, not the server's. The launcher forwards
`SIGTERM`, `SIGINT` and `SIGHUP` to the server and then exits the way the
server did: the same exit code, or — if the server was killed by a signal —
by re-raising that signal on itself, so a supervisor sees "killed by
SIGTERM" rather than an invented exit code. Stopping the client's process
therefore stops the server instead of orphaning it.

## Development

```bash
npm run typecheck   # tsc --noEmit over the package + the engine it imports
npm run build       # typecheck + esbuild bundles (dist/index.js, dist/simulateWorker.js)
npm test            # builds, then vitest — the worker tests run the built bundle
```

The engine is imported from `../../src/engine` as-is; this package makes no
engine changes, which is the boundary #202 draws — if one ever seems needed,
that's an issue to file, not a patch to hide here.
