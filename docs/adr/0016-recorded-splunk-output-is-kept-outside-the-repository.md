# 0016. Recorded Splunk output is kept outside the repository

- **Status:** Accepted
- **Code:** `src/engine/__tests__/directiveEvidence.test.ts`, `src/engine/__tests__/docDerivedDirectives.test.ts`, `.gitignore`

## Context

Until October 2026 the source tree carried fixtures recorded from Splunk Enterprise 10.4.0, a suite that replayed them through the engine (`splunkFidelity.test.ts`), and a few unit tests whose expected values had been observed on that instance rather than read from the documentation. `directiveEvidence.test.ts` ([#505](https://github.com/Bimmiest/propslab/issues/505)) counted a fixture as the strongest evidence for a simulated directive, and 44 directives relied on one.

The maintainer decided to stop distributing recorded Splunk output with the source and its releases.

## Decision

- Recorded output, and the tests that depend on it, are maintained outside this repository. Building, testing and releasing Propslab do not need them.
- `src/engine/__tests__/private/` is git-ignored. It is where that suite is placed when it is run against a checkout, and nothing in it is committed.
- `directiveEvidence.test.ts` recognises two kinds of evidence: a test that runs the directive through `runPipeline`, and one that also cites the spec. It ignores anything under `private/`, so its verdict is the same with or without that suite. `docDerivedDirectives.test.ts` gives each directive that had relied on a fixture a pipeline-level test written from the spec.
- Engine behaviour does not change. Where it follows observed behaviour over the spec's prose ([ADR 0007](0007-line-breaking-follows-recorded-splunk-behaviour.md)), the code keeps that behaviour and the comments that explain it.

## Consequences

- Public tests can assert only what the documentation says. A directive simulated as observed behaviour that the spec contradicts has no citation to point to, so it sits in `DOC_UNCITED`; today that is `MUST_NOT_BREAK_BEFORE`.
- A regression against recorded behaviour is caught when the separate suite is run, not by CI. Engine refactors that move modules can break that suite without failing anything here.
- Comments that name a recorded case, such as `linebreak-max-events`, refer to cases in that suite.
