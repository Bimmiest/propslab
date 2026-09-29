# 0011. Fields affected by a `_raw` rewrite are found by replaying extraction

- **Status:** Accepted
- **Code:** `RawMutation` and `SplunkEvent.rawMutations` in `src/engine/types.ts`; the final search-time step in `src/engine/pipeline.ts`; `src/engine/processors/rawMutationAttribution.ts`

## Context

`SEDCMD` and `DEST_KEY = _raw` recorded only that a substitution happened. A masked field looked the same as one that was never extracted, and the two need opposite fixes ("your mask is eating this value" versus "write an extraction").

- A rewrite has no field parameter, so it can't name what it changed. The association exists only by comparison.
- The extraction rules needed for that comparison don't run until search time, well after the rewrite.
- Guessing from the text diff can't separate two fields that share a region. In `pair=123-45-6789 tail=6789`, a text diff blames both fields.
- `INGEST_EVAL` assignments to `_raw` were added to the same mechanism later ([#346](https://github.com/Bimmiest/propslab/issues/346)).

## Decision

- Each index-time rewrite of `_raw` appends a transient `RawMutation` to the event: `_raw` before and after, and the index of the trace step to fill in.
- After every search-time stage, a final pass replays the extractors that read `_raw` (`EXTRACT`, `REPORT`, `KV_MODE`) against the before and after text and diffs the resulting fields. A field whose value changed goes in the step's `fieldsModified`. A field that no longer extracts goes in `fieldsRemoved`. The two are kept apart because the fixes differ.
- `FIELDALIAS` and `EVAL` are not replayed. They derive from other fields, so including them would report every calculated field whose inputs shifted and bury the field the rule actually hit.
- `rawMutations` is stripped before results leave the pipeline, including when a stage threw and left it in place.

## Consequences

- Attribution costs one extra extraction replay per rewrite, and only for events that were rewritten.
- The pass has to stay last, after every search-time stage, and has to use the same directives those stages used.
- The Transforms tab shows the result as `~field` and `−field` chips, and the Fields tab as a `masked` badge.
