# 0003. Parsing, formatting and linting of strftime formats read one directive table

- **Status:** Accepted
- **Code:** `buildDirectiveMap`, `directiveAt`, `formatStrftime`, `supportedSpecifiers` and `formatSpecifiers` in `src/utils/strftime.ts`

## Context

Several places read strftime formats: `TIME_FORMAT` parsing, eval `strftime()`, the editor's `TIME_FORMAT` preview and lint, and the Timestamp tab's format breakdown and strptime reference. They drifted apart:

- eval `strftime()` and the preview printed `%N`, `%9N`, the `%Q` family, `%k`, `%l`, `%f`, `%:z` and `%::z` as literal text, although the parser read all of them.
- The linter flagged `%:z`, `%::z`, `%3Q`, `%6Q` and `%9Q` as unsupported although they worked.
- `%j` counted local midnights and divided by 24 hours, so after a DST change it came out a day short. ([#429](https://github.com/Bimmiest/propslab/issues/429))
- The Timestamp tab's breakdown tokenised formats itself. It missed `%j`, `%k`, `%N`, `%Q` and `%:z`, read `%%Y` as a year, and described `%Q` as epoch milliseconds ([#457](https://github.com/Bimmiest/propslab/issues/457)).

## Decision

- One table (`DIRECTIVE_MAP`) holds, for each directive, the regex fragment that parses it, the capture it fills, and the function that formats a `Date` into it. Parsing and formatting can't disagree about a directive, because both come from the same entry.
- One tokeniser (`directiveAt`, longest match first, so `%::z` beats `%:z` and `%3N` beats `%`) walks formats for parsing, formatting, the linter (`unsupportedSpecifiers`) and the Timestamp tab (`formatSpecifiers`).
- `supportedSpecifiers()` is derived from the table plus the composites `%T` and `%F` and the `%%` escape. It is not a separate list.
- Formatting lives in `strftime.ts` rather than `evalProcessor`, because the editor preview needs the same rendering.
- `%j` counts calendar days between dates, not elapsed time.

## Consequences

- Adding a directive means adding one table entry with both a parser and a formatter. The linter, the reference and the breakdown pick it up.
- Formatting uses the browser's local zone. Splunk uses the indexer's configured zone. This is a documented divergence.
- A `Date` holds milliseconds, so fraction digits past the third always format as zero.
