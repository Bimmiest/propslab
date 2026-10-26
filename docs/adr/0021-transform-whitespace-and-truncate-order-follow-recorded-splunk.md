# 0021. Transform whitespace and the TRUNCATE order follow recorded Splunk behaviour

- **Status:** Accepted
- **Date:** 2026-10-26
- **Issue:** [#561](https://github.com/Bimmiest/propslab/issues/561)
- **Code:** `asRead` in `src/engine/transforms/regexTransform.ts`, `mergeSegments` in `src/engine/processors/lineBreaker.ts`, `src/engine/processors/truncateLine.ts`

## Context

The review in #561 found two places where the engine guessed. The spec does not settle either.

- **Trailing whitespace in `REGEX` and `FORMAT`.** The engine trimmed both, although its own rule (`directiveValues.ts`) says a regex or a `FORMAT` can be whitespace-sensitive. `transforms.conf.spec` says nothing about whitespace in these values.
- **`TRUNCATE` and line merging.** The engine merged lines first and truncated after. So `MUST_BREAK_AFTER`, `BREAK_ONLY_BEFORE` and the other merge rules read lines that `TRUNCATE` would cut. `props.conf.spec` calls `TRUNCATE` the maximum line length, and does not say whether the merge rules see the cut line.

A capture on Splunk Enterprise 10.4.0 (build f798d4d49089) on 2026-10-26 answered both. The probes and their results are in the private fidelity suite, as [ADR 0016](0016-recorded-splunk-output-is-not-distributed.md) requires.

- An index-time transform keeps trailing whitespace in `REGEX` and `FORMAT`. A search-time transform drops it.
- `TRUNCATE` cuts each line before the merge rules read it. The merged event is not cut again.

## Decision

- `REGEX` and `FORMAT` keep trailing whitespace at index time and drop it at search time. Leading whitespace was not captured; it is dropped in both phases, as before.
- The merge rules read each line as `TRUNCATE` leaves it. The events keep their full text until the truncator stage cuts their lines, which keeps the trace step and `meta = truncated` where they were.

## Consequences

- A `REGEX` or `FORMAT` in an index-time stanza with a trailing space now behaves differently from the same value in a `REPORT-` stanza, as it does in Splunk.
- As with [ADR 0007](0007-line-breaking-follows-recorded-splunk-behaviour.md), no public test asserts these rules ([ADR 0016](0016-recorded-splunk-output-is-not-distributed.md)). The private suite does, and the code comments say what each rule follows.
