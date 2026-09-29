# 0012. Conf files can be parsed as ordered layers, with provenance

- **Status:** Accepted
- **Code:** `ConfLayer`, `ConfInput`, `ConfDirective.layer`, `overrides` and `overriddenBy` in `src/engine/types.ts`; `runPipeline` in `src/engine/pipeline.ts`; `src/engine/parser/confParser.ts` and `src/engine/parser/provenance.ts`

## Context

The engine modelled one flat file of each conf ([#115](https://github.com/Bimmiest/propslab/issues/115)). A consumer reading an app from disk has `default/` and `local/` copies of each, and had two bad options. It could flatten them itself, duplicating precedence logic that belongs in the engine. Or it could render one layer and misrepresent the other. Flattening also destroys the one fact such a consumer wants: which file supplied the value that won.

## Decision

- `parseConf`, `runPipeline` and the worker request accept either a string or an ordered list `[{ layer, text }, …]`, lowest precedence first. `layer` is a free-form label the engine carries through and never interprets. Only the caller knows how its layers rank, so order sets precedence.
- Layers merge per attribute within a stanza. This needs no new rule: concatenating the layers in precedence order and applying Splunk's last-definition-wins rule gives exactly the per-attribute merge.
- Provenance is kept. Every directive carries its `layer`, including the directives `mergeDirectives` returns. The winner of a contested key carries `overrides`, nearest first, so `overrides[0]` is the value that would apply if the winning line were deleted. Each loser carries `overriddenBy`. Stanzas list every layer that defines them. Diagnostics carry `layer` next to `line`, because both files have a line 7.
- A plain string produces the same result as before, with no provenance fields, and a single layer is a no-op merge.

## Consequences

- This is the file-layer half of what `btool … --debug` prints. Which *stanza* won is a separate question ([#86](https://github.com/Bimmiest/propslab/issues/86)), and the two combine.
- The app's editors still hold one flat file each, so layering is engine API only, and presenting it is up to the consumer.
- Shadowed directives stay in the stanza, so resolution is unchanged.
