# Capturing fidelity fixtures

The engine's other tests assert it against *our reading* of Splunk's docs. That
catches regressions but cannot catch a misreading, because the implementation
and the test encode the same assumption. The fixtures under
`src/engine/__tests__/fixtures/splunk-<version>/` are the only assertions in the
repository derived from Splunk itself.

Capture is a deliberate, occasional, human-run step — normally once per Splunk
version you want to pin. **CI never runs this script and never contacts
Splunk**; it asserts against the committed JSON, which is what makes the test
suite hermetic and fast.

## Before you run it: the licence question

The instance is yours, and so are its licence terms — this repository ships no
Splunk software and cannot grant you any right to it. Read this section before
deciding whether to run the script at all.

**The Splunk General Terms do not permit a capture.** Splunk Enterprise Free and
the `splunk/splunk` container are licensed under the
[Splunk General Terms](https://www.splunk.com/en_us/legal/splunk-general-terms.html)
— the 10.x container images require accepting them at start-up — and section
1.2 of those terms, as last updated in May 2026, restricts what a licensee may
do with the software. Two clauses reach what this script does:

- **1.2(vii)** prohibits using an Offering "in order to analyze, test,
  characterize, inspect, or monitor its source code or underlying structures,
  ideas, protocols, or algorithms it contains or uses". Recording how a props
  stanza turns an input line into fields is a characterisation of behaviour on
  the strict reading of those words. There is an argument that observing the
  documented configuration surface is ordinary use rather than characterising
  algorithms, but it is an argument, not a settled point.
- **1.2(vi)** prohibits using an Offering "to develop, test, troubleshoot,
  support, or market any software or service that ... integrates,
  interoperates with, or constitutes an extension of any Offering and that you
  use or intend to use for a commercial purpose". Running captures to test a
  tool you use commercially is inside those words.

An earlier version of this guide named the free edition and the container as
"the intended target". That was wrong: neither entitles you to run this.
**Run the capture only under a licence or written consent that permits it** —
a developer-programme or partner agreement whose scope covers testing software
that interoperates with Splunk, or an instance whose owner has agreed in
writing. If you have neither, do not run it. Assert the behaviour against the
documentation instead and say so in the test, which is what CONTRIBUTING asks
for.

Two further things hold whichever licence you have:

- **What is captured is functional behaviour only** — how a given props.conf
  turns a given input line into events and fields. The fixtures hold no timing,
  throughput, or resource figures, and this project publishes no benchmark or
  comparative evaluation of Splunk software. Keep it that way if you extend the
  corpus: section 1.2(v) separately restricts analysing or characterising an
  Offering's performance for competitive purposes.
- **Don't point it at a production deployment**, and don't point it at an
  employer's or a client's instance without their say-so — the capture writes
  conf stanzas and restarts splunkd on whatever you point it at.

**The fixtures already committed** were observed on Splunk Enterprise 10.4.0;
the version and build are in each `manifest.json`. Section 18.2 of the General
Terms states that "you own any reporting results that you or your Third Party
Providers may derive from Customer Content through the use of the Offerings",
and each fixture is exactly that: Splunk's output over input lines this project
supplied. They are kept as regression pins for behaviour the documentation gets
wrong, and they are not being re-captured.

## What you need

A Splunk Enterprise instance you can restart. The volumes involved are tiny, so
no paid licence tier is needed for the capture itself.

1. **A service account with a token.** Enable token authentication
   (Settings → Tokens) and issue a token for a dedicated capture user. The
   capture needs `admin_all_objects` (writing conf stanzas over REST),
   `restart_splunkd`, and `search`; add `indexes_edit` if you want it to create
   the index. The `admin` role covers all of these.
2. **An index** for the captured events. Defaults to `fixtures`; override with
   `SPLUNK_INDEX`.
3. **Reachable management port**, normally 8089. HEC is *not* used — ingest goes
   through `/services/receivers/stream` on the management port, so there is no
   need to enable the collector or open 8088.
4. **The CA certificate**, or an explicit acknowledgement that you are accepting
   a self-signed one.

## Running it

```bash
export SPLUNK_MGMT_URL=https://splunk.example.internal:8089
export SPLUNK_TOKEN=<token>
export SPLUNK_CA_CERT=/path/to/ca.pem   # or SPLUNK_INSECURE=1

node scripts/capture-fixtures.ts
```

No connection details are stored in this repository, and none are baked into
the script — it exits if they are unset. Keep the token in your OS keyring and
export it at the point of use rather than writing it to a file.

Useful flags:

| Flag | Effect |
| --- | --- |
| `--dry-run` | List the cases that would be captured; contacts Splunk only for its version. |
| `--only <case-id>` | Capture one case. Leaves `manifest.json` alone so a partial run cannot shrink it. |
| `--skip-restart` | Skip the restart. **Index-time results will reflect the previously loaded config.** |
| `--config-only` | Write and reload the stanzas, then stop before ingesting. Stages config for a later `--reuse-config` run. |
| `--reuse-config` | Ingest and search against stanzas a previous run already wrote, identified by `SPLUNK_RUN_ID`. Implies `--skip-restart`. |

A normal run writes the stanzas, restarts splunkd once, then ingests and
searches every case, batching everything around a single restart rather than
one per case.

### The restart is usually avoidable

Splunk's documented guidance is that index-time settings require a restart,
because the parsing pipeline consults them at ingest. That holds for changing a
sourcetype splunkd has *already* loaded — but every sourcetype this script
creates is new, and for those a config reload is enough. Verified on 10.4.0:
after `--config-only`, a `MAX_EVENTS = 3` stanza took effect on first ingest
with no restart, where the default config would have merged the input into a
single event.

So the low-impact way to run this against an instance you would rather not
bounce is two steps:

```bash
SPLUNK_RUN_ID=$(date +%s) node scripts/capture-fixtures.ts --config-only
SPLUNK_RUN_ID=<same value> node scripts/capture-fixtures.ts --reuse-config
```

Restarting is still the guaranteed-correct path, and remains the default. Reach
for the two-step form when the instance is shared or slow to come back — and be
aware that restarting a small VM repeatedly in quick succession can leave
splunkd wedged, which is the failure this avoids.

## What lands in a fixture

Per event: `_raw`, `_time` as epoch milliseconds, and the extracted fields.
That is the engine's comparable surface. Event *count* is asserted too — most
line-breaking bugs surface as a count mismatch before anything else.

Excluded from every fixture, and listed in `manifest.json` so the omission stays
visible:

- **Non-deterministic per capture**: `_indextime`, `_bkt`, `_cd`, `_serial`.
- **Instance-identifying**: `splunk_server`, `index`, `host`, `source`. Ingest
  pins `host` and `source` to constants, so nothing about the capturing
  instance reaches the fixture even before this filter.
- **Splunk-generated, not modelled by the engine**: `punct`, `linecount`,
  `date_*`, `timestartpos`, `timeendpos`, `timestamp`.

Because `host`, `source`, `sourcetype` and `index` are excluded, a case must not
use those names for extracted fields — the field would be dropped rather than
compared. `timestamp-prefix-and-format` uses `server=` for exactly this reason.

## Writing a case

Add it to `src/engine/__tests__/fixtures/corpus.ts`. Keep it minimal: a case
exercising one directive tells you which directive is wrong when it fails, while
a realistic multi-directive log sample tells you nothing.

Two rules that exist because breaking them produces fixtures that rot silently:

- **Set `TZ = UTC`** in any case that parses a timestamp. Otherwise the captured
  `_time` depends on the capturing instance's timezone.
- **Give every event a fully-qualified timestamp**, including the year. Splunk
  infers a missing year, and a missing timestamp entirely, from the clock at
  ingest — so the fixture encodes the moment it was captured and never
  reproduces again.

A case cannot be added ahead of its capture: `splunkFidelity.test.ts` asserts
that every corpus case has a fixture, so an uncaptured case fails the suite. That
is deliberate — it keeps the corpus meaning "measured against Splunk" rather than
"intended to be". Cases written before a capture round is possible are parked
below until someone with an instance can run one.

## Queued for the next capture

`eval-null-in-function-args`, for [#211](https://github.com/Bimmiest/propslab/issues/211).
The engine now propagates null through function arguments, but that is asserted
only against our reading of the docs — `eval-null-propagation` pins the operators
and nothing pins the functions. Search-time, `EVAL` and `TZ`:

```
EVAL-ulen = len(user)
EVAL-uupper = upper(user)
EVAL-ucoalesce = coalesce(user, "anonymous")
EVAL-uempty = len(empty)
```

Input needs one event carrying `user`, one without it, and one where `user` is
present but empty — the third is what separates "absent" from "empty", which is
the whole distinction the fix turns on. Expect `ulen` and `uupper` absent on the
event with no `user`, `ucoalesce` set on every event, and `uempty` = 0.

`timestamp-fallback-chain` and `timestamp-sanity-bounds`, for
[#85](https://github.com/Bimmiest/propslab/issues/85). The fallback chain and the
`MAX_DAYS_*` / `MAX_DIFF_SECS_*` bounds are implemented from the spec's
documented defaults and wording; nothing measures them. These are the two cases
in the queue most worth capturing, because a bound whose comparison is against
the wrong reference — the clock rather than the previous event — produces
plausible output in every test we can write ourselves.

Index-time, needs `TZ = UTC`. For the chain, three events: one with a parseable
timestamp, one with none (expect it to inherit), and a leading one with none
(expect index time). For the bounds, a `MAX_DAYS_HENCE = 2` stanza and an event
dated a year ahead — the question the capture answers is whether Splunk falls
back to the previous event's `_time` or to index time, and whether
`MAX_DIFF_SECS_AGO` is really measured against the previous event.

`datetime-config-current` and `datetime-config-none` are worth capturing in the
same round, though the browser cannot reproduce index time exactly — assert that
`_time` is *not* the date in the event text rather than its precise value.

`clone-sourcetype`, for [#87](https://github.com/Bimmiest/propslab/issues/87).
Index-time. A stanza with `CLONE_SOURCETYPE`, and a second props stanza for the
cloned sourcetype that extracts a field the original does not — so the capture
pins both that the copy is emitted and that it is processed under its new
sourcetype's props rather than the original's. Worth asking of the instance
rather than the docs: whether the clone keeps the original's already-extracted
index-time fields, and the order the pair comes back in.

## When a fixture disagrees with the engine

That is the point of the exercise; those failures are the bug list that is
invisible today. Fix the engine, or set `knownMismatch` on the case to the
tracking issue. A case with `knownMismatch` inverts its assertion: it fails once
the engine *starts* matching, which is the prompt to remove the marker and let
the real assertion stand.

## Bumping the Splunk version

Point the environment at the new instance and re-run. Fixtures are written to a
new `splunk-<version>/` directory; the suite asserts against every directory it
finds, so keeping the old one is a valid choice while you work through
differences. Record the version in the release notes alongside the support
boundary.

## Stanza precedence, as measured

The precedence cases resolve a directive defined in several matching stanzas at
once, using a `SEDCMD` whose replacement text names the winner. Measured on
10.4.0:

- `source::` beats `sourcetype`
- `host::` beats `sourcetype`
- `source::` beats `host::`
- an exact `source::` beats a wildcarded one
- **matching stanzas merge attribute by attribute** — a stanza that loses on one
  directive still contributes directives the winner is silent about

The last is the one worth internalising: losing a precedence contest does not
discard the rest of the stanza. `precedence-merged-not-replaced` pins it by
having the winning `source::` stanza supply `SEDCMD` while the losing
`sourcetype` stanza supplies `TRUNCATE`, and observing both take effect.

Cases that need this write their stanzas via `extraProps` and set `ingestSource`
/ `ingestHost` so the stanza has something to address. That is also why searches
scope on `_index_earliest` rather than a marker in `host` or `source` — those
two fields have to stay under the corpus's control.

## Notes on Splunk's REST API

Behaviour verified against Splunk 10.4.0. These are all silent failures rather
than errors, and each one cost a debugging cycle:

- `latest_time` rejects bare epoch integers with "latest_time must be after
  earliest_time", and rejects ISO-8601 outright, while `earliest_time` accepts
  epoch `0`. A relative modifier (`+10y`) is the form that works for `latest`.
- A field whose name begins with `_` is internal and is stripped from results.
  An `eval __epoch = _time` therefore yields no field at all, and every `_time`
  in the fixture comes back null.
- The export endpoint omits search-time-discovered fields unless the search
  references them. Without a trailing `| fields *`, every fixture records an
  empty field set while extraction is working perfectly.
- `_cd` is present on every returned result but is *not* readable by `eval`;
  `eval x = _cd` yields null, and sorting on that null silently drops every
  event. Order results on the parsed `_cd` values instead.
- splunkd answers `/services/server/info` for several seconds after accepting a
  restart, so polling for a response returns immediately against a server that
  is about to go down. Wait for `startup_time` to change instead.
