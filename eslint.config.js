import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Flat config merges `globals` across matching blocks rather than replacing
// them, so a later `globals: globals.node` would leave every browser global
// (window, document, localStorage…) declared too. Code that runs only under
// Node gets the browser set switched off explicitly, so reaching for one is
// reported instead of type-checking and then failing at run time.
const nodeOnlyGlobals = {
  ...Object.fromEntries(Object.keys(globals.browser).map((name) => [name, 'off'])),
  ...globals.node,
}

export default defineConfig([
  // All generated: build output (the app's and any package's), and the
  // reports the test suites write.
  globalIgnores(['**/dist', 'playwright-report', 'test-results', 'coverage', '.stryker-tmp', 'reports', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      // Matches the `target` in tsconfig.app.json, so syntax the build
      // accepts cannot trip the parser.
      ecmaVersion: 2022,
      globals: globals.browser,
      // Type-aware linting. `projectService` resolves each file through the
      // tsconfig that already owns it (app / node / e2e), so the lint and the
      // build agree on types rather than maintaining a second project list.
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Honour the TypeScript convention of prefixing intentionally unused
      // identifiers with _  (common in interface implementations).
      '@typescript-eslint/no-unused-vars': ['error', {
        varsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // A union gains a member (a new directive kind, a new diagnostic code)
      // and every switch over it has to name it: a `default:` does not count
      // as handling a union member, since it is where the new one would
      // silently land.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // With noUncheckedIndexedAccess on, `arr[i]!` after a bounds check is
      // how an index the code has already proven is read; this rule would ask
      // for a runtime guard restating that check at more than 1,100 sites.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // `onClick={() => setOpen(false)}` returns the setter's void; the rule's
      // own option exempts that shorthand, and still reports a void value used
      // anywhere it could be mistaken for a result.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // Counts and offsets go into messages everywhere. Numbers stringify
      // predictably; objects, nullish values and the rest stay reported.
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    rules: {
      // This engine extracts fields whose names collide with Object.prototype
      // members on purpose — `toString`, `valueOf`, `hasOwnProperty` are the
      // subject of prototypeFieldNames.test.ts. Reading `fields['toString']`
      // resolves to the index signature, but the rule matches on the property
      // name and reports every such assertion as an unbound method. The one
      // remaining use is deliberate too (capturing RegExp.prototype.exec to
      // restore it after a spy), and the rule guards against accidental `this`
      // rebinding in shipped code, which is where it stays enabled.
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // The MCP server's tests assert over JSON.parse'd tool output, which is
    // `any` by construction — every access would need a hand-written type
    // guard that restates the expect() right next to it. The unsafe-* family
    // stays on for the package's shipped code.
    files: ['packages/mcp-server/src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // The MCP server is a Node process: stdio, worker_threads,
    // child_process. The app's browser globals describe an environment it
    // never runs in.
    files: ['packages/mcp-server/**/*.{ts,mts}'],
    languageOptions: {
      globals: nodeOnlyGlobals,
    },
  },
  {
    // The MCP server's stdout is its JSON-RPC channel, and the engine runs
    // inside that server (in its workers, whose output would land there too):
    // a stray console.log corrupts the protocol stream. Diagnostics go to
    // stderr, which is what console.error and console.warn write.
    files: ['src/engine/**/*.ts', 'packages/mcp-server/src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // The maintenance scripts, one of which runs weekly in roster.yml. No
    // type-aware rules: they are plain JS outside every tsconfig, which is what
    // projectService needs to see a file. ESM either way: the root
    // package.json is "type": "module".
    files: ['scripts/**/*.{js,mjs}'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Configuration files (build, test, linting, e2e, MCP server): same base
    // rules as scripts. No type-aware linting: these run in Node and need
    // flexible import handling (e.g., .mjs files, optional deps).
    files: [
      'eslint.config.js',
      'stryker.config.mjs',
      'vitest.stryker.config.ts',
      'vite.config.ts',
      'vitest.config.ts',
      'playwright.config.ts',
      'packages/mcp-server/vitest.config.mts',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Size and branching limits for hand-written code, so a function stays a
    // sequence of named steps rather than growing back into a 400-line body.
    // Lines are counted without blanks and comments: the rationale comments kept
    // beside a rule are not what makes a function hard to follow. Same file set
    // as the blocks above, so this adds no files to the lint.
    files: ['**/*.{ts,tsx}', 'packages/mcp-server/**/*.mts', 'scripts/**/*.{js,mjs}'],
    rules: {
      'max-lines-per-function': ['error', { max: 100, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 25],
    },
  },
  {
    // Tests are exempt: a describe() callback holds a whole suite, so its length
    // counts cases, and a table of cases is not branching logic.
    files: [
      '**/__tests__/**/*.{ts,tsx}',
      '**/*.test.{ts,tsx}',
      'e2e/**/*.ts',
      'packages/*/test/**/*.ts',
    ],
    rules: {
      'max-lines-per-function': 'off',
      complexity: 'off',
    },
  },
  {
    // End-to-end tests and the Playwright config run in Node, not the browser,
    // and export helpers alongside their fixtures — neither of which the
    // browser-globals / react-refresh defaults above are about.
    files: ['e2e/**/*.ts', 'playwright.config.ts'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      'react-refresh/only-export-components': 'off',
      // Playwright fixtures take a callback named `use`, which the React rule
      // reads as a hook call outside a component.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
  {
    // The engine layer must remain UI-free: no React, no DOM globals, no
    // UI-specific utilities. Enforce this boundary to keep the engine
    // portable and testable in isolation.
    files: ['src/engine/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error',
        ...[
          '**/components/**',
          '**/hooks/**',
          '**/store/**',
          '**/monaco/**',
          'react',
          'react-dom',
          'zustand',
          'monaco-editor*',
        ].map(pattern => ({
          name: pattern,
          message: 'The engine must stay UI-free. Do not import UI components, hooks, or state management from outside the engine, or React/DOM directly.',
        })),
      ],
    },
  },
])
