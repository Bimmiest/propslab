# 0001. A stage that throws degrades to a diagnostic

- **Status:** Accepted
- **Code:** `safeProcessor` in `src/engine/pipeline.ts`

## Context

The pipeline is a chain of stages, and user input decides what each one does. A bug in a stage, or an input that pushes it past a limit, should not blank the whole preview.

- Every stage except the line breaker ran inside `safeProcessor`, so a throw in `breakLines` still failed the run. [#301](https://github.com/Bimmiest/propslab/issues/301) wrapped it too.
- `safeProcessor` returned the batch unchanged when a stage threw. One pathological event therefore removed the stage from every event. [#428](https://github.com/Bimmiest/propslab/issues/428) found this with deeply nested XML: one event overflowed the stack in the XML walker, and every event in the batch lost its XML fields.
- A naive retry reports twice. The failed batch attempt may already have pushed warnings before it threw, and each retried event would push them again.

## Decision

Every stage runs through `safeProcessor`, declared with a shape ([#452](https://github.com/Bimmiest/propslab/issues/452)):

- **`per-event`** (the default): the stage's output for an event depends only on that event. If the batch throws, the stage is re-run one event at a time. Events that still throw pass through unchanged, and a single error names how many failed and the first one's line.
- **`batch`**: line breaking, timestamp extraction (an event can inherit the previous event's `_time`) and `INDEXED_EXTRACTIONS` (a CSV header names later rows' fields). Running these one event at a time would be a different computation, so on a throw the whole batch falls back unchanged.

The retry reports through a de-duplicating view seeded with what the failed attempt already said, so it adds no duplicate warnings. The run's warning ledger is shared, so "once per run" warnings stay once.

The line breaker is a batch stage with an empty fallback: if nothing was broken there are no events to carry forward, so passing the unbroken input through would be wrong.

## Consequences

- A per-event stage must not keep state across events, or the retry changes its answer. A stage that reads across events has to be declared `batch`.
- A failing event costs a second pass over the batch, one event at a time. That only happens on the error path.
- The per-event pipeline mode (re-matching stanzas per event) already calls every search-time stage once per event, so isolation comes for free there.
