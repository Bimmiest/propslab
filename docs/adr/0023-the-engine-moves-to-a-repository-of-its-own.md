# 0023. The engine moves to a repository of its own, released by tag

- **Status:** Accepted
- **Date:** 2026-11-11
- **Issue:** [#870](https://github.com/Bimmiest/propslab/issues/870)
- **Code:** `src/engine/`, `src/utils/splunkRegex.ts`, `src/utils/strftime.ts`, `src/utils/regexSyntax.ts`, `src/utils/redosHeuristic.ts`, `packages/mcp-server/`, and the copies of the engine in propslab-sb and propslab-ent

## Context

The engine is the simulator: it reads props.conf and transforms.conf and runs the pipeline. Four users run it: the app, the MCP server in `packages/mcp-server`, propslab-sb and propslab-ent. propslab-sb and propslab-ent copy it byte for byte (CLAUDE.md), so each change to the engine is made three times. On 2026-11-11 three pieces of work waited for that reason: the 34 lint findings in the engine (#856, #865), the split of the largest modules (#777) and the codes of the diagnostics (#846).

The engine has no boundary in the tree. Measured on `main` on 2026-11-11:

- The engine's code imports four modules from `src/utils/`: `splunkRegex`, `strftime`, `regexSyntax` and `redosHeuristic`.
- The three worker entry points in `src/engine/` (`pipelineWorker.ts`, `regexMatchWorker.ts` and `timestampMatchWorker.ts`) are the browser host of the engine, not the engine. They import `src/workers/`, and `pipelineWorker.ts` imports `src/utils/viewResult`.
- Three modules in `src/utils/` import the engine: `viewResult`, `fieldStats` and `diagnosticCounts`.
- The MCP server has 30 deep imports of `src/engine` and `src/utils`, in 10 of its source files.

#773 proposed a workspace package in this repository. npm cannot install a subdirectory of a git repository. Thus propslab-sb and propslab-ent would still copy the package, or it would go to a registry, with a token in each consumer.

pcre2-wasm-utf16 is a library in a repository of its own, made from repo-template. It releases by `v*` tag, and a ruleset stops a tag from moving. propslab installs `github:Bimmiest/pcre2-wasm-utf16#vX.Y.Z`, and the lockfile records the commit of the tag.

## Decision

The engine moves to a repository of its own, made from repo-template with the `node-ts` stack, as a library:

- **What moves:** `src/engine/` without the three worker entry points; the four modules of `src/utils/` that it imports; their tests; the Stryker configuration for the engine; and `src/engine/CLAUDE.md`. The history comes with the code (`git filter-repo`), so that `git blame` still works.
- **Its API:** an `exports` map. A consumer imports only from that API.
- **Its releases:** a `v*` tag, under a tag ruleset. propslab (the app and the MCP server), propslab-sb and propslab-ent install a tag, as propslab installs pcre2-wasm-utf16. A pin bump replaces each copy. The engine repository owns the pcre2-wasm-utf16 pin and its checksum.
- **Its Node range:** `engines` says which Node its consumers can run. `node-version-check` runs without `engines-major`, as for a library.

The steps, in this order. Each step is a pull request with green gates:

1. **Check the two copies.** Confirm that the builds of propslab-sb and propslab-ent can install a git dependency by tag, and that neither changes its copy of the engine. If one cannot, or does, stop and write a new ADR.
2. **Make the boundary in this repository:**
   - Move the three worker entry points to `src/workers/`.
   - Move the four modules of `src/utils/` under `src/engine/`.
   - Give the engine one entry point, and make `viewResult`, `fieldStats`, `diagnosticCounts` and the MCP server import only from it.
3. **Make the repository** from repo-template, and move the code with its history.
4. **Release `v0.1.0`.** propslab installs it. Then propslab-sb and propslab-ent replace their copies with the pin.
5. **Do the engine work in the new repository:** #777, #846, and the lint findings of the engine in `scripts/lint-allowlist.json`.

## Consequences

- There is one copy of the engine. A change to it is made one time, and its tests, coverage floors and mutation runs are in one place.
- A change that needs the engine and the UI is two pull requests, a release of the engine, and a pin bump here. A fix to the simulation reaches the app only after its release.
- Dependabot waits 7 days after a release before it proposes a bump. Bump the engine by hand, or exempt it from the cooldown in `.github/dependabot.yml`.
- The rule in CLAUDE.md that propslab-sb and propslab-ent copy the engine byte for byte ends at step 4, and that change updates CLAUDE.md.
- The mutation scope here gets smaller: `stryker.config.mjs` keeps the app's modules, and the engine's modules go with the engine.
- #773 asked for a package in this repository. This ADR does the same work in a different place, so #773 is done when step 4 is done.
- Step 1 can stop the plan. Then a new ADR supersedes this one.
