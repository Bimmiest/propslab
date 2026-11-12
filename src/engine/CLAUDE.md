# CLAUDE.md — the engine

These rules apply in this directory, the simulation engine. The rules for the
whole repository are in the `CLAUDE.md` at its root.

propslab-sb and propslab-ent copy this directory byte for byte, with this
file. Thus each link here is a full URL, and each path is a path in
[Bimmiest/propslab](https://github.com/Bimmiest/propslab). In a copy, do not
change this directory: change it in propslab, and sync it.

## Fidelity

- **A directive test asserts the documentation, and says so:** a comment with
  "Doc-derived", the `.spec` file and the directive, above the test or its
  `describe`. The evidence gate counts a citation only there.
- **No recorded Splunk output in the repository**
  ([ADR 0016](https://github.com/Bimmiest/propslab/blob/main/docs/adr/0016-recorded-splunk-output-is-not-distributed.md)).
  A rule that follows a capture gets an ADR and a code comment. The capture
  and its tests go to the private fidelity suite.
- **A simulated directive** has its steps in
  [recipes.md](https://github.com/Bimmiest/propslab/blob/main/docs/recipes.md#adding-or-changing-a-simulated-directive):
  the code, its class in `directiveSupport.ts`, and a doc-derived test.

## The import boundary

- **The engine has no UI.** It does not import from `components`, `hooks`,
  `store` or `monaco`, or import React, zustand or Monaco. The lint refuses
  these imports.
- **The public API is `index.ts`.** Code outside the engine imports only from
  it, and the lint refuses a deeper import. When a consumer needs a name,
  export it there.
- **No module does anything when it is imported.** `package.json` declares
  `"sideEffects": false`, so a bundler drops each module whose exports the
  app does not use. A module that registers itself at import is dropped too.
- **One runtime dependency, `pcre2-wasm-utf16`.** A pattern that a user wrote
  compiles through `safeRegex` in `src/engine/utils/splunkRegex.ts`, never
  `new RegExp`.

## Gates

The MCP server runs this engine. A change here also runs
`cd packages/mcp-server && npm run test:coverage`.
