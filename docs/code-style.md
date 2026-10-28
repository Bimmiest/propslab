---
type: reference
---

# Code style

The rules for the layout, the lint and the types of the code, and for code comments, with their reasons. [CONTRIBUTING.md](../CONTRIBUTING.md#code-style) has the summary.

- **Formatting is Prettier's, and not discussed in review.** `.prettierrc.json` is the style the code already had: single quotes, semicolons, two-space indents and trailing commas, with a line width of 120. That width fits 98.6% of the existing code lines and changes about 40% fewer lines than a width of 100 would. It covers `.ts`, `.tsx`, `.js`, `.mjs` and `.mts` (not Markdown, JSON, CSS or the lockfile), and `.prettierignore` leaves out the generated `cimModelsData.ts`. `npm run format` rewrites the files. The commit that applied it to the whole tree is listed in `.git-blame-ignore-revs`, so `git blame` looks through it: run `git config blame.ignoreRevsFile .git-blame-ignore-revs` once to get the same locally (GitHub reads the file by itself).
- **Lint is typescript-eslint's `strictTypeChecked`**, with two rules tuned in `eslint.config.js`, each beside its reason: `no-confusing-void-expression` allows arrow shorthand, and `restrict-template-expressions` allows numbers. A deliberate use of a deprecated browser API, or a guard for something jsdom lacks, gets an inline disable saying so.
- **No `!` in shipped code.** `no-non-null-assertion` is on everywhere except tests and their support files (`__tests__`, `*.test.*`, `src/test`, `e2e`), where `result[0]!` follows an assertion that it exists. In `src/` narrow instead: destructure, iterate rather than index, or check for `undefined`.
- **The engine's imports are checked.** `src/engine` (tests aside) may not import from `components`, `hooks`, `store` or `monaco`, nor React, zustand or Monaco. It is a `no-restricted-imports` rule with glob `patterns`, and `src/__tests__/eslintBoundary.test.ts` lints real import lines against the rule as configured, so a change to the config cannot quietly stop it matching.
- **Imports are ordered** (`eslint-plugin-import-x`): Node built-ins, then packages, then the project's own files (parent, sibling and index alike), in that order and no finer. Within a group the order is yours, and side-effect imports (`import '../../test/monacoJsdom'`) are not ordered, so one that must run first can stay first. `npm run lint -- --fix` reorders a file; `src/__tests__/eslintImportOrder.test.ts` holds the rule to the imports it must catch.
- **`noPropertyAccessFromIndexSignature` is on**, with `noImplicitOverride`: a property that comes from an index signature (`process.env`, `dataset`, a `Record<string, T>`) is read as `x['name']`, so it cannot be mistaken for a declared one. `exactOptionalPropertyTypes` is off on purpose; `tsconfig.app.json` says why.
- **`npm run typecheck` is the type-check** (`tsc -b`, every project). `npm run build` runs it before the bundle, so a type error also fails the build.

## Code comments

The code tells the reader what it does. A comment tells the reader what the code cannot tell. These rules apply to new code and to the code that you change. They come from the Google style guides, *Clean Code*, *Code Complete*, *A Philosophy of Software Design* and the Stack Overflow guide to code comments (2021).

1. **A comment says why:** the constraint, the rule from a specification, or the failure that the code prevents. Do not repeat what the code does.
2. **Write the comment for the code as it is now.** Do not tell the history of a change ("now", "before", "changed to"). The commit message has the history. If the history explains a decision, link it: `(#123)` or `See docs/adr/NNNN-title.md.`
3. **Each exported function, class, type and constant has a TSDoc comment** (`/** … */`). It says what the export does for the caller, and what it promises. It does not say how.
4. **If a comment is difficult to write, make the code clearer first.** Then write the comment for the part that is still not clear.
5. **Use the same quantity of comments as the file that you change.**
6. **Put the reason next to the code that it explains.** The comment at the top of a file says what the file is for, and what it does not do.
7. **Link the source of a fact:** the section of a specification, the origin of copied code, or the issue of the bug that the code prevents.
8. **Do not keep code in a comment.** Git keeps the old version.
9. **A TODO names its issue:** `TODO(#123): what is not done.`
10. **A shortcut with a known limit says so:** `shortcut: <the limit>, <when to change it>.`
11. **When your change makes a comment false, change the comment in the same commit.**

`npm run lint` finds the rules 8 and 9: code in a `//` comment, and a TODO, FIXME or XXX that has no issue (`scripts/eslint-comments.mjs`, from repo-template). A reviewer finds the other rules.
