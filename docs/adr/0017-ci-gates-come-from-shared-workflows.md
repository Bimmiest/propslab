# 0017. CI calls the shared gates from shared-workflows, pinned by commit, wherever one is equivalent

- **Status:** Accepted
- **Date:** 2026-10-25
- **Issue:** [#602](https://github.com/Bimmiest/propslab/issues/602)
- **Code:** `.github/workflows/ci.yml`, `.github/workflows/pr-hygiene.yml`, `.github/workflows/security.yml`, `.github/workflows/supply-chain.yml`, `.github/workflows/mutation.yml`

## Context

This repository and propslab-ent each grew their own CI gates, and the copies drifted: the coverage ratchet existed in both with different slack, one repository enforced its branch pattern and the other only described it. [`Bimmiest/shared-workflows`](https://github.com/Bimmiest/shared-workflows) now holds those gates as reusable workflows and composite actions, and [`Bimmiest/repo-template`](https://github.com/Bimmiest/repo-template) holds the conventions and governance files that go with them. Before #602 this repository called only the shared `security.yml` ([#549](https://github.com/Bimmiest/propslab/issues/549)).

Three constraints shape what can move. The rulesets on `main` require checks by name, so a gate whose check name would change cannot move without an admin changing the ruleset in the same step. `scripts/lib/branchProtection.mjs`, which `environment.yml` runs weekly, asserts the same names. And the tests of several local scripts live under `src/__tests__/`, which propslab-ent and propslab-sb vendor parts of, so a change that must delete one of those tests is a change of its own.

## Decision

A gate that `shared-workflows` provides and that is equivalent to or stricter than the local one is called from there, pinned by full commit sha with the version in a trailing comment, and bumped by Dependabot from that repository's tags. The local script it replaces is deleted with its tests. A shared gate this repository lacked is adopted. The sanctioned local knobs are the actions' inputs and the files they read: `.audit-exceptions.json` and `.licence-allowlist.json` (one of each per lockfile), `.gitleaks.toml` and `.trivyignore.yaml`.

As of #602:

- **Called from `shared-workflows`:** `setup-node-project` (every job that installs), `playwright-browser`, `coverage-ratchet` (for both coverage configs), `audit-check` (both lockfiles), `docs-check`, `licence-check` (both lockfiles), `pr-hygiene`, and the `security.yml` workflow.
- **Kept local, with the reason:** the `workflow-lint` job, because the required check is named `workflow-lint` and the reusable workflow's check would be `workflow-lint / workflow-lint`. `scripts/check-node-patch.mjs`, because its test is `src/__tests__/checkNodePatch.test.ts`; the shared `node-patch-check` runs the same logic, and replaces the script in the change that deletes both. The checks with no shared equivalent (the Radix overrides, the wasm checksum, the bundle budget, the entry graph, the roster, the production environment, the mutation canary and the format-only filter) stay in `scripts/`.
- **Diverging on an input:** the coverage ratchet runs with `slack: 3`, not the shared default of 1. Floors here are the measured figure minus one point ([#506](https://github.com/Bimmiest/propslab/issues/506)), and the MCP server's must also hold on its Windows and macOS legs, which measure lower than the Linux leg the ratchet reads.

## Consequences

- A gate is fixed in one place, and this repository receives the fix as a pin bump. A shared gate that newly fails on something it passed before is a major version there, so that bump is read rather than waved through.
- A convention change is now two pull requests, one in `shared-workflows` and then a pin bump here, and a shared check can be relaxed only through its inputs.
- The shared actions carry their own pins. At `v1.0.0`, `setup-node-project` runs `actions/setup-node` 7.0.0, one minor behind the 7.1.0 the other jobs here pin, until `shared-workflows` moves it.
- The shared coverage ratchet imports the vitest config, as the local script did, but when the import fails it reads the top-level thresholds as text and prints a notice instead of failing. The per-directory floors are then not checked. `vitest.config.ts` imports cleanly under Node today; a plugin or syntax that stops it doing so turns that check off with only a notice to show for it.
- What to check when changing it: a job that moves to a reusable workflow changes its check name, so the ruleset and `REQUIRED_CHECKS` in `scripts/lib/branchProtection.mjs` change in the same step. If this repository stops consuming `shared-workflows`, the scripts come back to `scripts/` with their tests, and this record is superseded.
