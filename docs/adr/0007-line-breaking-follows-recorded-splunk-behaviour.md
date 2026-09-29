# 0007. Line breaking and merging follow recorded Splunk behaviour over the spec's prose

- **Status:** Accepted
- **Code:** `resolveLineBreaker`, `splitSegments`, `readMergeRules`, `breakReason` and `dateLineTest` in `src/engine/processors/lineBreaker.ts`

## Context

Several line-breaking bugs were reasonable readings of `props.conf.spec` that output captured from Splunk 10.4.0 contradicted. Line breaking decides every downstream result, so where a capture exists it settles the rule.

- **`LINE_BREAKER` with no capturing group** ([#172](https://github.com/Bimmiest/propslab/issues/172)). The engine treated the whole match as the separator. Splunk falls back to breaking on newlines, and the would-be delimiter becomes an event of its own. A PCRE-only pattern such as `(?i)([\r\n]+)date` was once miscounted as having no group ([#311](https://github.com/Bimmiest/propslab/issues/311)).
- **Zero-width breaks and lookbehind** ([#283](https://github.com/Bimmiest/propslab/issues/283)). Re-slicing the remaining input for each search split events one character at a time on an empty capture, and hid earlier text from lookbehind.
- **`BREAK_ONLY_BEFORE` was anchored** as `^(?:…)`. The Splunk 10.4.0 check in [#323](https://github.com/Bimmiest/propslab/issues/323) showed `BREAK_ONLY_BEFORE = EVENT` breaking before `a EVENT 2 is mid-line` and before `  EVENT 3`.
- **`MUST_BREAK_AFTER` was read as permission to merge** ([#161](https://github.com/Bimmiest/propslab/issues/161)). With `BREAK_ONLY_BEFORE_DATE = false` and no `BREAK_ONLY_BEFORE`, Splunk breaks every line: 6 events where the engine produced 2.
- **`MAX_EVENTS` broke one line early** ([#162](https://github.com/Bimmiest/propslab/issues/162)). The `linebreak-max-events` capture shows `MAX_EVENTS = 3` producing four-line events.
- **The negative merge rules** ([#190](https://github.com/Bimmiest/propslab/issues/190)). The spec describes `MUST_NOT_BREAK_BEFORE` as suppressing breaks. Three captures (`linebreak-must-not-break-before`, `-explicit`, `-forced`) show Splunk breaking anyway against a date rule, `BREAK_ONLY_BEFORE`, and a break forced by `MUST_BREAK_AFTER`. The `linebreak-must-not-break-after-span` capture shows `MUST_NOT_BREAK_AFTER` suppressing breaks until a `MUST_BREAK_AFTER` line.
- **Dates for `BREAK_ONLY_BEFORE_DATE`** came from built-in patterns that disagreed with the extractor ([#352](https://github.com/Bimmiest/propslab/issues/352), [#369](https://github.com/Bimmiest/propslab/issues/369)).

## Decision

- A `LINE_BREAKER` with no capturing group is replaced by the default `([\r\n]+)`, with a warning. Groups are counted on the compiled PCRE2 pattern.
- The breaker iterates matches over the whole input from an offset, so lookbehind sees consumed text and the tail is never copied per event. A break that wouldn't move the event start forward is retried one character on.
- `BREAK_ONLY_BEFORE` is searched anywhere in a segment, and the new event starts at the beginning of that line.
- `MUST_BREAK_AFTER` forces a break but doesn't license merging. When it is the only rule in force, every line is its own event. With no `MUST_BREAK_AFTER` either, merging still happens, bounded by `MAX_EVENTS`, as Splunk documents and no capture contradicts.
- `MAX_EVENTS` caps continuation lines, so an event holds at most `MAX_EVENTS + 1` lines.
- `MUST_NOT_BREAK_AFTER` is stateful. Once a line matches it, rule-driven breaks are suppressed until a line matches `MUST_BREAK_AFTER`, or to the end of input. `MAX_EVENTS` is a hard cap it doesn't defeat. `MUST_NOT_BREAK_BEFORE` is deliberately not read, because no observable configuration shows the suppression the spec describes.
- A line "has a date" for `BREAK_ONLY_BEFORE_DATE` exactly when the timestamp extractor would read one from it, under the stanza's `TIME_PREFIX`, `TIME_FORMAT` and `MAX_TIMESTAMP_LOOKAHEAD`.

## Consequences

- Where the spec and a capture disagree, the code follows the capture. The comment at each rule names the capture it follows.
- The fixture corpus is closed (see `src/engine/__tests__/fixtures/README.md`), so any rule outside these captures is documentation-derived and says so.
