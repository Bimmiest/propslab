# 0014. A crashed input never runs inline, and the retry budget spans requests

- **Status:** Accepted
- **Code:** `src/hooks/useProcessingPipeline.ts`, `src/hooks/workerLifecycle.ts`

## Context

The pipeline worker has a watchdog, and the page's own thread does not. The inline fallback exists for environments where no worker can be built at all. It must not become a path by which an input that crashes a worker runs where nothing can stop it ([#326](https://github.com/Bimmiest/propslab/issues/326)).

A crashed request is replayed once on a replacement worker. The retry count used to be reset on every new request. A worker that had just crashed then got a fresh budget from the next keystroke, so the cap on restarts held for one request but not across them: auto-run and manual-run traffic could restart the worker indefinitely. A later timeout or load failure during a replay could also clear the way to running the crashed input inline ([#421](https://github.com/Bimmiest/propslab/issues/421)).

## Decision

- A request that crashed a worker is marked `crashed`, and the mark is sticky: no later turn of its replay clears it, and it is never finished inline.
- The retry budget is cleared only when a request completes cleanly or the pipeline gives up on one, never when a new request is sent.
- A load failure is not charged to the request, because no code ran it. A timeout before the worker loaded counts as a load failure ([#420](https://github.com/Bimmiest/propslab/issues/420)).

## Consequences

- Restarts are bounded across requests, not just within one.
- An environment that keeps crashing workers stops with an error rather than falling back to the main thread.
- The worker lifecycle rules this builds on are in `docs/architecture.md` under "Workers".
