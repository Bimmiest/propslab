# 0010. What the engine decided is carried as structured data on the event and trace

- **Status:** Accepted
- **Code:** `ProcessingStep` and `SplunkEvent` in `src/engine/types.ts`

## Context

The UI and the MCP server need to explain a result: where `_time` came from, which aliases a step created, which expression produced a calculated field, what metadata a transform rewrote, and why a directive did nothing. The engine can recover each of these in two ways, and both go wrong:

- **Parsing it back out of `description`.** Descriptions are prose for people, and rewording one silently breaks the consumer.
- **Re-deriving it from props.conf in the UI.** The Extractions tab recovered EVAL expressions this way. That repeated questions the parser had already answered (case sensitivity, line continuations, which stanza applies), and sometimes answered them differently.

Two related cases:

- The Timestamp tab probed the final `_raw`. By then a `SEDCMD` could have masked the `TIME_PREFIX`, so the tab reported "no match" on an event whose `_time` had been read without trouble ([#328](https://github.com/Bimmiest/propslab/issues/328)).
- `INGEST_EVAL` metadata assignments showed only as prose ([#346](https://github.com/Bimmiest/propslab/issues/346)).

## Decision

The stage that makes a decision records it on the event, in structured form, at the point where it is correct:

- `ProcessingStep.timeSource`: which rule in the timestamp fallback chain set `_time`.
- `ProcessingStep.fieldAliases`, `evalExpressions` and `metadataChanges`: the alias pairs, the expression behind each calculated field (taken from the directives that survived stanza matching for this event), and each metadata change from old value to new.
- `ProcessingStep.fieldsModified` and `fieldsRemoved`: see [0011](0011-raw-rewrites-attributed-by-replay.md).
- `SplunkEvent.timestampText`: the text the timestamp extractor read, which is `_raw` after line breaking and `TRUNCATE` but before any rewrite.
- `SplunkEvent.clonedFrom`: the original sourcetype of a `CLONE_SOURCETYPE` copy, so the pair is linked.
- `SplunkEvent.noOps`: directives that applied and changed nothing, each with a reason. These sit **beside** `processingTrace`, not in it. Every consumer treats a trace step as work done, and the Pipeline tab counts steps.

`description` remains, for display only.

## Consequences

- Consumers read the structured fields, never `description`.
- A new explanation the UI needs means a new field recorded by the stage that knows the answer, not UI code that re-derives it.
- `timestampText` shares its string with `_raw` until a later step replaces `_raw`, so it costs nothing in the common case.
