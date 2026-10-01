# 0016. Recorded Splunk output is not distributed

- **Status:** Accepted
- **Code:** `src/engine/__tests__/directiveEvidence.test.ts`, `src/engine/__tests__/docDerivedDirectives.test.ts`, `.gitignore`

## Context

Until October 2026 the source tree carried fixtures recorded from Splunk Enterprise 10.4.0, a suite that replayed them through the engine (`splunkFidelity.test.ts`), and a few unit tests whose expected values had been observed on that instance rather than read from the documentation. `directiveEvidence.test.ts` ([#505](https://github.com/Bimmiest/propslab/issues/505)) counted a fixture as the strongest evidence for a simulated directive, and 44 directives relied on one.

The maintainer decided to stop distributing recorded Splunk output with the source and its releases.

## Decision

- Recorded Splunk output, and fixtures and tests derived from it, are excluded from this repository and its releases. The source, test suite, build and CI do not depend on them.
- `directiveEvidence.test.ts` recognises two kinds of evidence: a test that runs the directive through `runPipeline`, and one that also cites the spec. It counts only tests committed here; `src/engine/__tests__/private/` is git-ignored for local-only tests and is left out. `docDerivedDirectives.test.ts` gives each directive that had relied on a fixture a pipeline-level test written from the spec.
- Engine behaviour does not change. Where it follows observed behaviour over the spec's prose ([ADR 0007](0007-line-breaking-follows-recorded-splunk-behaviour.md)), the code keeps that behaviour and its comments say so.

## Consequences

- Public tests can assert only what the documentation says. A directive simulated as observed behaviour that the spec contradicts has no citation to point to, so it sits in `DOC_UNCITED`; today that is `MUST_NOT_BREAK_BEFORE`.
- CI does not check the engine against recorded Splunk output. A change to behaviour that follows observation rather than the spec needs the same care as before, without a test that would catch it.
