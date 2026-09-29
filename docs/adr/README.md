# Architecture decision records

An ADR records one design decision: the problem, the choice made, and what it costs. Each ADR keeps the history and the issue trail behind a choice, so the code and the changelog don't have to.

- **Code comments** say what the code does now and which constraint makes it non-obvious. When the reasoning needs history ("we tried X, #123 showed Y"), the comment ends with a pointer such as `See docs/adr/0003-one-strftime-directive-table.md.`
- **`CHANGELOG.md`** says what changed for a user, in one or two sentences, and links here when an ADR covers the rationale.
- **ADRs** hold the context and the trade-off.

## Conventions

- Files are named `NNNN-kebab-case-title.md` and numbered in the order they are written, from `0001`. A number is never reused.
- An ADR is not rewritten when a decision changes. Write a new one, set the old one's status to `Superseded by NNNN`, and link the two.
- Keep an ADR short and factual. Link the issues and PRs the decision came from, and name the files it governs.

## Template

```markdown
# NNNN. Title in sentence case

- **Status:** Proposed | Accepted | Superseded by [NNNN](NNNN-title.md)
- **Code:** `src/…`

## Context

The problem and the constraints, with the issues that surfaced them.

## Decision

What the code does, stated as a rule.

## Consequences

What follows, good and bad: what the rule costs, what it rules out, and what to check when changing it.
```

## Index

| # | Decision | Code |
|---|---|---|
| [0001](0001-stage-failures-degrade-to-diagnostics.md) | A stage that throws degrades to a diagnostic, and per-event stages isolate the failing event | `src/engine/pipeline.ts` |
| [0002](0002-input-time-sourcetype-and-rename.md) | Input-time `sourcetype` assignment and `rename` are resolved before the pipeline runs | `src/engine/pipeline.ts`, `src/engine/types.ts` |
| [0003](0003-one-strftime-directive-table.md) | Parsing, formatting and linting of strftime formats read one directive table | `src/utils/strftime.ts` |
| [0004](0004-bounded-time-format-cache.md) | Tokenised time formats are cached in a bounded LRU | `src/utils/strftime.ts` |
| [0005](0005-yearless-timestamps-take-the-most-recent-year.md) | A yearless timestamp takes the most recent year it can be, from UTC | `src/utils/strftime.ts` |
| [0006](0006-time-zone-resolution.md) | How a timestamp's zone is chosen and resolved | `src/utils/strftime.ts` |
| [0007](0007-line-breaking-follows-recorded-splunk-behaviour.md) | Line breaking and merging follow recorded Splunk behaviour over the spec's prose | `src/engine/processors/lineBreaker.ts` |
| [0008](0008-structured-formats-default-line-merging-off.md) | `INDEXED_EXTRACTIONS` turns the `SHOULD_LINEMERGE` default off, except for XML, and only the line breaker decides it | `src/engine/processors/lineBreaker.ts` |
| [0009](0009-truncate-caps-line-breaker-segments.md) | `TRUNCATE` caps `LINE_BREAKER` segments, recorded beside the event | `src/engine/processors/lineBreaker.ts` |
| [0010](0010-engine-decisions-are-structured-data-on-the-event.md) | What the engine decided is carried as structured data on the event and trace | `src/engine/types.ts` |
| [0011](0011-raw-rewrites-attributed-by-replay.md) | Fields affected by a `_raw` rewrite are found by replaying extraction | `src/engine/types.ts`, `src/engine/pipeline.ts` |
| [0012](0012-layered-conf-input.md) | Conf files can be parsed as ordered layers, with provenance | `src/engine/types.ts`, `src/engine/pipeline.ts` |
