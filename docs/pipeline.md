---
type: explanation
---

# How the simulation runs

This file describes how Propslab runs a simulation: the path of the input, the order of the stages, stanza precedence and the eval expression engine. [architecture.md](architecture.md) describes the internals for contributors.

## From the input to the output

The input has four parts: the raw log, the metadata, `props.conf` and `transforms.conf`. All of the input goes through one Zustand store. `useProcessingPipeline` debounces each change for 300 ms. Then it posts a request to a Web Worker, which runs the full simulation, and it writes the result back to the store. A 5 s watchdog stops a worker that hangs. When the worker starts again, the watchdog sends the last request that had no answer.

`safeProcessor()` wraps each processor. If a processor fails, `safeProcessor()` records a diagnostic, and the pipeline does not crash. Only the events that the processor failed on go through that stage without change. Some stages read across events, for example line breaking and timestamp extraction. If one of these stages fails, all of the events go through it without change.

[adr/](adr/README.md) records the design decisions and the reasons for them.

## Order of the stages

The pipeline runs its stages in the order that Splunk uses.

**Pipeline stages**

1. Line breaking: `LINE_BREAKER`, `SHOULD_LINEMERGE`, `BREAK_ONLY_BEFORE`, `MUST_BREAK_AFTER`, `MAX_EVENTS`
2. Truncation: `TRUNCATE`
3. Timestamp extraction: `TIME_PREFIX`, `TIME_FORMAT`, `MAX_TIMESTAMP_LOOKAHEAD`, `TZ`, `DATETIME_CONFIG`, and the sanity bounds (`MAX_DAYS_AGO`, `MAX_DAYS_HENCE`, `MAX_DIFF_SECS_AGO`, `MAX_DIFF_SECS_HENCE`)
4. Indexed extractions: `INDEXED_EXTRACTIONS` (json, csv, tsv, psv, w3c)
5. Sed commands: `SEDCMD-<class>`
6. Transforms: `TRANSFORMS-<class>`. Regex routing and `INGEST_EVAL` run interleaved, in the list order of `TRANSFORMS-<class>`. The class names apply in ASCII order.
7. Field extraction: `EXTRACT-<class>`
8. Report transforms: `REPORT-<class>`
9. KV mode: `KV_MODE` (auto, auto_escaped, json, xml, multi). This stage runs *after* `REPORT`, as Splunk documents.
10. Field aliases: `FIELDALIAS-<class>`
11. Eval: `EVAL-<class>`

## Stanza precedence

The order of precedence is `[source::<pattern>]` > `[host::<pattern>]` > `[<sourcetype>]` > `[default]`. Within one type, `priority` decides. If two stanzas have the same priority, the name that is first in ASCII order wins. A more specific pattern gets no preference ([#443](https://github.com/Bimmiest/propslab/issues/443)). The directives from all of the stanzas that match merge in the order of precedence.

A `host::` pattern is a PCRE regular expression. It matches against the whole host name. The match ignores case, unless the pattern contains `(?-i)`.

A `source::` pattern that contains `*` or `...` is also a regular expression, and case is significant. Propslab compares a `source::` pattern without `*` or `...` with the source exactly as written. Such a pattern matches nothing if it contains `|` ([#442](https://github.com/Bimmiest/propslab/issues/442)). In the regular expression, `...` matches anything, `*` matches anything except a path separator, and `.` matches a period.

The engine also accepts layered conf input (`default/` + `local/`), and it returns the full override provenance. These are the two halves of what `btool … --debug` prints. This is engine API only, and the UI of the app does not give access to it. [engine.md](engine.md) describes it.

## Eval expression engine

[`src/engine/processors/eval/`](../src/engine/processors/eval/) has a full tokenizer and a recursive-descent parser. The files are `tokenizer.ts`, `parser.ts` and `evaluator.ts`, and `builtins.ts` holds the function library.

**Operators:** `+`, `-`, `*`, `/`, `%`, `.` (concat), `==`, `=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `NOT IN`.

**50+ functions:**

| Category | Functions |
|---|---|
| Conditional | `if`, `case`, `coalesce`, `nullif`, `validate` |
| String | `lower`, `upper`, `len`, `substr`, `replace`, `trim`, `ltrim`, `rtrim`, `urldecode`, `split` |
| Type | `tonumber`, `tostring`, `typeof`, `isnull`, `isnotnull`, `isint`, `isnum` |
| Math | `abs`, `ceiling`/`ceil`, `floor`, `round`, `sqrt`, `pow`, `log`, `ln`, `exp`, `pi`, `min`, `max`, `random`, `sigfig`, `exact` |
| Multivalue | `mvcount`, `mvindex`, `mvfilter`, `mvappend`, `mvdedup`, `mvsort`, `mvzip`, `mvfind`, `mvjoin` |
| Crypto | `md5`, `sha1`, `sha256`, `sha512` (stub placeholders) |
| Time | `now`, `time`, `strftime`, `strptime`, `relative_time` |
| Comparison | `like`, `match`, `cidrmatch`, `searchmatch` |

For each event, the engine evaluates all of the expressions before it applies any of them. This agrees with the semantics of Splunk.

[fidelity.md](fidelity.md#stubbed-eval-functions) names the eval functions that are stubs.
