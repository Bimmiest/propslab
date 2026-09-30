# 0015. MCP timeouts start on worker ready, report progress, and never touch caller input on the server thread

- **Status:** Accepted
- **Code:** `packages/mcp-server/src/runInWorker.ts`, `packages/mcp-server/src/simulateWorker.ts`, `packages/mcp-server/src/progress.ts`, `packages/mcp-server/src/tools.ts`, `src/engine/runStages.ts`

## Context

Every tool run is a worker with a wall-clock budget; the server's own thread has no watchdog and no heap limit, and a stall there stops every response, cancellation and new call, which `SECURITY.md` puts in scope.

- A timed-out run used to list regex suspects by parsing the caller's conf again on the server thread. The conf parser was quadratic on continuation lines, so a 1.98M-character conf stalled the server for about two minutes ([#468](https://github.com/Bimmiest/propslab/issues/468)). The suspects' ReDoS verdict cache also kept each caller's whole conf alive through V8 sliced-string keys ([#487](https://github.com/Bimmiest/propslab/issues/487)).
- Every timeout blamed a backtracking regex and said not to retry with a larger budget, although the largest legitimate inputs need more than the 5 s default; and the budget included the worker's start-up, 60–120 ms against a 100 ms minimum ([#488](https://github.com/Bimmiest/propslab/issues/488)).

Two ways to keep suspects off the server thread were considered: a second, short-lived worker spawned after a timeout, or the run's own worker computing them first. The second worker would leave the happy path untouched, but would spend another budget re-parsing a conf that had just proved too slow to parse, and would need a concurrency slot of its own. Computing them first costs every simulate run a second linear parse (about 0.2 s at the 2M-character limit) and lets the timeout know whether the run ever got past parsing.

## Decision

- The server thread never parses caller input beyond schema validation. The simulate worker builds the suspect list, cut to the response budget, and posts it before the pipeline runs; the server keeps the last one it was sent. Validate and explain run no directive's regex and post none.
- The worker posts `ready` once loaded, with the regex engine instantiated; the budget starts then. Start-up has its own 10 s cap, reported as `start_timeout`, never as the input's fault.
- The worker records its progress — phase, pipeline stage, events that stage was given — in one 32-bit word of a `SharedArrayBuffer`, written with a single atomic store, because a worker stuck in a pattern cannot answer a message. The engine reports stages through `PipelineOptions.onStage`.
- The timeout's advice follows the progress: a run stalled on one event, or on breaking a sample too small to take that long, is blamed on a regex; a run over many events is told both remedies; a run stopped while parsing or shaping the response is told it is size.
- A budget timer that fires waits one event-loop turn before declaring a timeout, so an answer delivered during a stall on the server thread is read first.

## Consequences

- A simulate run parses its conf twice. Both parses are linear, and the second is a small share of any run long enough to time out.
- The stall heuristic is deliberately conservative: it names a regex only when little input remains to explain the time. Per-event search time reports one stage over every event, so a stall there reads as volume.
- A worker that never posts `ready` (the test fixtures, or a future worker script) is bounded by the start-up cap rather than the budget.
- Changing the stage names means changing `RUN_STAGES`; the progress word holds at most 31 stages and about eight million events.
