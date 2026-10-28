---
type: reference
---

# CI

Each CI job, what makes it fail, and how to run it locally. [CONTRIBUTING.md](../CONTRIBUTING.md) has the rules.

[`ci.yml`](../.github/workflows/ci.yml) runs its jobs side by side on every PR, on pushes to main, weekly and on demand (`dependency-review` on PRs only). The job `ci` passes only when every other job of `ci.yml` passed, and `main` requires it, so a PR cannot merge while one of them fails. The automatic deploy runs only after a push to main's CI run passes, and then ships the newest commit on main whose whole CI run passed. Thus it gates on the same jobs. The `audit` job is in [`audit.yml`](../.github/workflows/audit.yml): `main` requires it, but the deploy does not wait for it, so a new advisory stops merges and not deploys. A manual deploy is not CI-gated: dispatching the deploy workflow on `main` redeploys that same newest green commit, or, with its `sha` input set, rolls back to any commit main has contained, whether or not its CI passed. With `run_id` set instead, it deploys again the bundle that an earlier run deployed, without a rebuild (kept 30 days). A rollback only sticks if the repository variable `DEPLOY_PAUSED` is set to `true` *before* you dispatch it — otherwise the next automatic deploy undoes it, or cancels it while it is still queued — and it stays in place until you delete the variable once the fix is on main. [deployment.md](deployment.md) describes the deploy workflow in full.

**`static checks`**, **`unit tests`** and **`e2e`** — the app, in three jobs:

```bash
npm run lint          # static checks: ESLint, including type-aware rules (needs the MCP server's deps: see development.md)
npm run format:check  # static checks: Prettier over the TypeScript and JavaScript sources; `npm run format` fixes what it reports
npm run build         # static checks: tsc -b && vite build — this is the type-check
npm run test:coverage # unit tests: vitest, with the coverage floor enforced
npm run test:e2e      # e2e: Playwright, against a production build
```

The jobs also run three checks from `shared-workflows`: the coverage ratchet ([testing.md](testing.md#the-rules)), the documentation check, and the licences of the production dependencies against `.licence-allowlist.json`. `unit tests` runs the ratchet, and `static checks` runs the other two. The documentation check holds the links, the ADR index, the line limit of each class of file and the type of each topic file ([documentation.md](documentation.md)). It also warns on each word that ASD-STE100 does not allow, in the files that `ste` names in `.docs-check.json`. Add a file to that list when you rewrite it in STE. Each is a Node script with no dependencies. To run one locally, clone `shared-workflows` beside this repository and run its script from here:

```bash
node ../shared-workflows/.github/actions/coverage-ratchet/ratchet.mjs --config vitest.config.ts --slack 3  # after test:coverage
node ../shared-workflows/.github/actions/docs-check/docs-check.mjs
node ../shared-workflows/.github/actions/licence-check/licence-check.mjs
```

**`mcp-server`** — the MCP server package, which has its own lockfile and toolchain:

```bash
cd packages/mcp-server
npm ci
npm run test:coverage # typecheck + esbuild bundle first, then vitest with the package's coverage floor
```

On the Linux leg it also runs the coverage ratchet against `vitest.config.mts` and the licence check against the package's own lockfile and `packages/mcp-server/.licence-allowlist.json`.

**`audit`** — shared-workflows' audit-check over both lockfiles, the app's and `packages/mcp-server`'s: `npm audit --omit=dev`, failing on a high or critical advisory. An advisory that nothing reachable is exposed to can be listed in that lockfile's `.audit-exceptions.json`, with the reason and an expiry; an expired entry, or one the report no longer needs, fails the job. Dev-only advisories are reported but never fatal. It installs nothing, so locally run `node ../shared-workflows/.github/actions/audit-check/audit-check.mjs` in each directory (or `npm audit --omit=dev --audit-level=high`, which is the same gate without the exceptions).

**`workflow-lint`** — [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://docs.zizmor.sh/) over `.github/`. Locally: `go install github.com/rhysd/actionlint/cmd/actionlint@v1.7.12 && actionlint`, and `uvx zizmor==1.30.1 .` (or `pipx run`). A zizmor finding that is deliberate gets an inline `# zizmor: ignore[<audit>]` with the reason beside it, as the deploy workflow's `workflow_run` trigger has. It is a job of `ci.yml` rather than a call to shared-workflows' `workflow-lint.yml`, which runs the same two tools at the same versions, because the required check is named `workflow-lint` and a reusable workflow's check is named `workflow-lint / workflow-lint`.

**`pr-hygiene`** — a workflow of its own, [`pr-hygiene.yml`](../.github/workflows/pr-hygiene.yml), on pull requests only: the branch and issue rules in [Branches](../CONTRIBUTING.md#branches).

**`dependency-review`** — on PRs, GitHub's dependency review over the PR's dependency diff, failing on a newly added high-severity advisory. CodeQL is not a workflow here: it runs through GitHub's default code-scanning setup (JavaScript/TypeScript and Actions) and reports as the "Analyze" checks.

**`security / gitleaks`** and **`security / trivy`** — not jobs of `ci.yml` but a workflow of their own, [`security.yml`](../.github/workflows/security.yml), calling the reusable one in [`Bimmiest/shared-workflows`](https://github.com/Bimmiest/shared-workflows) pinned by sha: gitleaks over every commit in the history, and Trivy over the tree and both lockfiles at CRITICAL and HIGH with unfixed advisories ignored. It runs on every PR, on pushes to main and weekly, because both checks go red without a push. Locally: `gitleaks detect --source . --log-opts="--all" --redact` and `trivy fs --scanners vuln,misconfig --severity CRITICAL,HIGH --ignore-unfixed .`. A false positive goes in `.gitleaks.toml` or `.trivyignore.yaml` with its reason beside it (both files have no entries yet, and each says what an entry needs and which of its lines are load-bearing); a real key is rotated, never allowlisted.

**`Scorecard`**: [`scorecard.yml`](../.github/workflows/scorecard.yml), weekly and on each push to main. It runs the OpenSSF Scorecard workflow of `shared-workflows`. The result goes to the README badge and to code scanning. It reports, and does not fail.

**`Settings`**: [`settings.yml`](../.github/workflows/settings.yml), weekly. The `repo-settings-check` action of `shared-workflows` compares the repository settings with the repo-template checklist, and a failure opens an issue. `.repo-settings.json` names the checks that main requires. When the ruleset requires a new check, add its name there too. The action needs `SETTINGS_READ_TOKEN`, a fine-grained token with "Administration: read". [`environment.yml`](../.github/workflows/environment.yml) still checks the `production` environment.

## A check that fails only in CI

Compare a full run with a full run:

1. Run the workflow on `main` to get a baseline: `gh workflow run ci.yml --ref main`.
2. Compare two runs on `main` with the runs on your branch. One run is not evidence.
3. Compare the duration of each test in the job logs. If only the failed test changed, the cause is a race, not a slow runner.
4. Make the failed assertion show the value that it has. Push this change as a temporary commit.

A test that runs alone proves nothing. It can pass alone and fail in the order of the full suite. A push cancels the run of that branch that is in progress. Thus, do not start a run again and push at the same time.
