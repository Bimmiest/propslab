# 0020. Propslab has one maintainer, and main requires no approving review

- **Status:** Accepted
- **Date:** 2026-10-25
- **Issue:** [#576](https://github.com/Bimmiest/propslab/issues/576)
- **Code:** `scripts/lib/branchProtection.mjs`, `.github/CODEOWNERS`, `SECURITY.md`, `docs/deployment.md`

## Context

The review tracked by #555 found one maintainer. `.github/CODEOWNERS` names one account, and the ruleset on `main` requires a pull request but no approving review. A maintainer cannot approve their own pull request, so a required review would stop every merge. Thus a change to a workflow, including the deploy workflow that holds the token, merges with no second reviewer. The review proposed a second maintainer and a required review.

The owner does not expect a second maintainer soon.

## Decision

- Propslab keeps one maintainer. `main` requires a pull request and the CI checks, but no approving review. The weekly environment check asserts the pull request and the checks, and does not ask for a review.
- The checks are the review that a second person would otherwise give: the required CI jobs, the security scans, and workflow lint over `.github/`.
- `SECURITY.md` says that no second person reviews a security fix. It gives a 90-day fix target and a fallback contact.
- `docs/deployment.md` lists each credential that the workflows use, where it is stored and how to rotate it, so that somebody else can take over.

## Consequences

- If the maintainer stops, the project stops until somebody else takes the repository. The credentials section is the hand-off.
- A change that the checks cannot judge, such as a change of intent in a workflow, has no second reader.
- If a second maintainer joins, add the account to `CODEOWNERS`, require one approving review on `main`, add the requirement to `scripts/lib/branchProtection.mjs`, and supersede this record.
