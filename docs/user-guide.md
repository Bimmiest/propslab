# Using the app

This file describes the app for a user: the layout, the output tabs, the editor and the dictionary. [pipeline.md](pipeline.md) describes what the simulation does with the input.

## Layout

The layout has four parts:

- a header
- an activity rail that shows only icons
- the active view
- a status bar at the bottom.

The rail selects one of two top-level views:

- **Simulator**: two panels, with the inputs on the left and the output on the right. The left column holds Raw log → props.conf → transforms.conf, in a group that you can resize. The **Metadata** button in the Raw log header opens a dialog for the index, the host, the source and the sourcetype. The button shows the sourcetype. A collapsed editor becomes a bar of fixed height at the bottom, so that the resize handle can use its space. Below each editor, the footer shows the line and the column of the cursor, and the length of the selection. The column counts characters. The raw log footer also shows the column in bytes, because `TRUNCATE` counts bytes.
- **Dictionary**: a reference that you can browse, for each directive and each stanza kind ([Dictionary](#dictionary)).

The two views stay mounted. The app shows one of them with `hidden`, and does not render them conditionally. Thus, when you go to the dictionary and back, Monaco keeps its undo history, cursor and folding state. The output filters also stay as they were. An `ErrorBoundary` wraps each major panel.

Below 768px, the labelled tab strip of `MobileShell` replaces the rail. The rail shows its labels only in hover tooltips, and a touch screen cannot open a hover tooltip.

**Keyboard:** `Ctrl/Cmd+K` opens the command palette. The palette has four groups: Examples, Navigate, Look up (for a directive) and Actions. The header info button (ⓘ) opens a slide-out reference to the 11 pipeline stages.

**Status bar:** the status bar shows these items:

- the worker status
- the time that the pipeline took
- the event count
- the count of distinct fields
- the error and warning counts
- a "Per-event pipeline" chip, when that setting is on
- the version. Select it to open the About dialog. The dialog shows the build and the date of its commit, and has links to the source code, the changelog and the issue tracker. Use its **Copy** button to put the version and the build in a bug report.


## Examples

The **Examples** button in the header opens the example library, which groups the examples by the kind of data source. The empty output has the same button, and the command palette lists the examples too. If you edited the inputs, the app asks before an example replaces them. Each example loads a raw log, its metadata, `props.conf` and `transforms.conf`, and shows a different part of the pipeline. The data is invented: the addresses are documentation or private ranges, and the domains are `example.com`. The configurations are written from the `.spec` files.

| Example | Sourcetype | What it shows |
|---|---|---|
| Apache Access Log | `access_combined` | `EXTRACT`, a `REPORT` transform on an extracted field, `EVAL`, and aliases for the CIM Web model |
| Palo Alto Firewall | `pan:traffic` | One `REPORT` regex over a CSV-like line, `FIELDALIAS` and `EVAL` for the CIM Network Traffic model |
| Linux SSH Auth | `linux_secure` | A syslog timestamp with no year, and `EXTRACT` and `EVAL` for the CIM Authentication model |
| Windows Security (XML) | `XmlWinEventLog:Security` | `KV_MODE = xml`: each named `Data` element is a field, and `Data_Name` is multivalue |
| AWS CloudTrail (JSON) | `aws:cloudtrail` | `INDEXED_EXTRACTIONS = json`, with the timestamp from `TIMESTAMP_FIELDS` |
| Cisco ASA | `cisco:asa` | `REPORT` transforms that read the ASA message ID, for the CIM Network Traffic model |
| Java App (Multi-line) | `java:app` | A `LINE_BREAKER` with a lookahead, so that a stack trace stays with its event |
| CSV Export | `vpn:sessions:csv` | `INDEXED_EXTRACTIONS = csv` for a file with no header row, with the columns named by `FIELD_NAMES` |
| FortiGate Traffic | `fgt_traffic` | `KV_MODE = auto` for `key=value` pairs, with aliases for the CIM Network Traffic model |

The examples are dated October 2026. Until 2032 they are inside the default `MAX_DAYS_AGO` of 2000 days, so they load with no warning.
## Output tabs

**Top-level tabs:** Preview, CIM Models, Fields, Pipeline, Effective config, Architecture.

**Preview sub-tabs**, in this order: Raw → Timestamp → Extractions → Diff → Regex.

| Sub-tab | Shows |
|---|---|
| Raw | The events after line breaking and event breaking, with line numbers and timestamp regions. A truncated event has a `Truncated` badge. A copy that `CLONE_SOURCETYPE` makes has a `Cloned from <sourcetype>` badge. You can expand and collapse a long event. |
| Timestamp | For each event: the prefix that matched, the format pattern, and the parsed `_time`. |
| Extractions | The field extractions, inline in `_raw`. Each extraction has a class: auto (KV_MODE / INDEXED_EXTRACTIONS), manual (EXTRACT / REPORT / TRANSFORMS / SEDCMD) or calc (EVAL). The filter pills are `Auto / Manual / Calculated / All`. A sidebar that you can collapse has search, hover-focus and pin-to-filter. |
| Diff | A character-level unified diff of the original raw data and the processed `_raw`. |
| Regex | An interactive regex tester for the event text. It shows only the matches. When you enter no pattern, it shows an empty-state prompt. `Add to props.conf` upserts the `EXTRACT-` line that you built into the sourcetype stanza of the event. If the event has no sourcetype, the button writes a placeholder stanza *and* points the metadata to it. The event cannot match a stanza without this change, and such a stanza is a scaffold that does nothing. The panel says this before you click. |

**Field highlights.** A highlight uses the authoritative byte offsets that the extraction recorded, when they exist. These offsets exist for positional EXTRACT captures against `_raw`. For EVAL-computed, aliased, JSON-flattened and KV-mode fields, the highlight uses a context-aware match instead: `"key":"value"`, `key="value"`, `key: value` or `key=value`. A value of one character gets a highlight only when the context-aware match succeeds. Without this rule, a plain substring search for `"0"` highlights the whole event.

**Fields tab.** This tab lists each extracted field, with its phase (index-time or search-time) and the processors that made it. The filter pill is `All / Index-time / Search-time`.

**TIME_FORMAT preview.** When you hover over a `TIME_FORMAT` value, the editor does three things:

- It renders the current time with that pattern.
- It tries the pattern against the first line of the loaded raw data. It obeys `TIME_PREFIX`, and it anchors after it exactly as the engine does.
- It names each specifier that the simulator does not implement.

The strftime completions show the same rendered time. Thus you can choose between five opaque token strings when you see what each one makes. An unsimulated specifier also gets an informational marker in the editor. The config can be correct for a real indexer, but this preview does not resolve `_time` from it.

**"Did not fire".** This list appears in the Pipeline and Extractions tabs when a directive ran against the loaded events and changed nothing. Without the list, the preview shows this failure as a usual event that did not change. Each row gives the directive, the number of events that it had no effect on, and the reason. The reason is one of these:

- The transforms stanza that it references is not defined.
- Its pattern did not compile.
- Its `SOURCE_KEY` was empty.
- The pattern did not match. The row gives the character where the match stopped.
- The fields that it makes were already set.
- The pattern matched, but it has no named capture group, or none of its named groups took part in the match.
- An `EVAL` expression evaluated to null.

The list covers `EXTRACT`, `TRANSFORMS`/`REPORT`, `SEDCMD`, `FIELDALIAS` and `EVAL`. When you click the line reference, the editor moves to that line.

**Effective config tab.** This tab shows what `splunk btool props list <sourcetype> --debug` prints, resolved for the metadata that you configured. It shows these items:

- each directive that applies
- the stanza that the directive won from
- the definitions that the directive beat, in stanzas of lower precedence. You can expand each row to see them.

When you click a line reference, the props.conf editor moves to that line. `Show contested only` shows only the keys that two or more matched stanzas define. Precedence surprises occur in these keys. The tab resolves the configuration, not the output. Thus it gives an answer before Propslab processes any data.

**CIM Models tab.** This tab validates the extracted fields against 27 CIM datasets:

- Alerts
- Authentication
- Certificates
- Change
- Data Access
- Databases
- DLP
- Email
- Endpoint (Filesystem, Ports, Processes, Registry, Services)
- Event Signatures
- Interprocess Messaging
- Intrusion Detection
- Inventory
- JVM
- Malware
- Network Resolution (DNS)
- Network Sessions
- Network Traffic
- Performance
- Ticket Management
- Updates
- Vulnerabilities
- Web

These items all come from the model JSON in the CIM add-on of Splunk (`Splunk_SA_CIM` **8.5.0**):

- the field lists
- the split into required and recommended fields
- the constraint tags.

The header of `src/engine/cim/cimModelsData.ts` gives the exact rules for this derivation. There is one entry for each CIM *root dataset*. Endpoint has five root datasets and no model-wide `tag=endpoint`, so it appears five times. Three models declare no key fields in the CIM: Databases, JVM and Interprocess Messaging. Their required score shows `n/a`, not a 100% that means nothing.

## Monaco editor

The editor has a custom language, `splunk-conf`:

- A Monarch tokenizer. A `\` line continuation keeps the context of the parent directive (eval, regex, alias values), with dedicated continuation states.
- Autocomplete: directive keys at the start of a line, enum/boolean/strftime values after `=`, and stanza types inside `[`.
- Hover tooltips in rich Markdown: description, default, example, category, phase, value type and valid values.
- Folding for stanzas and for consecutive comments.
- Lint markers through `setModelMarkers`: unknown directives, invalid regex, type mismatches, duplicate stanzas, a stanza header without its `]`, and best-practice warnings.
- Light and dark themes (`splunk-light`, `splunk-dark`) that use the same charcoal, sand and gold colours as the app.

`directiveRegistry.ts` drives all three features. When you add a `DirectiveInfo` entry, autocomplete, hover and lint use it automatically, and so does the dictionary. [architecture.md](architecture.md#monaco-bundling) describes how Monaco is bundled:

- the slim `monaco-editor/editor` entry
- the hand-picked `features/*/register` contributions
- the lazy load and the `codeSplitting` group around it.

## Dictionary

The dictionary is a reference view. It has each `props.conf` and `transforms.conf` setting that the simulator knows, and the four kinds of stanza header. In the dictionary, you can do these things:

- Search by key or by description.
- Filter by phase (index-time / search-time) and by conf file.
- Hide deprecated keys.
- Read the description, example, default, valid values and pipeline stage of each entry.

Each row in the browse list shows two designations: the conf file that it belongs in, and the phase that it runs at. Thus you know both before you open the entry. The designations also show the difference between the two entries of `MATCH_LIMIT`, and between the two entries of `DEPTH_LIMIT`. The registry defines each of these two keys one time for each conf file, with text for that file.

The dictionary has no text that the editor does not also have. Its entries come from `directiveRegistry.ts` and `stanzaRegistry.ts`, so the dictionary and the hover tooltips cannot become different. The pipeline reference drawer and the dictionary answer different questions. The drawer answers "what runs when", and the dictionary answers "what does this key do". Each one links to the other.

You can open the dictionary in three ways:

- from the activity rail
- with `Ctrl/Cmd+K` → "Dictionary: KEY"
- with the "Open in dictionary" link at the bottom of a directive hover.
