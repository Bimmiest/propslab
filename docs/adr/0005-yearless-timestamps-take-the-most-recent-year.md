# 0005. A yearless timestamp takes the most recent year it can be, from UTC

- **Status:** Accepted
- **Code:** `parseTimestampDetailed`, `YEARLESS_FUTURE_TOLERANCE_MS` and `YEARLESS_NEXT_YEAR_CHECK_MS` in `src/utils/strftime.ts`

## Context

Syslog's RFC 3164 stamp (`%b %e %H:%M:%S`) has no year, so the parser has to supply one.

- Taking the current year put `Dec 31 23:59:00`, read on 1 January, eleven months in the future ([#356](https://github.com/Bimmiest/propslab/issues/356)).
- The year came from the host's local zone, so the same injected `now` gave different years on different machines ([#356](https://github.com/Bimmiest/propslab/issues/356)).
- Property tests found that a yearless 29 February could land in the future or fail to parse, and that a stamp written in a zone already in the new year was placed a year early ([#371](https://github.com/Bimmiest/propslab/issues/371)).
- `now` is injectable (`PipelineOptions.now`) so that recorded fixtures give the same result in later years ([#293](https://github.com/Bimmiest/propslab/issues/293)).

## Decision

For a format with a month or day but no year or epoch:

1. Start from `now`'s **UTC** year.
2. If the stamp falls no later than `now` plus two days, the `MAX_DAYS_HENCE` default, keep it. Past that tolerance the extractor would reject it anyway. A stamp slightly ahead of the clock, through skew, stays in this year.
3. If the kept stamp is 360 days or more behind `now`, also try next year. UTC offsets reach 14 hours, so a zone east of UTC can already be in next year's 1 January.
4. Otherwise walk back one year at a time, up to eight years, which is far enough to find the previous 29 February (2096 comes before 2104). A stamp that fits none of those years does not parse.

This follows the convention syslog readers use: a date without a year is the most recent one it can be. Splunk's own rule isn't recorded, so this reading comes from convention rather than from Splunk.

A format with no date at all (time only) is a separate case. The caller can supply a date through `dateForDateless` (`DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME`, [#273](https://github.com/Bimmiest/propslab/issues/273)). Without one, the timestamp lands on 1 January of `now`'s year.

## Consequences

- Results depend on `now`. Tests and fixtures pass a fixed `now`.
- Parsing a yearless stamp can try up to ten years' worth of assemblies in the worst case. The tokenised format is cached ([0004](0004-bounded-time-format-cache.md)), so each try is only a regex match.
