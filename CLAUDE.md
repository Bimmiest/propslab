# CLAUDE.md

The conventions are in [CONTRIBUTING.md](./CONTRIBUTING.md). Read it before
your first change. This file does not summarise it. It names the rules that
people break, and the rules where a mistake is expensive and not obvious.

## Before you write code

**Open an issue first** for each change that is larger than a typo. A closed
issue is not a substitute: new work gets a new issue.

**Branches** follow [the pattern](./CONTRIBUTING.md#branches), and CI refuses
a pull request that breaks it. If your session got a branch name that does not
conform (for example `claude/…`), rename it, open the pull request from the
new name, and say so in the description.

## Gates

```bash
npm run lint && npm run format:check && npm run typecheck && npm run test:coverage
```

Add `npm run test:e2e` when the change reaches the browser, and
`cd packages/mcp-server && npm run test:coverage` when it reaches the engine
or the MCP server. CI runs these and the shared checks. When a check fails, it
says what to change. Do that; do not find a way around it.

**A change to the app or the MCP server adds a CHANGELOG entry** under
`Unreleased`. `pr-hygiene` fails without one. A change no user can see gets
the `no-changelog` label.

## Documentation and comments

- Write the files in `.docs-check.json` in ASD-STE100. Keep the README to the
  fundamentals, in a maximum of 200 lines.
- Update the documents that your change makes wrong, in the same change.
- Code comments follow [the rules](./docs/code-style.md#code-comments). A comment
  says why, for the code as it is now. For history, link the issue or the ADR.

## Engine fidelity

- **A directive test asserts the documentation, and says so:** a comment with
  "Doc-derived", the `.spec` file and the directive, above the test or its
  `describe`. The evidence gate counts a citation only there.
- **No recorded Splunk output in this repository**
  ([ADR 0016](./docs/adr/0016-recorded-splunk-output-is-not-distributed.md)).
  A rule that follows a capture gets an ADR and a code comment; the capture
  and its tests go to the private fidelity suite.
- **propslab-sb and propslab-ent vendor this engine byte-exact.** Keep the
  Node pin, the gates and the template standard the same in all three.

## Expensive to get wrong

- **Do not lower a coverage floor** to make a branch green. Raise it in the
  same change when the ratchet says so.
- **Do not use `eslint-disable` at a call site.** Turn a wrong rule off in
  `eslint.config.js`, with the sentence that says why.
- **Do not edit an accepted ADR.** Write a new one, and mark the old one
  superseded.
- **Do not put `${{ }}` in a `run:` block.** Inputs reach a shell through
  `env:`.
- **A rollback sets `DEPLOY_PAUSED` first,** then dispatches the deploy with
  `run_id` ([docs/deployment.md](./docs/deployment.md#rollback)).
- **A `pcre2-wasm-utf16` pin bump copies the release's `pcre2.wasm.sha256`**
  to the root in the same change.

## Not in this file

No status, no plan and no test counts. Status goes in issues. Keep this file
to one screen.
