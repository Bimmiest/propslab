---
type: how-to
---

# Releases

How to make a release. [CONTRIBUTING.md](../CONTRIBUTING.md#releases) has the rules for versions and the fidelity gate.

**What a release is here.** There is no release workflow. Every commit that lands on `main` with a passing CI run is deployed to production by `azure-static-web-apps.yml` (it runs when CI finishes, builds that commit, then checks the served headers), and nothing is triggered by a tag. A release is therefore a marker: a version number in `package.json` (shown in the status bar), a dated heading in `CHANGELOG.md`, and optionally a tag on the merge commit.

**Release checklist:**

1. Check the fidelity gate in [CONTRIBUTING.md](../CONTRIBUTING.md#releases): no open issue labeled `question`.
2. On a branch, rename the `## Unreleased` heading in `CHANGELOG.md` to `## x.y.z — YYYY-MM-DD` (an em dash, as in the existing headings, e.g. `## 1.2.0 — 2026-09-19`) and put a fresh, empty `## Unreleased` above it.
3. Set the version in `package.json` and `package-lock.json` to `x.y.z` (`npm version x.y.z --no-git-tag-version` does both).
4. Open a pull request and merge it once CI is green. Merging is what deploys: watch the "Azure Static Web Apps CI/CD" run on `main` until "Verify the deployed headers" passes.
5. Optionally tag the merge commit, `git tag -s vx.y.z <sha> -m "Release x.y.z"` then `git push origin vx.y.z` (`-s` needs a GPG or SSH signing key; without one use `-a`). The tag is a bookmark for people; no workflow reads it.
6. The `production` environment and `main`'s protection are verified by `environment.yml`, weekly, and the other repository settings by `settings.yml`. Neither has a per-release trigger; if the release touched repository settings, run both from the Actions tab (`workflow_dispatch`) and expect them to pass.

**Note:** `packages/mcp-server` is versioned independently and is not published anywhere (its `package.json` is `private`). Its version, which the server reports in the MCP `initialize` handshake, changes in `packages/mcp-server/package.json` and needs no separate release; if you want a bookmark for it, tag `mcp-server-vx.y.z` the same way.
