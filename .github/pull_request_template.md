<!--
Delete any section that genuinely does not apply. An empty heading left behind
is worse than no heading.
-->

## What and why

<!--
What changed, and the reasoning, including what it cost. A description that
only lists benefits is marketing. If a trade-off was made, name the thing that
got worse.
-->

Closes #

## Decisions

<!--
Did this settle something that outlives the pull request: a shape, a boundary,
a rule about who may do what? Then it belongs in `docs/adr/` as its own record
with a row in the index, and this section links to it.

ADRs are immutable. A superseded decision gets a new ADR and a status change
on the old one, never an edit.

Delete this section if nothing was decided.
-->

## Verification

<!--
What you ran, and what it said. "Tests pass" is a claim; the output is the
evidence. Paste the interesting lines.
-->

- [ ] `npm run lint` and `npm run format:check`
- [ ] `npm run build` (the type-check)
- [ ] `npm run test:coverage`, and the floors in `vitest.config.ts` raised if the ratchet asks
- [ ] `npm run test:e2e`, where the change reaches the browser
- [ ] `cd packages/mcp-server && npm run test:coverage`, where the change reaches the engine or the server
- [ ] `npm run test:mutation -- --mutate <file>` for a changed file that `stryker.config.mjs` mutates (`mutation.yml` runs it on the pull request too)
- [ ] For a simulated directive: classified in `directiveSupport.ts`, with a "Doc-derived" citation ([CONTRIBUTING](../CONTRIBUTING.md#adding-or-changing-a-simulated-directive))
- [ ] Documentation this change dates is updated in this change: `CHANGELOG.md` under `Unreleased` for anything a user would notice, the README or the file in `docs/` where a capability changed shape, an ADR and its index row where something was decided, an `Upgrade-Note:` line in the commit where an operator must act

## Not done

<!--
What a reader might reasonably assume is here and is not: scope deliberately
left out, limits that still stand, gaps you know about. Say it here rather than
letting someone discover it.
-->
