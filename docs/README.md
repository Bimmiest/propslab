---
type: reference
---

# Documentation

Each topic file in `docs/`, in path order. When you add, rename or remove a
file, change its row here: the docs check fails a file that has no row. The
documents at the root are listed in the [README](../README.md#documentation).

| Document | What it holds |
|---|---|
| [adr/README.md](adr/README.md) | The design decisions, and the reasons for them |
| [architecture.md](architecture.md) | The internals for contributors: the project structure, the store, the workers, the Monaco bundle, accessibility and the tech stack |
| [ci.md](ci.md) | Each CI job, what makes it fail, and how to run it locally |
| [code-style.md](code-style.md) | The rules for the layout, the lint, the types and the code comments |
| [dependencies.md](dependencies.md) | The supply-chain checks, the binary of the regex engine, the overrides and the review of a Dependabot pull request |
| [deployment.md](deployment.md) | The CI jobs, the deploy workflow, the production environment and how to do a rollback |
| [development.md](development.md) | How to set up a checkout, the npm scripts, and what to do if the installation or a test fails |
| [documentation.md](documentation.md) | The classes of documents and their line limits, the topic types, the STE rules and the sections of the README |
| [engine.md](engine.md) | The engine as a library: `PipelineOptions`, layered conf input with override provenance, and the regex engine and its caveats |
| [fidelity.md](fidelity.md) | What Propslab simulates, what it does not simulate, and where it diverges from Splunk |
| [pipeline.md](pipeline.md) | How the simulation runs: the order of the stages, stanza precedence and the eval expression engine |
| [recipes.md](recipes.md) | Where each change goes, the steps for a simulated directive, and the recipes for the common changes |
| [releasing.md](releasing.md) | How to make a release |
| [testing.md](testing.md) | The rules for tests, the unit tests, the end-to-end suite and mutation testing |
| [user-guide.md](user-guide.md) | The app for a user: the layout, the output tabs, the editor and the dictionary |
