# 0019. A run stops at its time budget, and a match cannot take more than 10,000,000 steps

- **Status:** Accepted
- **Date:** 2026-10-25
- **Issue:** [#560](https://github.com/Bimmiest/propslab/issues/560)
- **Code:** `withRegexDeadline` and `extractionLimits` in `src/utils/splunkRegex.ts`, `safeProcessor` in `src/engine/pipeline.ts`, `RunLimits.maxRunMs` in `src/engine/runContext.ts`

## Context

PCRE2's limits bound each match. Nothing bounded a whole run. `LINE_BREAKER`, `SEDCMD`, `TIME_PREFIX` and the regex functions of eval run with the PCRE2 default of 10,000,000 steps. One match at that limit takes about 0.2 s, so a catastrophic pattern over 25,000 events can run for more than an hour. Only the 5 s watchdog of the worker stopped it, and the preview showed no result. On the main thread, which the app uses if no worker loads, nothing stopped it.

`MATCH_LIMIT = 0` means "no limit" in the spec. Propslab gave PCRE2 0xffffffff steps, and one match at that limit runs for about 90 s.

## Decision

- `RunLimits.maxRunMs` gives a run a time budget. The regex engine checks the deadline before each match. After the deadline, the next regex call throws, and the stage that makes the call stops. The stages after it do not run. The events go through these stages unchanged, and one error diagnostic names the stage.
- The default budget has no bound. Thus a library caller gets the same result on a slow machine as on a fast machine.
- The browser app sets a budget of 4 s for each run, in a worker and on the main thread. That is less than the 5 s watchdog. Thus a slow run gives a result and a diagnostic, not a stopped worker.
- The MCP server sets no budget. It stops its sandbox worker at the `timeout_ms` of the call, and its timeout error names the stage.
- A `MATCH_LIMIT` or `DEPTH_LIMIT` of 0, or of more than 10,000,000, becomes 10,000,000, the PCRE2 default. A config lint tells the user. Without this cap, one match can run for longer than any budget, because the engine checks the deadline only between matches.
- Patterns outside field extraction keep the PCRE2 default limits. With lower limits, a `LINE_BREAKER` or `SEDCMD` pattern that Splunk runs can fail here. The run budget already bounds their total.

## Consequences

- A stage that stops on the budget is a failed stage, as in [ADR 0001](0001-stage-failures-degrade-to-diagnostics.md). A `LINE_BREAKER` that stops gives no events.
- A run can go past its budget by one match, about 0.2 s at the cap, and by the work in the stage that uses no regex.
- With `MATCH_LIMIT = 0`, a pattern that needs more than 10,000,000 steps matches in Splunk but not in Propslab.
- A stage that catches errors must let `RegexDeadlineError` through. EVAL, `INGEST_EVAL`, `STOP_PROCESSING_IF` and the attribution of `_raw` rewrites do this, and each has a test in `src/engine/__tests__/runLimits.test.ts`.
