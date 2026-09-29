import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * Opt-out of the webServer's rebuild, for callers that just built.
 *
 * The rebuild is the right default (see the `command` note below) and stays on
 * unless something explicitly claims otherwise — an absent flag must never mean
 * "probably fine". CI sets this on the e2e step alone, immediately after its own
 * build step, which is the only place the claim is checked.
 */
const SKIP_BUILD = process.env.E2E_SKIP_BUILD === '1';

/** The specs that assert timing budgets; they run in their own project. */
const PERF_SPECS = /perf\.spec\.ts$/;

/**
 * End-to-end smoke tests, run against a PRODUCTION build.
 *
 * These exist to cover the things vitest structurally cannot reach, all of
 * which have failed silently in this repo before:
 *
 *  - **The Content-Security-Policy.** Its `<meta>` copy lives in `index.html`
 *    and only takes effect in a browser; `vite preview` also sends the header
 *    copy from `public/staticwebapp.config.json`, the one the workers obey.
 *    `img-src` was missing for the whole life of the
 *    policy, so Chromium refused every one of Monaco's `data:` squiggle SVGs
 *    and the lint underlines simply did not draw — visible only as a console
 *    error nobody was watching.
 *  - **Worker bundling.** The entire simulation runs in a Web Worker created
 *    with `new Worker(new URL(...), { type: 'module' })`. Whether Vite emits a
 *    loadable chunk for that is a build-time question with a runtime answer.
 *  - **The Monaco chunk split.** `MonacoEditor.tsx` imports the slim
 *    `monaco-editor/editor` entry and `vite.config.ts` hand-rolls a
 *    `codeSplitting` group around it. A bad split type-checks, builds, and
 *    then fails to mount an editor.
 *
 * The server command BUILDS before serving on purpose. Serving a stale `dist/`
 * produces confident, wrong results — a tightened CSP that is not in the
 * artifact reads as a passing test. `E2E_SKIP_BUILD=1` suppresses it for the
 * one caller that can prove the artifact is current; see `SKIP_BUILD` below.
 */
export default defineConfig({
  testDir: './e2e',
  // A CI failure caused by a stray `test.only` is worse than the inconvenience.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // The suite is small and the server is shared; parallelism buys little and
  // makes the console-error assertions harder to attribute.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    timezoneId: 'America/Los_Angeles',
    locale: 'en-GB',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: PERF_SPECS,
    },
    // The performance budgets, apart from the functional suite (#514): a retry
    // there is a reasonable answer to a flaky click, but here it turns "slower
    // than the budget" into "slower twice", and a regression that is only
    // sometimes over passes on the second try. No retries, so a run over budget
    // fails as measured. Run alone with `playwright test --project=perf`.
    {
      name: 'perf',
      use: { ...devices['Desktop Chrome'] },
      testMatch: PERF_SPECS,
      retries: 0,
    },
  ],
  webServer: {
    // `--host 127.0.0.1` is not redundant with the port. `vite preview` binds
    // `localhost` by default, which on a GitHub Actions runner resolves to `::1`
    // first — so the server comes up on IPv6 only and `BASE_URL`'s 127.0.0.1 is
    // never reachable. The symptom is a webServer timeout with a completely
    // healthy build in the log directly above it.
    command: `${SKIP_BUILD ? '' : 'npm run build && '}npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    // Reusing a stale dist/ produces confident, wrong results; always rebuild to ensure freshness.
    reuseExistingServer: false,
    timeout: 180_000,
    // Piped, not ignored: the server's own startup line ("Local: http://…") is
    // what distinguishes "never bound" from "bound somewhere else", and
    // discarding it is what made the failure above take a log-read to diagnose.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
