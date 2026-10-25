# 0018. TIME_FORMAT reads `%l` as milliseconds; eval's `strftime()` keeps the 12-hour clock

- **Status:** Accepted
- **Date:** 2026-10-25
- **Issue:** [#578](https://github.com/Bimmiest/propslab/issues/578)
- **Code:** `buildDirectiveMap` and `formatStrftime` in `src/utils/strftime.ts`, `strftime` in `src/engine/processors/eval/builtins.ts`

## Context

[ADR 0003](0003-one-strftime-directive-table.md) put every strftime directive in one table, so that parsing and formatting a directive cannot disagree. The table read `%l` as the C library reads it: the hour on a 12-hour clock, space-padded.

Splunk's own default `props.conf` times splunkd.log with `TIME_FORMAT = %m-%d-%Y %H:%M:%S.%l %z`, and the Troubleshoot HTTP Event Collector page gives the same format for its metrics events. There `%l` is three digits of milliseconds. Read as an hour, it matched nothing in `10-06-2026 15:30:00.282 +0000`. With `BREAK_ONLY_BEFORE_DATE` on, no line had a date, and 60 splunkd records merged into one event ([#578](https://github.com/Bimmiest/propslab/issues/578)).

eval's `strftime()` formats with the same table. Nothing recorded says what it prints for `%l`, and the existing behaviour is the C one.

## Decision

- The table entry for `%l` parses and formats three digits of milliseconds. That is TIME_FORMAT's reading, and the TIME_FORMAT preview renders with it, so the preview and the parser still agree.
- A table entry may carry an `evalFormat`, which `formatStrftime` uses when eval's `strftime()` calls it with the `eval` dialect. `%l` is the only entry with one, and it keeps the space-padded 12-hour clock.

## Consequences

- ADR 0003's guarantee holds within each dialect, not across them: `%l` reads and renders milliseconds in a TIME_FORMAT and renders an hour in eval.
- eval's `strptime()` is a stub, so there is no eval parsing of `%l` to keep in step.
- If a recording shows eval's `strftime()` printing milliseconds for `%l` too, delete the `evalFormat` and the dialect parameter.
