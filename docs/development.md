---
type: how-to
---

# Development

This file tells you how to set up a checkout, lists the npm scripts, and tells you what to do if the installation or a test fails. [CONTRIBUTING.md](../CONTRIBUTING.md) gives the process for a change, and [ci.md](ci.md) gives the CI checks.

## Prerequisites

- Node 26. The file `.nvmrc` gives the exact version. To select that version, run `nvm use` or `fnm use`.
- npm.
- Git.

## Set up

Node is pinned in [`.nvmrc`](../.nvmrc), matched by `engines` in `package.json`, and used by CI. Use that version; a different major will produce failures that have nothing to do with your change. `.npmrc` sets `engine-strict=true` (and so does `packages/mcp-server/.npmrc`), so npm refuses to install on a Node older than `engines` instead of failing later.

```bash
nvm use            # or: fnm use
npm install
npm ci --prefix packages/mcp-server
npm run dev        # http://localhost:5173
```

The `npm ci --prefix packages/mcp-server` is not optional if you intend to lint. `npm run lint` is type-aware over the whole repository, including `packages/mcp-server`, and that package resolves `@modelcontextprotocol/sdk` and `zod` from its own `node_modules`. Without them those types don't resolve and every use reports as an unsafe `any` — a wall of errors that have nothing to do with your change.

`CLAUDE.md` names the rules that are expensive to break here, for people and for coding agents, as in `repo-template`. `.claude/` is git-ignored, for each contributor's local agent configuration.

## Scripts

A test (`src/__tests__/docs.test.ts`) holds this list to the scripts in `package.json`.

```bash
npm install
npm ci --prefix packages/mcp-server  # lint is type-aware over the MCP server too
npm run dev          # Dev server on http://localhost:5173
npm run build        # tsc -b && vite build → dist/
npm run typecheck    # tsc -b alone: every tsconfig project, no bundle
npm run preview      # Serve production build
npm run lint         # ESLint
npm run format       # Prettier: rewrite the TypeScript and JavaScript sources
npm run format:check # …or only report what it would change, as CI does
npm test             # vitest (one-shot)
npm run test:coverage # …with the coverage floor enforced, as CI runs it
npm run test:watch   # vitest watch mode
npm run test:e2e     # Playwright smoke tests (builds, then serves dist/)
npm run test:e2e:ui  # …in Playwright's interactive runner
npm run test:mutation # Stryker mutation testing
npm run test:mutation:canary # 40-second check that Stryker still kills mutants (the vitest shim)
npm run check:overrides # Verify the @radix-ui overrides match what the Radix packages pin, and that each scoped override is still needed
npm run screenshot:readme # Build, then take the README screenshot (docs/assets/demo.png) again with the same setup
```

[testing.md](testing.md) describes the two test suites.

## If the installation or a test fails

- **The Node version is too old:** Read `.nvmrc`. To change to that version, run `nvm use` or `fnm use`.
- **The Playwright browser is not installed:** Run `npx playwright install chromium`. The first e2e run needs it.
- **`node_modules` is not current:** Run `rm -rf node_modules && npm install`.
- **An old `dist/` causes E2E failures:** Run `rm -rf dist/ && npm run test:e2e`.
