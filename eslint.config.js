import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import vitest from '@vitest/eslint-plugin';
import importX from 'eslint-plugin-import-x';
import tseslint from 'typescript-eslint';
import { defineConfig, globalIgnores } from 'eslint/config';
import comments from './scripts/eslint-comments.mjs';
import lintAllowlist from './scripts/lint-allowlist.json' with { type: 'json' };

// Flat config merges `globals` across matching blocks rather than replacing
// them, so a later `globals: globals.node` would leave every browser global
// (window, document, localStorage…) declared too. Code that runs only under
// Node gets the browser set switched off explicitly, so reaching for one is
// reported instead of type-checking and then failing at run time.
const nodeOnlyGlobals = {
  ...Object.fromEntries(Object.keys(globals.browser).map((name) => [name, 'off'])),
  ...globals.node,
};

/**
 * The rule against a module-level `let` (#856), with `names` allowed. Only the
 * page-level singletons below pass names; every other `let` in their files is
 * still reported.
 * @param {string[]} names
 */
const moduleLetRule = (names = []) => [
  'error',
  {
    selector:
      ':matches(Program, ExportNamedDeclaration) > VariableDeclaration[kind="let"]' +
      (names.length > 0 ? `:not(:has(> VariableDeclarator[id.name=/^(${names.join('|')})$/]))` : ''),
    message: 'Do not keep state that changes at module level. Pass it in the context of the operation.',
  },
];

// State that is one per page, or one per process, by design: not the state of
// one operation, so the rule above does not fit it (#865). Each file keeps the
// rule for any other `let`; only these names pass, each for its reason.
const PAGE_SINGLETONS = {
  // Two facts about this page load: it came from a stale-chunk reload, and a
  // reload is under way. A reload ends the page, and both with it.
  'src/staleChunkReload.ts': ['carriedOver', 'reloading'],
  // The one jump to a line that is waiting for its editor: a newer click
  // cancels it, whichever component asked.
  'src/components/editor/revealInEditor.ts': ['cancelPending'],
  // The one guard against the browser's own contextmenu event for the menu
  // key: the page has one keyboard, and a newer press replaces the guard.
  'src/components/ui/ContextMenu.tsx': ['releaseGuard'],
  // The count of error-boundary resets that each lazy component reads. The
  // file says why it is not a context: one lazy component sits under several
  // boundaries.
  'src/components/ui/retryableLazy.tsx': ['resetEpoch'],
  // Monaco's languages, providers and themes are global to the page, so they
  // are registered one time.
  'src/components/editor/splunkMonacoSetup.ts': ['registration'],
  // The page has one TIME_PREFIX worker client, and a request id is unique to it.
  'src/monaco/timePrefixMatcher.ts': ['nextId'],
  // The regex engine compiles one time in each realm: the page, and each worker.
  'src/workers/regexEngineLoader.ts': ['loading'],
  // The FC_SEED notice prints one time in each test process.
  'src/test/fcSeed.ts': ['seedLogged'],
};

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
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          varsIgnorePattern: '^_',
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // A union gains a member (a new directive kind, a new diagnostic code)
      // and every switch over it has to name it: a `default:` does not count
      // as handling a union member, since it is where the new one would
      // silently land.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      // Shipped code narrows or guards instead of asserting: a `!` is a claim
      // the compiler cannot check, and in code that runs on users' configs a
      // wrong claim is a crash. The test override below turns it off, where
      // `arr[i]!` after a length assertion is how a case reads its subject.
      '@typescript-eslint/no-non-null-assertion': 'error',
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
    // Test code and its support files. With noUncheckedIndexedAccess on,
    // `result[0]!` after `expect(result).toHaveLength(1)` is how a case reads
    // the thing it just asserted exists; the rule would ask for a runtime guard
    // restating the expect() beside it, at about a thousand sites.
    files: [
      '**/__tests__/**/*.{ts,tsx,mts}',
      '**/*.test.{ts,tsx,mts}',
      'src/test/**/*.{ts,tsx}',
      'e2e/**/*.ts',
      'packages/*/test/**/*.ts',
    ],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    // What makes a test a test. `expect-expect` fails a case that asserts
    // nothing (it passes whatever the code does), `no-identical-title` a case
    // whose name repeats a sibling's (one of the two is then unfindable in a
    // report, and often a copy that was never edited), and `valid-expect` an
    // `expect(...)` that is never finished or an async one that is not awaited
    // (it asserts nothing, and passes). Playwright's specs are not vitest and
    // stay out.
    files: ['**/__tests__/**/*.{ts,tsx,mts}', '**/*.test.{ts,tsx,mts}'],
    plugins: { vitest },
    rules: {
      // A helper that asserts on the test's behalf is named `expect…`, which
      // the pattern covers, so a new one takes that name rather than an entry.
      // `fc.assert` is the one other assertion: it throws with the shrunk
      // counterexample when a property is false, whether the property asserts
      // with `expect` or returns a boolean.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect', 'expect*', 'fc.assert'] }],
      'vitest/no-identical-title': 'error',
      // Vitest's expect takes a failure message as its second argument.
      'vitest/valid-expect': ['error', { maxArgs: 2 }],
    },
  },
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}', 'src/**/*.test.{ts,tsx}'],
    rules: {
      // A test captures a prototype method to restore it after a spy
      // (`SplunkRegex.prototype.exec` in timePrefixMatcher.test.ts), which the
      // rule reports as an unbound method. The rule guards against accidental
      // `this` rebinding in shipped code, which is where it stays enabled.
      '@typescript-eslint/unbound-method': 'off',
      // A test says which clock it runs under (runCtx.ts, #507): runPipeline
      // falls back to Date.now(), and a date that is fine today trips
      // MAX_DAYS_AGO in a few years. Its options, the fifth argument, carry
      // `now`: a literal must name it, or pass something that does
      // (FIXED_NOW, AT_FIXED_NOW, runCtx()). #572.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.name='runPipeline'][arguments.length<5]:not(:has(> SpreadElement))",
          message: 'Pass runPipeline its options with `now` (FIXED_NOW from src/test/runCtx.ts).',
        },
        {
          selector:
            "CallExpression[callee.name='runPipeline'] > ObjectExpression:nth-child(5):not(:has(> Property[key.name='now'])):not(:has(> SpreadElement))",
          message: 'runPipeline options need `now` (FIXED_NOW from src/test/runCtx.ts).',
        },
      ],
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
    files: ['packages/mcp-server/src/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['error', 'warn'] }],
    },
  },
  {
    // The maintenance scripts, some of which run on a schedule. No
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
      'packages/mcp-server/perf/*.mjs',
    ],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },
  {
    // Import order: Node built-ins, then packages, then the project's own files
    // (parent, sibling and index alike). The one thing the codebase already did
    // by habit, so the rule holds a line rather than starting a reorder: within
    // a group the order is the author's, and blank lines are Prettier's.
    // Side-effect imports (`import './setup'`) are not ordered by the rule, which
    // matters where one has to run first (a Monaco stub before the editor). The
    // fixer moves whole declarations, so `eslint --fix` applies it.
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { 'import-x': importX },
    rules: {
      'import-x/order': [
        'error',
        { groups: ['builtin', 'external', ['parent', 'sibling', 'index']], 'newlines-between': 'ignore' },
      ],
    },
  },
  {
    // The comment rules in docs/code-style.md ("Code comments") that a tool can
    // check: a TODO names its issue, and code is not kept in a comment. From
    // repo-template, as in propslab-sb and propslab-ent (#731).
    files: ['**/*.{ts,tsx,js,mjs}'],
    plugins: { comments },
    rules: { 'comments/todo-has-issue': 'error', 'comments/no-commented-out-code': 'error' },
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
      // Past four positional parameters a call is a row of bare values matched
      // by position, and a caller passes a default only to reach a later one,
      // so a function that needs more takes one options object (#856, from
      // repo-template). Four, not three: three reports callbacks whose list a
      // library defines, where the author does not choose it.
      'max-params': ['error', 4],
    },
  },
  {
    // State that changes at module level is a hidden input to every function
    // that reads it: two callers in one process share it, and a test cannot
    // give a function another value without changing the module. It belongs to
    // the object that owns the operation, passed in that operation's context
    // (#856, from repo-template). A module-level `const` holding a Map or a Set
    // is not matched; a cache of that shape is left to review.
    //
    // Tests are exempt: a `let` that `beforeEach` sets is how a suite shares a
    // fixture. They are left out with `ignores` rather than overridden, because
    // a later block's `no-restricted-syntax` replaces an earlier block's list
    // for the same file instead of adding to it; the runPipeline block above
    // covers test files only, so the two lists never meet on one file.
    files: ['**/*.{ts,tsx}', 'packages/mcp-server/**/*.mts', 'scripts/**/*.{js,mjs}'],
    ignores: ['**/__tests__/**', '**/*.test.{ts,tsx,mts,mjs}', 'e2e/**', 'packages/*/test/**'],
    rules: {
      'no-restricted-syntax': moduleLetRule(),
    },
  },
  ...Object.entries(PAGE_SINGLETONS).map(([file, names]) => ({
    files: [file],
    rules: { 'no-restricted-syntax': moduleLetRule(names) },
  })),
  {
    // Tests are exempt from length and branching: a describe() callback holds a
    // whole suite, so its length counts cases, and a table of cases is not
    // branching logic. `max-params` stays on, because a test helper with many
    // positional arguments is as hard to read as shipped code.
    files: ['**/__tests__/**/*.{ts,tsx}', '**/*.test.{ts,tsx}', 'e2e/**/*.ts', 'packages/*/test/**/*.ts'],
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
    // The fallbacks that the supported-browser rule keeps (ADR 0022). Each
    // calls an API that no-deprecated reports, on purpose:
    // - SelectableRaw: caretRangeFromPoint, until caretPositionFromPoint is
    //   Baseline widely available (#833); its test stubs that fallback.
    // - useUnloadWarning: returnValue, which MDN still sets for older browsers.
    // - clipboard: execCommand('copy'), for an insecure context, where
    //   navigator.clipboard does not exist.
    files: [
      'src/components/preview/tabs/shared/SelectableRaw.tsx',
      'src/components/preview/tabs/shared/__tests__/SelectableRaw.test.tsx',
      'src/hooks/useUnloadWarning.ts',
      'src/utils/clipboard.ts',
    ],
    rules: { '@typescript-eslint/no-deprecated': 'off' },
  },
  {
    // No rule is turned off at a call site (CLAUDE.md): an exception goes in
    // this file, scoped to its files, with its reason. With inline config off,
    // an `eslint-disable` comment has no effect, so the rule that it hid fails
    // the lint (#774).
    files: ['**/*.{ts,tsx,js,mjs}', 'packages/mcp-server/**/*.mts'],
    linterOptions: { noInlineConfig: true },
  },
  // The findings that existed when a rule was adopted, off for their files
  // only (docs/code-style.md). Last, so that it wins over the blocks that turn
  // the rules on. CI's lint-allowlist-check lints the same files with the
  // rules on again and fails when a count changes, so this hides no new code.
  // Each path is escaped, because `files` takes a glob and `[id]` is a
  // character class.
  ...Object.entries(lintAllowlist.files).map(([file, rules]) => ({
    files: [file.replace(/[\\[\]{}()*?!+@]/g, '\\$&')],
    rules: Object.fromEntries(Object.keys(rules).map((rule) => [rule, 'off'])),
  })),
]);
