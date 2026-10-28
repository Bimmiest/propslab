<p align="center">
  <img src="docs/assets/banner.svg" alt="Propslab" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Bimmiest/propslab/actions/workflows/ci.yml"><img src="https://github.com/Bimmiest/propslab/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="https://github.com/Bimmiest/propslab/actions/workflows/security.yml"><img src="https://github.com/Bimmiest/propslab/actions/workflows/security.yml/badge.svg" alt="Security status"></a>
  <a href="https://scorecard.dev/viewer/?uri=github.com/Bimmiest/propslab"><img src="https://api.scorecard.dev/projects/github.com/Bimmiest/propslab/badge" alt="OpenSSF Scorecard"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-MIT-blue" alt="Licence: MIT"></a>
</p>

# Propslab

Propslab is a browser-based simulator of the Splunk pipeline that applies `props.conf` and `transforms.conf`.

> **Not a Splunk product.** Propslab is an independent project. Splunk Inc. and
> Cisco Systems, Inc. do not endorse or sponsor Propslab, and Propslab has no
> affiliation with them. Splunk is a registered trademark of Splunk Inc. This
> project uses the name only to describe what the simulator models. The
> [NOTICE](NOTICE) file gives the attribution for the third-party material that
> this project derives data from.

## Highlights

- **See the result of a config before you deploy it.** The preview shows the events, the timestamps and each extracted field, while you type.
- **The same regex engine as Splunk.** Each pattern runs on PCRE2, compiled to WebAssembly, and not on a JavaScript translation of it.
- **Answers to "why".** "Did not fire" names each directive that changed nothing, and the reason. The Effective config tab shows what `btool --debug` prints.
- **No data leaves your browser.** Propslab has no backend, it makes no network calls, and it does not store user data.
- **An MCP server.** An LLM agent can run a config against real sample data, and it does not have to guess.

## Overview

You give Propslab a raw log, its metadata, a `props.conf` and a `transforms.conf`. Propslab divides the log into events, and runs the 11 stages of the pipeline in the order that Splunk uses. It resolves stanza precedence as Splunk does. The output tabs show the events, the timestamps, the extracted fields, a diff of `_raw`, the CIM coverage and the effective configuration. All of the simulation runs in the browser.

**Maturity.** Propslab is at version 1.3.0 ([CHANGELOG](CHANGELOG.md)). Each commit on `main` that passes CI goes to production. Each directive that the registry knows has one of three support levels. [`src/engine/directiveSupport.ts`](src/engine/directiveSupport.ts) declares them:

| Level | Count | What it means |
|---|---|---|
| **simulated** | 77 | The engine implements it, and tests assert the behaviour. |
| **documented** | 72 | Recognised on purpose, and outside the simulation for a reason that does not change. It belongs to a layer that a browser cannot access, or it has no observable effect on the output. |
| **ignored** | 0 | Must be simulated, but is not yet. Its entry names the issue that tracks it. Each one of these is a known wrong answer. |

A test asserts the counts against the table itself, so they cannot become incorrect. **0** attributes are valid in Splunk 10.4.3 and absent from the registry.

**What it is not.** Propslab is not Splunk, and it does not prove that a config is correct. It does not simulate lookups, the forwarder and input layers, or segmentation. Propslab does not distribute recorded outputs from Splunk Enterprise, so the engine tests assert against the documentation ([ADR 0016](docs/adr/0016-recorded-splunk-output-is-not-distributed.md)). If an output looks suspicious, verify it against a real indexer before you rely on it. [Simulation fidelity](docs/fidelity.md) gives the full boundary.

## Demo

![Propslab with the Palo Alto Firewall example loaded. The left column holds the raw log, props.conf and transforms.conf. The Raw Log header shows the sourcetype, pan:traffic, and its footer shows the format of the data, CSV, and the cursor position. The Extractions tab on the right highlights the extracted fields in each event, and lists the 18 fields in a sidebar.](docs/assets/demo.png)

The bundled Palo Alto Firewall example: the Extractions tab highlights each extracted field in `_raw`. Eight more examples cover other data sources ([user guide](docs/user-guide.md#examples)).

## Usage

Open [propslab.vero-labs.net](https://propslab.vero-labs.net), or run the app locally ([Installation](#installation)). Then:

1. Click an example, or paste a raw log into the Raw log panel.
2. Set the metadata: click **Metadata** in the Raw log header, and enter the index, the host, the source and the sourcetype.
3. Write your stanzas in the `props.conf` and `transforms.conf` editors.
4. Read the result in the Output panel. By default, each change runs the pipeline again.

`Ctrl/Cmd+K` opens the command palette. [docs/user-guide.md](docs/user-guide.md) describes each part of the app.

### MCP server

[`packages/mcp-server`](packages/mcp-server) is an MCP server over the same engine. It has four tools: `simulate`, `validate`, `explain_precedence` and `lookup_directive`. With these tools, an LLM agent can run a config against real sample data, and it does not have to guess. The server obeys the rules for untrusted regexes that [docs/engine.md](docs/engine.md) gives. Each engine run occurs in a worker thread that the server can stop, within a wall-clock budget.

To build the server and add it to Claude Code, run these commands from the root of a clone:

```bash
npm ci --prefix packages/mcp-server && npm run build --prefix packages/mcp-server
claude mcp add propslab -- node "$PWD/packages/mcp-server/dist/index.js"
```

For Claude Desktop or another client, put the same command in the `mcpServers` object of its JSON configuration. The [README of the server](packages/mcp-server/README.md#setup) gives an example.

## Installation

Requirements: Node, at the version in [`.nvmrc`](.nvmrc), npm and Git.

```bash
git clone https://github.com/Bimmiest/propslab.git && cd propslab
nvm use        # or: fnm use
npm ci
npm run dev    # http://localhost:5173
```

To make the production build in `dist/`, run `npm run build`. [docs/development.md](docs/development.md) lists all of the scripts, and tells you what to do if the installation or a test fails.

## Documentation

The topic files are listed in [docs/README.md](docs/README.md). The documents
outside `docs/`:

- [packages/mcp-server/README.md](packages/mcp-server/README.md) — The MCP server: its tools, its setup and its security model
- [CONTRIBUTING.md](CONTRIBUTING.md) — The rules for a change: issues, branches, commits, pull requests and releases, with a link to the detail of each area
- [CHANGELOG.md](CHANGELOG.md) — What changed for a user, newest first
- [SECURITY.md](SECURITY.md) — How to report a vulnerability, and the attack surface
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — The Contributor Covenant

## Contributing and feedback

To report a bug or to suggest a change, open an [issue](https://github.com/Bimmiest/propslab/issues/new/choose). If the output is different from what real Splunk does, use the Fidelity question form. Before you open a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md). It gives the rules for a change, and a link to the file in `docs/` that has the detail of each area.

## Licence

[MIT](LICENSE). The [NOTICE](NOTICE) file gives the attribution for the third-party material that this project derives data from.
