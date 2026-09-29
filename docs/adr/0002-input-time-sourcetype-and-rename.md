# 0002. Input-time sourcetype assignment and `rename` are resolved before the pipeline runs

- **Status:** Accepted
- **Code:** `resolveDirectives`, `runPipeline` and `warnBatchMetadataRewrites` in `src/engine/pipeline.ts`; `ProcessingResult.inputMetadata` in `src/engine/types.ts`; `resolveStanzasForEvent` in `src/engine/parser/stanzaMatcher.ts`

## Context

Two props.conf settings change which stanzas apply to an event, and they were once read by nothing ([#186](https://github.com/Bimmiest/propslab/issues/186)):

- **`sourcetype =`** in a `[source::…]` or `[host::…]` stanza assigns the sourcetype at input. It decides what else matches, so it can't be read from the merged directive set: building that set means resolving against the sourcetype it is about to replace.
- **`rename`** changes the sourcetype that search time uses. The event stays indexed under its original sourcetype.

Once assignment was simulated, later changes kept comparing events against the metadata the caller passed in:

- The batch-mode rewrite check blamed a `DEST_KEY = MetaData:*` transform that did not exist, and per-event mode added a re-match step to every event ([#310](https://github.com/Bimmiest/propslab/issues/310)).
- The UI marked every event of an assigned sourcetype "Metadata Modified" ([#316](https://github.com/Bimmiest/propslab/issues/316), [#330](https://github.com/Bimmiest/propslab/issues/330)).
- `CLONE_SOURCETYPE` copies set off the same `DEST_KEY` warning, which sent the reader looking for a transform that wasn't there ([#330](https://github.com/Bimmiest/propslab/issues/330)).

## Decision

- **Resolve assignment first.** Stanzas are matched against the caller's metadata. If a matched stanza assigns a sourcetype, matching runs again against the assigned one. Two passes reach the fixed point, because a `[<sourcetype>]` stanza can't assign a sourcetype itself. The run reports the assignment as an info diagnostic.
- **`rename` is search-time only, and the target stanza is used alone.** Index-time directives come from the original match. Search-time directives come only from the stanzas matching the target sourcetype, because Splunk does not merge in the original's search-time settings. So `EXTRACT`, `REPORT`, `FIELDALIAS` and `EVAL` on the original stanza stop applying, and the run reports this.
- **The baseline is the metadata the events were broken with.** That is the caller's metadata after any input-time assignment (`effectiveMetadata`). The index-time rewrite check, per-event re-matching and `ProcessingResult.inputMetadata` all compare against it.
- **Clones are counted separately.** A `CLONE_SOURCETYPE` copy differs because it was cloned. It gets its own batch-mode warning and trace step, and never the `DEST_KEY` one.

## Consequences

- Per-event mode repeats the same two-step resolution (assignment, then `rename`) for each event whose metadata changed, so the two modes agree.
- A view that asks "did this run change the event's metadata?" must compare against `inputMetadata`, not against the metadata fields as they are now, which the user may have edited since.
- These rules come from `props.conf.spec` rather than a capture from Splunk.
