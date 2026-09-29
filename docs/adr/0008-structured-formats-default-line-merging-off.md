# 0008. `INDEXED_EXTRACTIONS` turns the `SHOULD_LINEMERGE` default off, except for XML

- **Status:** Accepted
- **Code:** `shouldLineMergeFor` in `src/engine/processors/lineBreaker.ts`; the line-breaking step in `src/engine/pipeline.ts`

## Context

- `INDEXED_EXTRACTIONS = json` appeared to extract nothing ([#164](https://github.com/Bimmiest/propslab/issues/164)). The extractor worked, but `SHOULD_LINEMERGE` defaults to true, so two JSON objects on two lines merged into one event. `JSON.parse` of two concatenated objects throws, so the event yielded no fields. Splunk defaults `SHOULD_LINEMERGE` to false when `INDEXED_EXTRACTIONS` names a format that has one record per line. Fixing this cleared the last `knownMismatch` in the fidelity corpus.
- The XML modes (`xml`, `xmlkv`, `xmlkv-winevt`) were added later ([#271](https://github.com/Bimmiest/propslab/issues/271)). An XML record is a document and often spans lines. Splitting it per line gives the extractor fragments that don't parse, and it ignores the `BREAK_ONLY_BEFORE` the user wrote to frame the record.
- For a while the pipeline kept a second copy of the default next to the line breaker's, and the two could drift ([#322](https://github.com/Bimmiest/propslab/issues/322)).

## Decision

- When `SHOULD_LINEMERGE` is absent, it defaults to false if `INDEXED_EXTRACTIONS` names a format other than `none` and the XML modes, and to true otherwise.
- An explicit `SHOULD_LINEMERGE` always wins. A value that isn't a recognised boolean reads as false.
- `shouldLineMergeFor` in the line breaker is the only place this default is decided. The pipeline doesn't restate it.

## Consequences

- A stanza with `INDEXED_EXTRACTIONS = csv` and pretty-printed records needs an explicit `SHOULD_LINEMERGE = true` or a custom `LINE_BREAKER`, as it does in Splunk.
- The scaffold's suggestions for pretty-printed JSON and XML rely on this rule ([#438](https://github.com/Bimmiest/propslab/issues/438)).
