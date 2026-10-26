# CI and deployment

This file describes the path from a commit to production: the CI jobs, the deploy workflow, and how to do a rollback. [CONTRIBUTING.md](../CONTRIBUTING.md#the-ci-checks) tells you how to run each CI check locally.

## CI

`ci.yml` runs on each PR, on each push to main, weekly and on demand. These jobs run at the same time:

- `static checks`: lint, the format check, the build (`tsc -b && vite build`), the per-chunk gzip budgets (`scripts/check-bundle-size.mjs`), the entry graph, the documentation check and the licences.
- `unit tests`: the tests with coverage, and the coverage ratchet.
- `e2e`: the Playwright suite against a production build.
- `mcp-server`: the typecheck, the bundle and the tests of the MCP server, on Linux, Windows and macOS.
- `workflow-lint`: actionlint and zizmor over `.github/`.
- `dependency-review`, on PRs only.

The job `ci` passes only when all of these jobs pass. It is the check that `main` requires, so a PR cannot merge while one of these jobs fails. The deploy waits until the whole CI run passes, so it uses the same jobs.

`audit.yml` is a separate workflow. It runs `npm audit` over both lockfiles. A high-severity advisory in a production dependency makes it fail. An advisory in a dev-only dependency does not make it fail, and the job only reports it. `main` requires the `audit` check, so a failure stops a merge. It does not stop a deploy, because the deploy waits only for CI.

CodeQL uses the default code-scanning setup of GitHub, not a workflow file. [`security.yml`](../.github/workflows/security.yml) is a separate workflow, and it calls the reusable workflow in [`Bimmiest/shared-workflows`](https://github.com/Bimmiest/shared-workflows). It runs gitleaks over the whole history, and Trivy over the tree and both lockfiles. It runs on each PR, on each push to main and weekly.

## The deploy workflow

The Azure SWA deploy (`azure-static-web-apps.yml`) only builds and deploys. It has no test job of its own, because it does not run until CI has passed. A `workflow_run` event starts it when a CI run is complete. The workflow continues only if that run passed and was for a push to main.

The workflow then deploys the **newest commit on main with a green push CI**. This is not always the commit that started it, because the CI runs for two quick pushes can complete in either order. The workflow builds that commit with the `.nvmrc` Node and `npm ci --ignore-scripts`. Then it uploads `dist/`, and skips the app build.

The list of CI runs can lag, so the workflow checks the commit that it finds. The commit must contain the commit that started the run and the commit that production serves. The deploy job writes the commit that it built into the URL of the deployment, as the query `?build=<sha>`. The next run reads the commit that production serves from there. The deployment record of GitHub names the commit of the run, which is not always the commit that the run built ([#574](https://github.com/Bimmiest/propslab/issues/574)).

Build and deploy are separate jobs:

- `build` resolves and checks the commit, installs and builds it, and uploads `dist/` as an artifact. This job never sees the deployment token.
- `deploy` runs in the `production` environment. It does not do a checkout, and it only gives that artifact to the Azure action.

A manual `workflow_dispatch` on `main` is the path for a redeploy and for a rollback. CI does not gate it.

- If the `sha` input is empty, the dispatch redeploys the newest green commit on main.
- If `sha` has a value, the dispatch deploys that commit. It refuses a commit that is not an ancestor of `main`. Thus it can restore only a commit that was merged before.
- If `run_id` has a value, the dispatch deploys the bundle that an earlier run of the deploy workflow deployed. It does not build again. A run keeps its bundle and its attestation for 30 days. The run must be a successful run of the deploy workflow on `main`, and the deploy job verifies its attestation as it verifies a new one. Use `sha` or `run_id`, not both.

A rebuild of an old commit can be different from the bundle that was live. The dependency `pcre2-wasm-utf16` comes from git, with no integrity hash in the lockfile, and the tools change. Thus `run_id` is the better rollback while the bundle is kept.

## The production environment

A dispatch from any other branch or tag fails. These checks are in the workflow file, and a dispatch runs the workflow file from the ref that it dispatches. Thus only the settings of the `production` environment can stop a deploy from a branch or a tag. The name of the environment in the workflow has no effect until a repository admin configures the environment. The comment above the `deploy` job has the details. To configure the environment, a repository admin must do these steps:

1. Move `AZURE_STATIC_WEB_APPS_API_TOKEN` from the repository secrets to the secrets of the environment.
2. Delete the copy of the token at the repository level.
3. Under the deployment branches and tags of the environment, choose "Selected branches and tags".
4. Allow `main` only, and add no tag patterns.

Until the admin completes these steps, any workflow on any branch can read the token. The weekly [`environment.yml`](../.github/workflows/environment.yml) workflow checks both settings through the API. It fails when one of them is not in place. It also checks the protection of `main`, and it fails when it cannot read the protection, because then it verified nothing. To read the protection, it uses the `SETTINGS_READ_TOKEN` repository secret, which the weekly settings check also uses. Its secret check needs a `SECRETS_READ_TOKEN` repository secret. This is a fine-grained token for this repository, with the Environments and Secrets permissions both set to read-only. The token lists the names of the secrets, and never their values.

## Scheduled runs

`ci.yml`, `audit.yml`, `security.yml`, `mutation.yml` and `environment.yml` also run on a schedule, to find problems that occur without a push. If a scheduled run fails, its `report` job opens an issue with a `scheduled-*` label. If an issue with that label is open, the job adds a comment to it. Close the issue when the fix is on main.

If an automatic deploy fails, the `report` job of the deploy workflow opens an issue with the label `deploy-failed`, or adds a comment to the open issue. If the header check failed, the site serves the new bundle. The issue tells you how to restore the previous bundle.

## Credentials

The maintainer holds the credentials that the workflows use. Propslab has one maintainer, so this section is the hand-off ([#576](https://github.com/Bimmiest/propslab/issues/576)).

| Secret | Where it is stored | What it does | How to rotate it |
|---|---|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | The secrets of the `production` environment | The deploy job uploads the site with it. It gives access to this Static Web App only. | In the Azure portal, open the Static Web App, select **Manage deployment token**, and reset it. Then put the new token in the environment secret. |
| `SETTINGS_READ_TOKEN` | The repository secrets | The weekly settings check and the weekly environment check read the repository settings and the protection of `main` with it. It is a fine-grained token for this repository, with Administration set to read-only. | Make a new token with the same permission, put it in the repository secret, and delete the old token. |
| `SECRETS_READ_TOKEN` | The repository secrets | The weekly environment check lists the secret names with it. It is a fine-grained token for this repository, with Environments and Secrets set to read-only. | Make a new token with the same permissions, put it in the repository secret, and delete the old token. |

A fine-grained token has an expiry date. When `SECRETS_READ_TOKEN` expires, the weekly environment check fails. Then rotate it. Reset the deployment token if it is possible that somebody else knows it.

## Rollback

A rollback stays in place only while the automatic path is paused. If the automatic path is not paused, two things can occur:

- The next green push CI on main redeploys the newest green commit over the rollback. A new run of the CI of the bad commit does the same.
- The next automatic run can silently cancel a dispatch that waits in the queue behind a deploy in progress. A concurrency group keeps only the newest run that waits.

The repository variable `DEPLOY_PAUSED` is the switch. While it is `true`, automatic runs do not deploy and do not join the deploy queue. The variable has no effect on dispatches. If you dispatch after you set the variable, no automatic deploy can cancel or overwrite that dispatch while the variable stays set. A dispatch without the variable has no such guarantee.

To do a rollback:

1. Under Settings → Secrets and variables → Actions → Variables, set `DEPLOY_PAUSED` to `true`.
2. Dispatch the deploy workflow on `main`. Set `run_id` to the last good run of the deploy workflow. If that run is older than 30 days, set `sha` to the commit that you want to restore.
3. Wait until the fix is merged and the push CI on main is green.
4. Delete `DEPLOY_PAUSED`, or set it to a value other than `true`.
5. To start automatic deploys again, dispatch with `sha` empty, or wait for the next push.

## The supply chain of the deploy

The Azure action is pinned to a commit, but that pin applies only to its wrapper. Its Dockerfile uses `mcr.microsoft.com/appsvc/staticappsclient:stable` as its base, and that is a movable tag. Thus the client that receives the deployment token is the client that Microsoft publishes there at that time. The workflow file explains why this stays as it is.

Node is pinned one time, in `.nvmrc`. Both workflows and the `engines` field of `package.json` follow it. `supply-chain.yml` checks the Radix overrides. Monthly, it also checks that `.nvmrc` is the newest patch of its line. The deploy attests the bundle that it uploads, and it verifies the attestation before it gives the bundle to Azure. [CONTRIBUTING.md](../CONTRIBUTING.md#supply-chain-checks) has more information about this.
