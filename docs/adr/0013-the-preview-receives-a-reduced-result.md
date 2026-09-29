# 0013. The pipeline worker sends the preview a reduced, interned result

- **Status:** Accepted
- **Code:** `src/utils/viewResult.ts`, `src/engine/pipelineWorker.ts`, `src/store/useAppStore.ts`

## Context

The pipeline runs in a worker, and its result reaches the page by structured clone. At 20,000 events, cloning `runPipeline`'s result took about as long as the run itself (about 650 ms against 500–800 ms, measured under Node), and the page pays for deserialising it on the main thread. Most of that cost was per-event traces: about 120,000 step objects, each carrying prose (`description`) and before/after snapshots. No view reads either per event. Without the traces the clone took about 210 ms.

[#454](https://github.com/Bimmiest/propslab/issues/454) proposed keeping the whole result in the worker and fetching a page, or one event's trace, on demand. The views argue against moving the events themselves. Search, the field filters, the field sidebar, pinned-field counts and the Regex and Extractions tabs all work over the whole filtered set, so each would become an asynchronous query. The traces, by contrast, are read for their structured fields, and only the Pipeline tab reads prose, as a summary across events.

Stripping the prose alone saved nothing, because the object count is the cost. Interning the stripped traces does save it: most events' steps are identical once the prose is gone, and structured clone sends a repeated reference once. Interning whole steps with their prose did not help, because the line-breaker and timestamp descriptions differ on every event.

## Decision

- The worker posts `toViewResult(result)`, not the result itself. Each step keeps only its structured fields (`TraceStep`). Each event's trace is interned by those fields, so events with matching steps share one array. Metadata objects are interned, and `timestampText` is dropped where it equals `_raw`, which is what its readers fall back to.
- The Pipeline tab reads `stepSummaries`, which the worker builds from the full traces.
- The store holds a `ViewResult`. The inline fallback applies the same reduction, so the views see one shape either way.
- A shared trace array is read-only.

## Consequences

- Measured in the e2e perf test at 20,000 events: paste to status bar went from 1.8–2.3 s to 1.65–1.7 s, and switching to the Pipeline tab from about 95 ms to about 15 ms.
- A view cannot read a step's `description`, per event or otherwise, apart from the Pipeline tab's summary. A new need is met by a structured step field ([0010](0010-engine-decisions-are-structured-data-on-the-event.md)).
- The events still cross the boundary whole, with their fields. Paging them from the worker would make every whole-set view asynchronous; revisit that if the field objects come to dominate.
- The engine's own result, which the MCP server and library consumers receive, is unchanged.
