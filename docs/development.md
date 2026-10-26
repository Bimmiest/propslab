# Development

This file lists the npm scripts, and what to do if the installation or a test fails. [CONTRIBUTING.md](../CONTRIBUTING.md) gives the process for a change, and the CI checks.

## Prerequisites

- Node 24. The file `.nvmrc` gives the exact version. To select that version, run `nvm use` or `fnm use`.
- npm.
- Git.

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
```

[testing.md](testing.md) describes the two test suites.

## If the installation or a test fails

- **The Node version is too old:** Read `.nvmrc`. To change to that version, run `nvm use` or `fnm use`.
- **The Playwright browser is not installed:** Run `npx playwright install chromium`. The first e2e run needs it.
- **`node_modules` is not current:** Run `rm -rf node_modules && npm install`.
- **An old `dist/` causes E2E failures:** Run `rm -rf dist/ && npm run test:e2e`.
