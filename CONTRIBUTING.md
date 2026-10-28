# Contributing

This file is short on purpose: people do not apply a document that they do not finish. It holds only the rules that a contributor must follow. Each area has a summary here, and a link to the topic file in `docs/` that has the detail, the recipes and the traps. When a check enforces a rule, this file names the check.

The conventions follow [`repo-template`](https://github.com/Bimmiest/repo-template), and most of the checks come from [`shared-workflows`](https://github.com/Bimmiest/shared-workflows), pinned by commit ([ADR 0017](docs/adr/0017-ci-gates-come-from-shared-workflows.md)). A change to a shared check is made there and reaches this repository as a pin bump.

## Issues first

Open an issue for anything larger than a typo, before writing the code. The issue is where the *why* gets argued while changing it is still cheap; filing one afterwards to record what you already built is the inversion the rule exists to prevent. A closed issue is not a substitute: if the work is new, the issue is new. A discrepancy with real Splunk is a fidelity question, which has its own issue form.

An open question that has to be settled before code is written is an issue labelled `decision`. The answer becomes an ADR ([`docs/adr/`](docs/adr/README.md)).

## Branches

Trunk-based: `main` is the only long-lived branch, and every change reaches it through a pull request.

```
<type>/<short-description>-<issue-number>
```

| Type | For |
|---|---|
| `feature/` | New capability |
| `fix/` | A defect in something that already shipped |
| `refactor/` | Behaviour unchanged, shape improved |
| `docs/` | Documentation, ADRs, this file |
| `ci/` | Workflows, checks, build tooling |
| `chore/` | Dependencies, config, housekeeping |

The description is lower-case kebab: letters, digits and hyphens, so no dots (`fix/dompurify-3-4-17-123`, not `fix/dompurify-3.4.17`). The issue number comes last, and the description must link the same issue (`Closes #123`). Omit the number only when there is genuinely no issue, and label the pull request `no-issue`. The [`pr-hygiene`](.github/workflows/pr-hygiene.yml) check enforces the pattern, the number and the link in the description; Dependabot's pull requests are exempt. It re-runs when the description or the labels change, so most failures are fixed with an edit rather than a push.

**One branch per coherent piece of work.** A feature, a fix, a decision. Work that is mutually dependent belongs together; work that is merely adjacent does not.

If a tool assigned you a non-conforming branch (an automated `claude/…` name, say), rename it and reopen the pull request from the renamed branch, and say so in the description. GitHub cannot change a pull request's head branch.

## Commits

- Explain **why** in the commit body, not just what, including what the choice cost.
- Reference issues with a closing keyword **per issue** — `Closes #1, #2` only closes #1.
- When an operator must *act* on a change (a manual step, a repository setting or variable, a default that changes what a deployment does), add a line on its own anywhere in the message: `Upgrade-Note: <what to do, in one sentence>`. The bar is action, not interest.
- A commit that only reformats goes in `.git-blame-ignore-revs`, one hash per line, under a comment naming it.

Pull requests are squash-merged with the branch's commit messages as the body, so what you write at commit time is what `main` keeps, and an `Upgrade-Note:` in any commit survives the squash.

## Pull requests

Set up the checkout as [docs/development.md](docs/development.md#set-up) says. Use the Node version in `.nvmrc`. Install the dependencies of `packages/mcp-server` before you lint.

Run these commands before you open a pull request. CI runs the same commands, and the other checks that [docs/ci.md](docs/ci.md) lists.

```bash
npm run lint && npm run format:check && npm run typecheck && npm run test:coverage
npm run test:e2e                                  # when the change reaches the browser
cd packages/mcp-server && npm run test:coverage   # when the change reaches the engine or the MCP server
```

The pull request description is for the reviewer; its template has four sections (What and why, Decisions, Verification, Not done), and a section that does not apply is deleted.

A red check tells you what to change. Do that, and do not find a way around the check. If a check fails only in CI, follow [the procedure in ci.md](docs/ci.md#a-check-that-fails-only-in-ci).

## Tests

[docs/testing.md](docs/testing.md) gives the rules for tests and their reasons, the two test suites, and mutation testing. These are the rules that people break:

- **Coverage is a floor, and a ratchet.** Do not lower a floor to make a branch green. When the ratchet says so, raise the floor in the same change. Do not exclude code to make the numbers look better.
- **A test does not time itself.** Count the work, or make the input so large that the bad version cannot finish within the timeout.
- **Test scaffolding is shared.** A new test file uses the builders in `src/test/`, not its own event literal or model stand-in.
- **The e2e suite runs against `dist/`, not the dev server.** A change that works under `vite dev` can fail in CI.
- **Mutation testing holds the engine files that a pull request changes to the floor in `stryker.config.mjs`.** A pull request that touches a weakly tested file adds the tests that bring it up. Kill a survivor with a test that asserts behaviour.

## Code style

Prettier sets the layout, ESLint finds mistakes, and TypeScript is strict. [docs/code-style.md](docs/code-style.md) gives each rule with its reason, and the rules for code comments. These are the rules that people break:

- **Formatting is Prettier's, and reviews do not discuss it.** `npm run format` rewrites the files.
- **Do not use `eslint-disable` at a call site.** Turn a wrong rule off in `eslint.config.js`, with the sentence that says why. A deliberate exception gets an inline disable that says so.
- **Do not use `!` in shipped code.** Narrow the type instead. Tests can use `!`.
- **`src/engine` does not import the UI, React, zustand or Monaco.** A lint rule enforces this, and a test holds the rule.
- **A comment says why, for the code as it is now.** For history, link the issue or the ADR.

## Dependencies

[docs/dependencies.md](docs/dependencies.md) gives the supply-chain checks, the regex engine's binary, the overrides, and how to review a Dependabot pull request. In short:

- **Read the lockfile diff of each Dependabot pull request.** Do not fix a group on the Dependabot branch.
- **A `pcre2-wasm-utf16` pin bump moves the commit in both `package.json` files.** Copy the release's `pcre2.wasm.sha256` to the root in the same change.
- **When you bump a Radix package, move the overrides to the versions that it pins.** Drop an override when `npm run check:overrides` says that no package needs it.
- **The licence of each production dependency is on the allowlist.** Otherwise the allowlist names the package, the version that a person read, and why it is acceptable.

## Where a change goes

[docs/recipes.md](docs/recipes.md) gives the directory for each kind of change, and the steps for the common changes. These rules apply to each change:

- **`src/engine/**` has one runtime dependency, the PCRE2 WebAssembly module, and must not gain another.** Other code uses the engine directly as a library.
- **A user-written pattern compiles through `safeRegex` in `src/utils/splunkRegex.ts`, never `new RegExp`.**
- **An export from `src/engine`, `src/monaco` or a vendored file in `src/utils` is public.** Before you remove or rename an export, search propslab-sb and propslab-ent too.
- **Each directive in the registry has a classification in `directiveSupport.ts`.** A `simulated` directive has a unit test, and a "Doc-derived" citation of the `.spec` file. `directiveEvidence.test.ts` fails without the citation. [The steps for a simulated directive](docs/recipes.md#adding-or-changing-a-simulated-directive) give the detail.
- **If real Splunk contradicts a doc-derived test, open an issue** with the input, the stanza and what Splunk produced. Do not put recorded Splunk output in this repository ([ADR 0016](docs/adr/0016-recorded-splunk-output-is-not-distributed.md)).

## Decisions

**Design rationale and history go in [`docs/adr/`](docs/adr/README.md)**, not in code comments or the changelog. A comment describes what the code does now and any non-obvious constraint; when the reason needs history ("we tried X, #123 showed Y"), write or extend an ADR and point to it from the comment (`See docs/adr/NNNN-….md.`).

- **An ADR does not change.** When a decision changes, write a new ADR and mark the old one superseded.
- [`docs/adr/README.md`](docs/adr/README.md) has the conventions and the index. CI's docs check holds the index and the directory to each other.

## Documentation

**Write all documentation in ASD-STE100 Simplified Technical English** ([repo-template ADR 0002](https://github.com/Bimmiest/repo-template/blob/main/docs/adr/0002-documentation-is-simplified-technical-english-and-a-readme-keeps-to-the-fundamentals.md)). This rule applies to each new or changed text: the README, the files in `docs/`, this file, `SECURITY.md`, ADRs and the CHANGELOG. It does not apply to an accepted ADR, which does not change, or to third-party text such as the Contributor Covenant. Old text changes to STE when somebody next edits it.

**Put each text in its class, and keep the file within the limit of its class.** The docs check enforces the limits, and each topic file in `docs/` declares its type. [docs/documentation.md](docs/documentation.md) gives the classes, the limits, the types, the STE rules and the sections of the README. In short:

| Text | Where it goes |
|---|---|
| A rule that a contributor must follow | This file, in one or two sentences, with a link to the detail |
| The detail of a rule, a recipe, a trap or a troubleshooting step | The topic file of its area in `docs/` |
| A decision that stays true after the pull request | A new ADR in `docs/adr/` |
| Work to do | An issue |
| What changed for a user | `CHANGELOG.md`, under `Unreleased` |

**A change updates the documents that it makes wrong, in the same change.** Do not do it later or in a follow-up issue: a document that you update a week later is wrong for a week.

| Document | Update it when |
|---|---|
| `CHANGELOG.md`, under `Unreleased` | A user can see the change. Write one or two sentences, with the issue link. The `pr-hygiene` check fails when a change to `src/`, `packages/mcp-server/src/`, `public/` or `index.html` has no entry. If no user can see the change, add the `no-changelog` label. |
| `README.md` | A capability is added or changes shape, or a caveat stops being true |
| `docs/*.md` | The topic of the file changes |
| `docs/README.md` | A topic file is added, renamed or removed |
| `docs/adr/` | A decision stays true after the pull request: add a new record **and** its row in the index |
| The commit message | An operator must act: add one `Upgrade-Note:` line |
| `SECURITY.md` | The attack surface changes: a new input path, or a new place where data is stored or sent |
| `CLAUDE.md` | People start to break a rule, or a mistake is expensive and not obvious |

CI checks only the mechanical parts: the links, the ADR index, the root licences in the README, the line limits and the topic types, the counts in the README, and the script list in `docs/development.md` (`src/__tests__/docs.test.ts`). Whether a paragraph is still true is your decision.

## Security

- Report a vulnerability privately, as [`SECURITY.md`](SECURITY.md) says.
- **Rotate a real key. Do not allowlist it.** A false positive of gitleaks or Trivy goes in `.gitleaks.toml` or `.trivyignore.yaml`, with its reason next to it.
- **Untrusted text gets to a shell only through the environment.** Do not put `${{ }}` in a `run:` block.
- **Some repository settings are not files.** `settings.yml` compares them each week with the repo-template checklist. When the ruleset requires a new check, add its name to `.repo-settings.json`.

## Releases

**Versioning** follows [Semantic Versioning](https://semver.org/) (MAJOR.MINOR.PATCH). Breaking changes increment MAJOR; new features increment MINOR; bug fixes increment PATCH.

**Gate:** All open fidelity questions (issues labeled `question`) must be resolved or closed before a release. A fidelity question represents an outstanding discrepancy with Splunk that needs investigation or clarification.

A release is a marker, not a deploy. [docs/releasing.md](docs/releasing.md) has the checklist.
