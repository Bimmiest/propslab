# 0022. The supported browsers are the Baseline "widely available" set

- **Status:** Accepted
- **Date:** 2026-11-10
- **Issue:** [#774](https://github.com/Bimmiest/propslab/issues/774)
- **Code:** the `no-deprecated` exception in `eslint.config.js`, `src/components/preview/tabs/shared/SelectableRaw.tsx`, `src/hooks/useUnloadWarning.ts`, `src/utils/clipboard.ts`

## Context

Three places in the app call an API that `@typescript-eslint/no-deprecated` reports. Each one is a fallback. #774 asked to delete the fallbacks that no supported browser needs. Propslab had no written list of supported browsers, so nobody could say which fallbacks a browser still needs.

## Decision

Propslab supports a web feature when the feature is Baseline "widely available". That is, it has worked in the current versions of Chrome, Edge, Firefox and Safari, on desktop and on mobile, for 30 months. A fallback for a feature that is widely available is deleted. A fallback for a feature that is only "newly available" stays until the feature is widely available.

The three fallbacks, against this rule:

- **`caretRangeFromPoint`** in `SelectableRaw.tsx`. Its replacement, `caretPositionFromPoint`, became Baseline "newly available" in December 2025. The fallback stays until about June 2028 ([#833](https://github.com/Bimmiest/propslab/issues/833)).
- **`returnValue`** in `useUnloadWarning.ts`. The `beforeunload` event is widely available, and MDN's recommendation is to call `preventDefault()` and also to set `returnValue` for older browsers. It stays.
- **`execCommand('copy')`** in `clipboard.ts`. This is not a fallback for an old browser. It is for an insecure context, for example a build that a server sends over plain HTTP, where `navigator.clipboard` does not exist. The browser rule does not decide it, and it stays.

## Consequences

- No fallback goes now. Each one is an exception in `eslint.config.js`, scoped to its file, with its reason. No file turns a rule off at a call site, and `linterOptions.noInlineConfig` holds that for each linted file.
- A new feature that is not yet widely available needs a fallback, or a reason in its pull request why the app can do without it.
- Rejected: "the last two versions of each browser". It names browsers, not features, so it does not say whether a given fallback can go.
