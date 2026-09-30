# 0004. Tokenised time formats are cached in a bounded LRU

- **Status:** Accepted
- **Code:** `BoundedLru`, `tokenise`, `TOKENISE_CACHE_LIMIT`, `cachedFormatCount`, `ianaFormatter`, `ZONE_CACHE_LIMIT` and `cachedZoneCount` in `src/utils/strftime.ts`

## Context

`parseTimestamp` tokenises its format on every call. Automatic recognition calls it once per candidate format per event, so an uncached 2,000-event run walks and compiles the same dozen formats thousands of times.

The first cache had no bound. Every partial `TIME_FORMAT` typed in the editor, and every format a long-running MCP client sent, stayed cached for the life of the process ([#436](https://github.com/Bimmiest/propslab/issues/436)).

## Decision

Tokenised formats are cached by format string in a `Map` used as an LRU, capped at 256 entries. A hit re-inserts its entry so the `Map`'s insertion order runs least-recently-used first. A miss that finds the cache full evicts the oldest entry. `cachedFormatCount()` exposes the size so a test can check the bound.

The IANA zone formatter cache follows the same rule ([#480](https://github.com/Bimmiest/propslab/issues/480)). Its keys come from the data as well as the config — a `%Z` capture, a `TZ_ALIAS` target — so each distinct word cost a failed `Intl.DateTimeFormat` construction and a permanent entry. It is the same LRU, capped at 64 zone names; a name the runtime rejects is cached as `null`, so it is not retried while it stays in the cache.

## Consequences

- A workload that cycles through more than 256 distinct formats will miss, but no real stanza set comes close.
- Memory is bounded by the cap, however long the process runs.
- A sample naming more than 64 distinct zones re-resolves the older ones as they come back; a real config uses a handful.
