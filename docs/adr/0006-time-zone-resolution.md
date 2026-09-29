# 0006. How a timestamp's zone is chosen and resolved

- **Status:** Accepted
- **Code:** `resolveZone`, `resolveTzOffsetMinutes`, `ianaOffsetAt`, `ianaWallClockToEpoch` and `parseTzAlias` in `src/utils/strftime.ts`

## Context

- `TZ` resolved only numeric offsets and a short abbreviation table. Everything else, IANA names included, was treated as UTC without a warning. A browser seemed unable to know a zone's historical offsets ([#159](https://github.com/Bimmiest/propslab/issues/159)). An earlier change had already made an unresolved zone warn instead of failing silently.
- Wall clocks inside a DST gap or overlap resolved correctly east of UTC only. New York's non-existent `02:30` read as 01:30 EST, and Berlin's repeated `02:30` took its second occurrence ([#399](https://github.com/Bimmiest/propslab/issues/399)).
- `TZ_ALIAS` was ignored. It exists because abbreviations are ambiguous: `EST` is Eastern US in one deployment and Eastern Australia in another ([#227](https://github.com/Bimmiest/propslab/issues/227)).
- props.conf.spec writes alias targets in a GMT-relative form (`EST=GMT-5:00`) that the resolver did not accept.

## Decision

- **Precedence.** An explicit numeric offset in the event (`%z`) wins. Next comes a zone name in the event (`%Z`), after `TZ_ALIAS` rewrites it. The stanza's `TZ` comes last. With none of these, the stamp is read as UTC and reported as zoneless.
- **`TZ_ALIAS` rewrites only the zone read from the event,** never the stanza's `TZ`. The user named `TZ` explicitly, and letting an alias redirect it would make an unambiguous setting ambiguous again. The spec doesn't say either way; this is the reading its wording supports. A malformed pair is reported and skipped. An alias whose target doesn't resolve is reported with both halves (`EST (TZ_ALIAS → Middle/Earth)`), because the target alone is a string that appears in nobody's events.
- **GMT-relative offsets use plain arithmetic.** `GMT-5` and `UTC-5:00` mean UTC−5, which is what the spec's example needs. This differs on purpose from the IANA `Etc/GMT-5`, which is UTC+5 under POSIX's inverted sign. A test places the two on opposite sides of UTC.
- **IANA names resolve through `Intl.DateTimeFormat`.** The resolver formats an instant into the zone and measures the wall-clock gap back to UTC. The zone's offsets one day either side of the wall clock bracket any transition, since no offset exceeds 14 hours. Each offset is a candidate that holds if the zone really is at that offset at the instant it gives. A wall clock in a spring-forward gap resolves forward, using the offset before the gap (New York `02:30` → `03:30 EDT`). One in a fall-back overlap resolves to its first occurrence, as most strptime implementations do. Neither rule depends on which side of UTC the zone is.
- **The instant is kept as resolved.** It is not rebuilt from a rounded offset, because historical zones can sit a few seconds off a whole minute.

## Consequences

- IANA resolution depends on the runtime's ICU data. A name the runtime doesn't know is reported as unresolved and read as UTC.
- `%Z` accepts a trailing `:MM` only as part of a GMT-relative name (`GMT+05:30`), so `PST: msg` still reads `PST`.
- The behaviour is covered by a property test over zones in both hemispheres, not by a Splunk capture.
