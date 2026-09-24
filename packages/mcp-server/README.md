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
| `validate` | the pipeline's config-level parse/lint path | `ValidationDiagnostic[]` for conf text alone — no sample needed |
| `explain_precedence` | layered `parseConf` + `resolveStanzasForEvent` + `mergeDirectives` | btool-style provenance: which layer won each attribute (`overrides` / `overriddenBy` / `layers`), and the effective directive set for a sourcetype |
| `lookup_directive` | `directiveRegistry` | Curated directive documentation, including the simulation-support level, so an agent cites the registry instead of recalling spec |

`simulate`, `validate` and `explain_precedence` accept conf input as either
one flat string or an ordered list of layers, lowest precedence first — an
agent pointed at a real app directory hands over `default/` + `local/` and
gets btool-style provenance back.

## Setup

```bash
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
- **`captureOffsets` defaults to `false`** — nothing here renders highlights,
  and the `d` flag it forces onto every `EXTRACT` disqualifies patterns from
  V8's linear-time fallback (measured at 8 ms vs 91 s in `docs/engine.md`).
- **The launcher re-execs node with
  `--enable-experimental-regexp-engine-on-excessive-backtracks`** (plus a
  backtrack threshold) before anything compiles a regex, as the documented
  second layer. Lookaheads and backreferences decline that fallback, which is
  why the watchdog stays the mechanism. `PROPSLAB_MCP_NO_REEXEC=1` opts out.
- **A timeout comes back structured**: budget, every regex-valued directive
  in the conf (file / stanza / key / line / layer), and which of them the
  engine's ReDoS heuristic flags — so the agent can repair the pattern rather
  than retry blind. The heuristic is structural and documents what it cannot
  see (e.g. `(a|aa)+`), and the error text says so.
- **Each worker has a heap limit** (V8 `resourceLimits`: 512 MB old
  generation, 64 MB young). A run that exceeds it kills only its own worker
  and comes back as `{"error": "out_of_memory", "heap_limit_mb": …}` with
  guidance to shrink the input, instead of growing until the whole server
  dies. 512 MB is what the worst input the schemas accept needs (1 MB of
  very short lines, ~125k events); 256 MB was measured to be too little.
  That includes the conf side, which is why it has a combined bound:
  per field the schemas admit 20 layers of 1M characters, but
  `props_conf` and `transforms_conf` together may carry at most 2M
  characters across all their layers. More comes back as
  `{"error": "input_too_large", "conf_chars": …, "max_conf_chars": …}`
  before any worker starts. The bound also caps what a timeout re-parses
  on the server's own thread to list regex suspects — a few hundred
  milliseconds at the limit. A 1 MB sample of one-character lines beside
  2M characters of conf was measured to complete within 512 MB.
  Process-wide V8 heap flags override worker limits, so the launcher strips
  `--max-old-space-size` / `--max-semi-space-size` / `--max-heap-size` from
  its own arguments and from `NODE_OPTIONS` before re-exec'ing, and says so
  on stderr. With `PROPSLAB_MCP_NO_REEXEC=1` nothing is stripped.
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
  JSON-RPC `-32600` error (`data.error: "message_too_large"`, no `id`,
  since finding it would mean parsing the message), after which the
  messages behind it are processed as normal. 8 MiB carries the largest
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
