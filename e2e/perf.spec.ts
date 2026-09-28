import type { Page } from '@playwright/test';
import { test, expect, openApp, loadExample, pasteInto } from './fixtures';

/**
 * Performance budget for a large input: 20k events pasted into the raw
 * log, the way a user brings one in. Budgets are several times what a local
 * run measures (noted beside each), so they catch a regression of kind — an
 * accidental O(n²), a render over every event instead of a page — rather than
 * CI jitter.
 */
const EVENTS = 20_000;
const PIPELINE_BUDGET_MS = 20_000; // measured 3.1–4.5 s, paste to status bar
const TAB_BUDGET_MS = 3_000; // measured 10–790 ms per tab; GC pauses make it noisy

/**
 * The pipeline caps input at 1 MB (pipeline.ts), so 20k events need lines
 * under ~50 characters: a compact key=value format rather than Apache's.
 */
function kvLines(count: number): string {
  const methods = ['GET', 'POST', 'PUT', 'DELETE'];
  const statuses = [200, 201, 301, 404, 500];
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`t=${1_700_000_000 + i} s=${statuses[i % 5]} b=${(i * 37) % 9000} m=${methods[i % 4]} u=/p/${i % 500}`);
  }
  return lines.join('\n');
}

// Timestamping, search-time KV, an EXTRACT and EVALs: the stages whose cost
// grows with the event count.
const PROPS = `[access_combined]
TIME_PREFIX = ^t=
TIME_FORMAT = %s
MAX_TIMESTAMP_LOOKAHEAD = 10
SHOULD_LINEMERGE = false
KV_MODE = auto
EXTRACT-path = u=/p/(?P<page>\\d+)
EVAL-ok = if(s < 400, "true", "false")
EVAL-kb = round(b / 1024, 1)`;

/**
 * Click a tab and time it until the main thread settles: the end of the last
 * frame that was held up (>50 ms) before a quiet 300 ms. That covers the
 * synchronous render and any follow-up work — a worker reply, a deferred
 * render — that janks the tab after it first paints.
 */
async function timeTabSwitch(page: Page, tabName: string): Promise<number> {
  return page.evaluate(async (name) => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find(
      (t) => t.textContent?.trim() === name && t.offsetParent !== null,
    );
    if (!tab) throw new Error(`no visible tab named ${name}`);
    const start = performance.now();
    tab.click();
    return new Promise<number>((resolve) => {
      let busyUntil = -1;
      let last = start;
      const frame = () => {
        const now = performance.now();
        if (busyUntil < 0 || now - last > 50) busyUntil = now;
        last = now;
        if (now - busyUntil > 300) resolve(busyUntil - start);
        else requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }, tabName);
}

test('a 20k-event paste stays within the pipeline and tab-switch budgets', async ({ page, complaints }) => {
  test.setTimeout(180_000);
  await openApp(page);
  // For its metadata (sourcetype access_combined); both inputs are replaced.
  await loadExample(page, /Apache Access Log/i);
  await pasteInto(page, 1, PROPS);

  const started = Date.now();
  await pasteInto(page, 0, kvLines(EVENTS));
  await expect(page.getByText(`${EVENTS} events`, { exact: true })).toBeVisible({ timeout: PIPELINE_BUDGET_MS });
  const pipelineMs = Date.now() - started;

  const timings: Record<string, number> = {};
  const previewSubTabs = ['Timestamp', 'Extractions', 'Diff', 'Regex', 'Raw'];
  const outputTabs = ['CIM Models', 'Fields', 'Pipeline', 'Effective config', 'Architecture', 'Preview'];

  await page.getByRole('tab', { name: /^Preview$/ }).click();
  const exact = (name: string) => page.getByRole('tab', { name: new RegExp(`^${name}$`) });
  for (const name of previewSubTabs) {
    timings[`Preview › ${name}`] = await timeTabSwitch(page, name);
    await expect(exact(name)).toHaveAttribute('aria-selected', 'true');
  }
  for (const name of outputTabs) {
    timings[name] = await timeTabSwitch(page, name);
    await expect(exact(name)).toHaveAttribute('aria-selected', 'true');
  }

  const report = { pipelineMs, ...timings };
  console.log(`perf (${EVENTS} events): ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) });

  for (const [name, ms] of Object.entries(timings)) {
    expect.soft(ms, `${name} tab switch (ms)`).toBeLessThan(TAB_BUDGET_MS);
  }
  expect(complaints.all, 'browser errors under a large input').toEqual([]);
});

/**
 * One JSON event 3,000 fields wide. The Fields table and the Extractions
 * sidebar are windowed (#454); before that each rendered a row per field.
 */
const WIDE_FIELDS = 3_000;
// Measured 1.2–1.45 s. Not the sidebar, which is windowed: the event card
// highlights all 3,000 fields in one raw string.
const WIDE_EXTRACTIONS_BUDGET_MS = 3_000;

test('a 3,000-field JSON event renders a window of the Fields table and sidebar', async ({ page, complaints }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await loadExample(page, /Apache Access Log/i);
  await pasteInto(page, 1, '[access_combined]\nSHOULD_LINEMERGE = false\nTRUNCATE = 0\nKV_MODE = json');
  const wide = Object.fromEntries(
    Array.from({ length: WIDE_FIELDS }, (_, i) => [`g${i % 30}_f${i}`, `v${i}`]),
  );
  await pasteInto(page, 0, JSON.stringify(wide));
  await expect(page.getByText('1 event', { exact: true })).toBeVisible({ timeout: 30_000 });

  const fieldsMs = await timeTabSwitch(page, 'Fields');
  const table = page.getByRole('table');
  // Every JSON key, plus the few default fields (host, source, …), plus the header.
  await expect.poll(async () => Number(await table.getAttribute('aria-rowcount'))).toBeGreaterThan(WIDE_FIELDS);
  expect(await table.locator('tbody tr[aria-rowindex]').count()).toBeLessThan(200);

  // Scrolled to the end, the last row is rendered and numbered as such.
  await table.locator('xpath=..').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const rowCount = Number(await table.getAttribute('aria-rowcount'));
  await expect(table.locator(`tbody tr[aria-rowindex="${rowCount}"]`)).toBeInViewport();

  await page.getByRole('tab', { name: /^Preview$/ }).click();
  const extractionsMs = await timeTabSwitch(page, 'Extractions');
  const sidebar = page.getByRole('textbox', { name: 'Filter fields' }).locator('xpath=ancestor::div[contains(@class,"flex-col")][1]');
  expect(await sidebar.locator('[data-window-row]').count()).toBeLessThan(200);

  console.log(`perf (${WIDE_FIELDS}-field JSON): ${JSON.stringify({ fieldsMs, extractionsMs })}`);
  expect.soft(fieldsMs, 'Fields tab switch (ms)').toBeLessThan(TAB_BUDGET_MS);
  expect.soft(extractionsMs, 'Extractions tab switch (ms)').toBeLessThan(WIDE_EXTRACTIONS_BUDGET_MS);
  expect(complaints.all, 'browser errors under a wide event').toEqual([]);
});
