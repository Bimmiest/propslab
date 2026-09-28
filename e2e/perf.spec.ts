import type { Page } from '@playwright/test';
import { test, expect, openApp, loadExample } from './fixtures';

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
 * Replace an editor's text through Monaco's own paste path: a `paste` event on
 * the editor's input carrying the text, as the browser delivers a real Ctrl+V.
 */
async function pasteInto(page: Page, editor: number, text: string): Promise<void> {
  await page.locator('.monaco-editor').nth(editor).click();
  await page.keyboard.press('Control+a');
  await page.evaluate((data) => {
    const input = document.activeElement;
    if (!input) throw new Error('editor has no focused input');
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', data);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
  }, text);
}

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
