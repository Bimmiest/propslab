import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { writeJobSummary } from './perfSummary';

/**
 * Web Vitals budgets for the first load of the production build (#514).
 *
 * `scripts/check-bundle-size.mjs` measures chunks one at a time, and #467 showed
 * what that misses: every chunk inside its budget while the entry preloaded the
 * whole Monaco chunk and first load got 4 MB heavier. This loads the built app
 * in a fresh browser context — nothing cached, as a first visit — and asserts
 * what a visitor experiences:
 *
 *  - **LCP**, the last `largest-contentful-paint` entry before the app settles;
 *  - **TBT**, total blocking time: the sum of each long task's time over 50 ms,
 *    counted from first contentful paint, taken from the `longtask` timeline
 *    (Lighthouse's definition, less its end-at-TTI cut-off — this counts to the
 *    editors mounting, which is stricter);
 *  - **transferred bytes**, everything fetched from the page, its workers and
 *    the editors' lazy chunks up to the point the app is usable, headers
 *    included.
 *
 * "Usable" is what `openApp` means by it: the shell rendered and all three
 * Monaco editors mounted, followed by a quiet second so late work (the first
 * pipeline run, a deferred chunk) is inside the window rather than just after it.
 *
 * Each figure is the median of three cold loads, so one slow start on a busy
 * runner does not fail a build and one lucky start does not hide a regression.
 * The `perf` project runs without retries (playwright.config.ts): a run over
 * budget fails as measured.
 *
 * **Budgets.** Set from the measurements noted beside each, with headroom that
 * absorbs a slow runner but not a lost code split. The timings are the noisy
 * ones and their headroom is wide; the bytes are deterministic, so theirs is
 * narrow. When a budget trips
 * for a good reason, raise it here in the same change and say why in the commit.
 */
const RUNS = 3;

// Median of three loads, 0.24–0.46 s over five runs (single loads 0.24–0.82 s),
// headless Chromium on a shared 4-core machine, no throttling. About 4x the
// worst median, for a slower CI runner.
const LCP_BUDGET_MS = 2_000;
// Median of three loads, 0.52–1.08 s over five runs (single loads 0.24–1.38 s).
// This is the noisy one: Monaco's parse and the first pipeline run land as long
// tasks whose length depends on the core they get. About 2.3x the worst median;
// a synchronous initialiser added to the entry, or a lost code split, adds
// hundreds of ms on top of this and shows.
const TBT_BUDGET_MS = 2_500;
// 1,439,480 bytes in 13 requests, identical on every run. It is deterministic,
// so its headroom is narrow (11%): monaco-editor.js is 855 kB of it, the wasm 303
// kB, the entry 157 kB. The 4 MB regression of #467 is 2.8x this.
//
// A lower bound, not a total: it is what Playwright reports for the requests
// the page made. Response bodies fetched by a dedicated worker (the pipeline
// worker's script, about 60 kB compressed) are reported without their body, and
// a chunk fetched later than the first quiet second (the pipeline chunk, the
// codicon font) is outside the window. scripts/check-bundle-size.mjs budgets the
// worker files themselves.
const TRANSFER_BUDGET_BYTES = 1_600_000;

interface Vitals {
  lcpMs: number;
  tbtMs: number;
  transferBytes: number;
  requests: number;
  /** The five largest responses, so a jump in bytes says which file grew. */
  largest: string[];
}

/** Recorded from the first script: observers must exist before the page paints. */
async function observeVitals(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const vitals = { lcp: 0, fcp: -1, longTasks: [] as { start: number; duration: number }[] };
    Object.defineProperty(window, '__vitals', { value: vitals });
    const observe = (type: string, onEntry: (entry: PerformanceEntry) => void) => {
      try {
        new PerformanceObserver((list) => list.getEntries().forEach(onEntry)).observe({ type, buffered: true });
      } catch {
        // An entry type this browser lacks: the read below fails on the zero.
      }
    };
    observe('largest-contentful-paint', (entry) => {
      vitals.lcp = entry.startTime;
    });
    observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') vitals.fcp = entry.startTime;
    });
    observe('longtask', (entry) => {
      vitals.longTasks.push({ start: entry.startTime, duration: entry.duration });
    });
  });
}

/** Wait for the app to be usable (see the header), then a quiet second. */
async function waitUntilUsable(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(page.locator('.monaco-editor').nth(2)).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1_000);
}

async function measureFirstLoad(context: BrowserContext): Promise<Vitals> {
  const page = await context.newPage();
  // Sizes are read when a request finishes, so they are all in hand by the
  // time the page is quiet. The context sees worker and lazy-chunk requests
  // as well as the page's own.
  const finished: Promise<{ path: string; bytes: number }>[] = [];
  context.on('requestfinished', (request) => {
    finished.push(
      request
        .sizes()
        .then((s) => ({ path: new URL(request.url()).pathname, bytes: s.responseHeadersSize + s.responseBodySize })),
    );
  });
  await waitUntilUsable(page);
  const responses = await Promise.all(finished);

  const raw = await page.evaluate(
    () =>
      (
        window as unknown as {
          __vitals: { lcp: number; fcp: number; longTasks: { start: number; duration: number }[] };
        }
      ).__vitals,
  );
  await page.close();
  // A page that never painted must fail loudly, not measure as a fast one.
  expect(raw.fcp, 'first-contentful-paint was never reported').toBeGreaterThan(0);
  expect(raw.lcp, 'largest-contentful-paint was never reported').toBeGreaterThan(0);
  const tbt = raw.longTasks
    .filter((task) => task.start >= raw.fcp)
    .reduce((sum, task) => sum + Math.max(0, task.duration - 50), 0);
  const largest = [...responses]
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 5)
    .map((r) => `${r.path} ${r.bytes}`);
  return {
    lcpMs: raw.lcp,
    tbtMs: tbt,
    transferBytes: responses.reduce((sum, r) => sum + r.bytes, 0),
    requests: responses.length,
    largest,
  };
}

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

test('the first load of the production build stays within its Web Vitals budgets', async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const runs: Vitals[] = [];
  for (let i = 0; i < RUNS; i++) {
    // A new context each time: no HTTP cache, no storage, no warm compile cache.
    const context = await browser.newContext({ baseURL, locale: 'en-GB', timezoneId: 'America/Los_Angeles' });
    try {
      await observeVitals(context);
      runs.push(await measureFirstLoad(context));
    } finally {
      await context.close();
    }
  }

  const result = {
    lcpMs: median(runs.map((r) => r.lcpMs)),
    tbtMs: median(runs.map((r) => r.tbtMs)),
    transferBytes: median(runs.map((r) => r.transferBytes)),
    requests: median(runs.map((r) => r.requests)),
  };
  const report = { ...result, largest: runs[0]!.largest, runs };
  console.log(`web vitals (median of ${RUNS} cold loads): ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) });
  writeJobSummary(`Web Vitals, first load of the production build (median of ${RUNS} cold loads)`, [
    { name: 'Largest Contentful Paint', value: result.lcpMs, unit: 'ms', budget: LCP_BUDGET_MS },
    { name: 'Total Blocking Time', value: result.tbtMs, unit: 'ms', budget: TBT_BUDGET_MS },
    { name: 'Transferred', value: result.transferBytes, unit: 'bytes', budget: TRANSFER_BUDGET_BYTES },
    { name: 'Requests', value: result.requests },
  ]);

  expect.soft(result.lcpMs, 'LCP (ms)').toBeLessThan(LCP_BUDGET_MS);
  expect.soft(result.tbtMs, 'TBT (ms)').toBeLessThan(TBT_BUDGET_MS);
  expect.soft(result.transferBytes, 'transferred bytes on first load').toBeLessThan(TRANSFER_BUDGET_BYTES);
});
