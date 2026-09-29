# 0009. `TRUNCATE` caps `LINE_BREAKER` segments, recorded beside the event

- **Status:** Accepted
- **Code:** `segmentLengths`, `segmentLengthsOf` and `MergedSegment` in `src/engine/processors/lineBreaker.ts`; `src/engine/processors/truncator.ts`

## Context

`TRUNCATE` is a per-line byte cap, and props.conf.spec defines a line as what `LINE_BREAKER` delimits, before merging.

- The truncator first measured the whole merged event, so a 300-line stack trace with short lines was cut to 10,000 bytes. Splunk leaves it intact.
- The next version split events on `\n` instead. With a custom breaker, one segment can span many `\n`s (a pretty-printed JSON record), so a record over the limit was never cut ([#287](https://github.com/Bimmiest/propslab/issues/287)).
- Only the breaker knows where its segments end. The truncator needs that information, but the event shape is what every consumer sees, serialises and compares.
- A merged event's end line was once computed from the joined text. Merged segments are joined by one `\n`, while the break they replaced may have been `\r\n` or a run of blank lines ([#317](https://github.com/Bimmiest/propslab/issues/317)).

## Decision

- `breakLines` records, for each event it builds, the length of every segment the event was made from. They go in a module-level `WeakMap` keyed on the event object, not in a field on `SplunkEvent`. `segmentLengthsOf(event)` reads them, and the truncator caps each segment.
- An event the breaker didn't build (for example, one from a library caller) has no entry. The same applies to an event whose `_raw` no longer matches the recorded lengths. For either, the truncator falls back to `\n`-separated lines, which are the default breaker's segments.
- `MergedSegment.end` records where the last segment ends in the raw input. Line ranges come from that offset, not from `offset + text.length`.

## Consequences

- The public event shape is unchanged. The segment record is garbage-collected with its event.
- Anything that replaces an event object between line breaking and truncation loses the record, and the event falls back to `\n` lines. Truncation runs right after line breaking.
