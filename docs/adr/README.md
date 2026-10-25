# Architecture decision records

An ADR records one design decision: the problem, the choice made, and what it costs. Each ADR keeps the history and the issue trail behind a choice, so the code and the changelog don't have to.

- **Code comments** say what the code does now and which constraint makes it non-obvious. When the reasoning needs history ("we tried X, #123 showed Y"), the comment ends with a pointer such as `See docs/adr/0003-one-strftime-directive-table.md.`
- **`CHANGELOG.md`** says what changed for a user, in one or two sentences, and links here when an ADR covers the rationale.
- **ADRs** hold the context and the trade-off.

## Conventions

- Files are named `NNNN-kebab-case-title.md` and numbered in the order they are written, from `0001`. A number is never reused.
- An ADR is not rewritten when a decision changes. Write a new one, set the old one's status to `Superseded by NNNN`, and link the two.
- A choice not yet made stays an issue, labelled `decision`, until it is: an ADR records a decision, an issue tracks the absence of one.
- Keep an ADR short and factual. Link the issues and PRs the decision came from, and name the files it governs.
- Every record has a row in the index below, in ascending order. CI's documentation check (shared-workflows' docs-check) holds the index to the directory, and a number with no file is explained under [Numbers with no record](#numbers-with-no-record).

## Template

```markdown
# NNNN. Title in sentence case

- **Status:** Proposed | Accepted | Superseded by [NNNN](NNNN-title.md)
- **Date:** YYYY-MM-DD
- **Issue:** #n
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
| [0013](0013-the-preview-receives-a-reduced-result.md) | The pipeline worker sends the preview a reduced, interned result | `src/utils/viewResult.ts`, `src/engine/pipelineWorker.ts` |
| [0014](0014-pipeline-worker-failure-policy.md) | A crashed input never runs inline, and the retry budget spans requests | `src/hooks/useProcessingPipeline.ts` |
| [0015](0015-mcp-timeouts-start-on-ready-and-report-progress.md) | MCP timeouts start on worker ready, report progress, and never touch caller input on the server thread | `packages/mcp-server/src/runInWorker.ts`, `packages/mcp-server/src/tools.ts` |
| [0016](0016-recorded-splunk-output-is-not-distributed.md) | Recorded Splunk output, and tests derived from it, are not distributed | `src/engine/__tests__/directiveEvidence.test.ts`, `.gitignore` |
| [0017](0017-ci-gates-come-from-shared-workflows.md) | CI calls the shared gates from `shared-workflows`, pinned by commit, wherever one is equivalent | `.github/workflows/` |
| [0018](0018-time-format-reads-l-as-milliseconds.md) | TIME_FORMAT reads `%l` as milliseconds; eval's `strftime()` keeps the 12-hour clock | `src/utils/strftime.ts`, `src/engine/processors/eval/builtins.ts` |

The index has a **Code** column where `repo-template`'s has **Status**: it names the files each decision governs, which is what a reader arrives looking for. Every record's status is on its first lines.

## Numbers with no record

None. When a number is skipped or a record is withdrawn, add a bullet here: `- **N**: why there is no file.`
