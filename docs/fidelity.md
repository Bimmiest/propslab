---
type: reference
---

# Simulation fidelity

The simulation is the [`propslab-engine`](https://github.com/Bimmiest/propslab-engine) package. Its [fidelity.md](https://github.com/Bimmiest/propslab-engine/blob/main/docs/fidelity.md) gives the boundary of the simulation in one place: what it simulates, what it does not simulate on purpose, and where it knowingly diverges from Splunk. If an output looks suspicious, verify it against a real indexer before you rely on it.

This file gives what the app adds to that boundary.

## Settings

- **"Re-match stanzas after metadata rewrites"** (Settings, the gear icon) runs the engine with `perEventPipeline`. A write to `MetaData:Sourcetype` then takes the search-time directives from the new sourcetype. Without it, a warning says that the old match applies. Per-event mode turns on manual apply, to keep the editor responsive.

## Where the app runs a pattern

The engine bounds each match with `MATCH_LIMIT` and `DEPTH_LIMIT`, and the app stops a run after 4 s (`limits.maxRunMs`). A run can go past its budget by one match, so the main thread does not match a user-supplied regex from a directive. These parts run it inside a Web Worker:

- the main pipeline (5 s watchdog)
- the **Regex tab's live tester** and the **Create-EXTRACT dialog's** live capture, which both use the same regex-match worker (2 s watchdog)
- the **Timestamp tab** (2 s)
- the `TIME_FORMAT` hover preview of the editor. Its `TIME_PREFIX` match uses the worker of the Timestamp tab, with 1 s for the match itself. If that worker has not loaded the engine yet, the hover waits for it, and does not blame it. When the limit fires, the hover says "preview timed out". The hover has no inline fallback.

If a regex runs too long, the app stops the Web Worker and starts it again, and the UI does not freeze. The main thread only _compiles_ user patterns, to report syntax errors, and a compile cannot backtrack.

Stanza patterns are the exception. The Effective config and Timestamp tabs resolve stanzas on the main thread. They match the `[source::…]` and `[host::…]` patterns against the one source and the one host in the Metadata dialog, and the engine holds each of these matches to the default `MATCH_LIMIT` and `DEPTH_LIMIT` of Splunk.

The hover also matches one regex on the main thread: the `TIME_FORMAT` side. The app builds this pattern from strptime specifiers, and the user did not write it. It runs against a maximum of 4 KB of the sample line.

## Other

- **Raw data over 1 MB.** The store and the editor accept a larger input in full, and the app sends all of it to the worker. The engine truncates it at the last complete line, and a warning gives the line from which the input was dropped.
- **Time zone of the `TIME_FORMAT` hover.** The hover formats the time in the zone of the browser, as eval `strftime()` does in the engine. The MCP server uses the zone of its Node process. Thus the two can give different output for the same input.
- **Monaco find-widget tooltip flicker.** This is an upstream bug in the hover service of Monaco ([microsoft/monaco-editor#5208](https://github.com/microsoft/monaco-editor/issues/5208)). There is no local fix.
