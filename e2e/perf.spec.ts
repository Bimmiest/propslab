import type { Page } from '@playwright/test';
import { test, expect, openApp, loadExample, pasteInto } from './fixtures';
import { writeJobSummary, type SummaryRow } from './perfSummary';

/**
 * Performance budget for a large input: 20k events pasted into the raw
 * log, the way a user brings one in. Budgets are about twice the slowest of
 * several local runs (noted beside each): loose enough for CI jitter and GC
 * pauses, tight enough that a regression of kind — an accidental O(n²), a
 * render over every event instead of a page — fails rather than hides.
 */
const EVENTS = 20_000;
// Measured 1.7–4.6 s over eight runs, and up to 5.5 s on a loaded machine;
// paste to status bar.
const PIPELINE_BUDGET_MS = 12_000;
// Measured 4–880 ms per tab over eight runs, rarely above 250; the outliers
// are GC pauses, which land on whichever tab is switching.
const TAB_BUDGET_MS = 1_500;

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
      (t) => t.textContent.trim() === name && t.offsetParent !== null,
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

/** Tab timings as job-summary rows, each against the tab budget. */
function tabRows(timings: Record<string, number>): SummaryRow[] {
  return Object.entries(timings).map(([name, ms]) => ({ name: `${name} (tab switch)`, value: ms, unit: 'ms', budget: TAB_BUDGET_MS }));
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
  writeJobSummary(`Pipeline and tab switches, ${EVENTS} events`, [
    { name: 'Paste to status bar', value: pipelineMs, unit: 'ms', budget: PIPELINE_BUDGET_MS },
    ...tabRows(timings),
  ]);

  for (const [name, ms] of Object.entries(timings)) {
    expect.soft(ms, `${name} tab switch (ms)`).toBeLessThan(TAB_BUDGET_MS);
  }
  expect(complaints.all, 'browser errors under a large input').toEqual([]);
});

/**
 * Many regexes against large events: the shape #415 and #427 regressed on,
 * which the 20k-event test above cannot see because its events are short and
 * its config has one EXTRACT. 800 events of ~1.2 kB (near the 1 MB input cap),
 * each run through 30 EXTRACTs, 4 REPORTs with MV_ADD and 3 index-time
 * TRANSFORMS, one of them rewriting _raw.
 */
const REGEX_EVENTS = 800;
// Measured 1.7–2.9 s, paste to status bar, and up to 5.1 s on a loaded machine.
const REGEX_PIPELINE_BUDGET_MS = 10_000;

function largeLines(count: number): string {
  const levels = ['INFO', 'WARN', 'ERROR', 'DEBUG'];
  const words = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november'.split(' ');
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const kv = Array.from({ length: 40 }, (_, k) => `k${k}=${(i * 31 + k * 7) % 1000}`).join(' ');
    const msg = Array.from({ length: 120 }, (_, w) => words[(i + w) % words.length]).join(' ');
    lines.push(
      `ts=${1_700_000_000 + i} host=web${i % 20} level=${levels[i % 4]} user=u${i % 50} ` +
      `src=10.${i % 256}.${(i * 3) % 256}.${(i * 7) % 256} card=4111111111${String(100000 + i).slice(-6)} ` +
      `path=/api/v${i % 3}/items/${i % 97}/detail.json ${kv} msg="${msg}"`,
    );
  }
  return lines.join('\n');
}

const REGEX_PROPS = [
  '[access_combined]',
  'SHOULD_LINEMERGE = false',
  'TIME_PREFIX = ^ts=',
  'TIME_FORMAT = %s',
  'MAX_TIMESTAMP_LOOKAHEAD = 10',
  'TRUNCATE = 0',
  'TRANSFORMS-idx = t_mask, t_host, t_level',
  ...Array.from({ length: 25 }, (_, k) => `EXTRACT-k${k} = \\bk${k}=(?<f${k}>\\d+)`),
  'EXTRACT-src = src=(?<src_ip>\\d{1,3}(?:\\.\\d{1,3}){3})',
  'EXTRACT-path = path=(?<uri_path>/(?:[\\w.-]+/)*[\\w.-]+)',
  'EXTRACT-msg = msg="(?<message>[^"]*)"',
  'EXTRACT-last = msg=".*?(?<last_word>\\w+)"$',
  'EXTRACT-sev = (?i)\\blevel=(?<severity>error|warn(?:ing)?|info|debug)\\b',
  'REPORT-r = r_pairs, r_words, r_user, r_api',
].join('\n');

const REGEX_TRANSFORMS = `[t_mask]
REGEX = ^(.*card=)\\d{12}(\\d{4})(.*)$
FORMAT = $1XXXXXXXXXXXX$2$3
DEST_KEY = _raw

[t_host]
REGEX = host=(\\S+)
FORMAT = host::$1
DEST_KEY = MetaData:Host

[t_level]
REGEX = level=(\\w+)
FORMAT = lvl::$1
WRITE_META = true

[r_pairs]
REGEX = \\b(k\\d+)=(\\d+)
FORMAT = $1::$2
MV_ADD = true

[r_words]
REGEX = \\b(?<word>(?:alpha|echo|kilo)\\w*)
MV_ADD = true

[r_user]
REGEX = user=(\\w+)
FORMAT = account::$1

[r_api]
REGEX = /api/v(\\d)/items/(\\d+)
FORMAT = api_version::$1 item_id::$2`;

test('a regex-heavy config over large events stays within its budget', async ({ page, complaints }) => {
  test.setTimeout(120_000);
  await openApp(page);
  await loadExample(page, /Apache Access Log/i);
  await pasteInto(page, 1, REGEX_PROPS);
  await pasteInto(page, 2, REGEX_TRANSFORMS);

  const started = Date.now();
  await pasteInto(page, 0, largeLines(REGEX_EVENTS));
  await expect(page.getByText(`${REGEX_EVENTS} events`, { exact: true })).toBeVisible({ timeout: REGEX_PIPELINE_BUDGET_MS });
  const pipelineMs = Date.now() - started;

  const timings: Record<string, number> = {};
  for (const name of ['Fields', 'Pipeline', 'Preview']) timings[name] = await timeTabSwitch(page, name);
  // The config did what it says, so the budget is timing real work.
  await page.getByRole('tab', { name: /^Fields$/ }).click();
  await page.getByRole('textbox', { name: 'Search fields' }).fill('item_id');
  await expect(page.getByRole('cell', { name: 'item_id', exact: true })).toBeVisible();

  const report = { pipelineMs, ...timings };
  console.log(`perf (regex-heavy, ${REGEX_EVENTS} events): ${JSON.stringify(report)}`);
  test.info().annotations.push({ type: 'perf', description: JSON.stringify(report) });
  writeJobSummary(`Regex-heavy config, ${REGEX_EVENTS} large events`, [
    { name: 'Paste to status bar', value: pipelineMs, unit: 'ms', budget: REGEX_PIPELINE_BUDGET_MS },
    ...tabRows(timings),
  ]);
  for (const [name, ms] of Object.entries(timings)) {
    expect.soft(ms, `${name} tab switch (ms)`).toBeLessThan(TAB_BUDGET_MS);
  }
  expect(complaints.all, 'browser errors under a regex-heavy config').toEqual([]);
});

/**
 * One JSON event 3,000 fields wide. The Fields table and the Extractions
 * sidebar are windowed (#454); before that each rendered a row per field.
 */
const WIDE_FIELDS = 3_000;
// Measured 1.2–1.45 s, and up to 2.7 s on a loaded machine. Not the sidebar,
// which is windowed: the event card highlights all 3,000 fields in one raw
// string.
const WIDE_EXTRACTIONS_BUDGET_MS = 5_000;

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
  writeJobSummary(`${WIDE_FIELDS}-field JSON event`, [
    { name: 'Fields (tab switch)', value: fieldsMs, unit: 'ms', budget: TAB_BUDGET_MS },
    { name: 'Extractions (tab switch)', value: extractionsMs, unit: 'ms', budget: WIDE_EXTRACTIONS_BUDGET_MS },
  ]);
  expect.soft(fieldsMs, 'Fields tab switch (ms)').toBeLessThan(TAB_BUDGET_MS);
  expect.soft(extractionsMs, 'Extractions tab switch (ms)').toBeLessThan(WIDE_EXTRACTIONS_BUDGET_MS);
  expect(complaints.all, 'browser errors under a wide event').toEqual([]);
});
