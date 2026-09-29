# 0004. Tokenised time formats are cached in a bounded LRU

- **Status:** Accepted
- **Code:** `tokenise`, `TOKENISE_CACHE_LIMIT` and `cachedFormatCount` in `src/utils/strftime.ts`

## Context

`parseTimestamp` tokenises its format on every call. Automatic recognition calls it once per candidate format per event, so an uncached 2,000-event run walks and compiles the same dozen formats thousands of times.

The first cache had no bound. Every partial `TIME_FORMAT` typed in the editor, and every format a long-running MCP client sent, stayed cached for the life of the process ([#436](https://github.com/Bimmiest/propslab/issues/436)).

## Decision

Tokenised formats are cached by format string in a `Map` used as an LRU, capped at 256 entries. A hit re-inserts its entry so the `Map`'s insertion order runs least-recently-used first. A miss that finds the cache full evicts the oldest entry. `cachedFormatCount()` exposes the size so a test can check the bound.

## Consequences

- A workload that cycles through more than 256 distinct formats will miss, but no real stanza set comes close.
- Memory is bounded by the cap, however long the process runs.
