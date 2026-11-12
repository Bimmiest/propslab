import type { Locator, Page } from '@playwright/test';
import { test, expect, loadExample, pasteInto } from './fixtures';

/**
 * The layout between a phone and a small laptop (#893): each control is
 * readable and reachable at each width, with data loaded. The phone layout
 * starts below 768 px, so 820 and 1024 px get the two columns at their
 * narrowest. jsdom lays nothing out, so this is the only place that can
 * measure an overflow or a cut.
 */

const PALO_ALTO = /Palo Alto Firewall/i;
const APACHE = /Apache Access Log/i;

async function openAt(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: width < 768 ? 844 : 800 });
  await page.goto('/');
  // The phone mounts one editor at a time, the two columns three.
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
}

/** Whether `el` holds more than it shows, sideways. */
const overflowsX = (el: Locator) => el.evaluate((e) => e.scrollWidth > e.clientWidth + 1);

/** The box of `el`, which must be rendered. */
async function box(el: Locator) {
  const b = await el.boundingBox();
  if (!b) throw new Error(`${String(el)} is not rendered`);
  return b;
}

/**
 * `el` is visible and its whole box is inside the window, once what slides in
 * (the field drawer, a popup) has arrived. A pixel of slack for sub-pixel layout.
 */
async function expectOnScreen(page: Page, el: Locator): Promise<void> {
  await expect(el).toBeVisible();
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));
  const b = await box(el);
  const width = page.viewportSize()?.width ?? 0;
  expect(b.x, `${String(el)} starts on screen`).toBeGreaterThanOrEqual(-1);
  expect(b.x + b.width, `${String(el)} ends on screen`).toBeLessThanOrEqual(width + 1);
}

/**
 * A tab row fits the window, and each label in it is whole: a row that holds
 * more than it shows marks the cut edge for the fade, and its last tab can be
 * scrolled to and chosen.
 */
async function expectTabRowReachable(page: Page, tablist: Locator): Promise<void> {
  await expectOnScreen(page, tablist);
  const tabs = tablist.getByRole('tab');
  for (const tab of await tabs.all()) {
    expect(await overflowsX(tab), `${await tab.innerText()} is not cut`).toBe(false);
  }
  if (await overflowsX(tablist)) await expect(tablist).toHaveAttribute('data-cut-end', '');
  const last = tabs.last();
  await last.scrollIntoViewIfNeeded();
  await expectOnScreen(page, last);
}

async function expectHeaderFits(page: Page): Promise<void> {
  const banner = page.getByRole('banner');
  expect(await overflowsX(banner)).toBe(false);
  const clearAll = banner.getByRole('button', { name: 'Clear All' });
  await expectOnScreen(page, clearAll);
  // One line: a wrapped label doubled its height.
  expect((await box(clearAll)).height).toBeLessThan(32);
  for (const button of await banner.getByRole('button').all()) await expectOnScreen(page, button);
  // The logo and the title do not touch the buttons.
  const title = await box(banner.getByRole('heading', { name: 'Propslab' }));
  const examples = await box(banner.getByRole('button', { name: 'Examples' }));
  expect(title.x + title.width).toBeLessThan(examples.x);
  // No sideways scroll of the page itself.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test.describe('the phone layout at 390 px (#893)', () => {
  test.beforeEach(async ({ page }) => {
    await openAt(page, 390);
    await loadExample(page, PALO_ALTO);
  });

  test('the header fits, and its other actions are in one menu', async ({ page }) => {
    await expectHeaderFits(page);
    const banner = page.getByRole('banner');
    await banner.getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('group', { name: 'More' });
    await expectOnScreen(page, menu);
    await menu.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();
  });

  test('the panel tabs and the output tabs are whole and reachable', async ({ page }) => {
    const panels = page.getByRole('tablist', { name: 'Workspace panels' });
    await expectTabRowReachable(page, panels);
    await expect(panels.getByRole('tab', { name: 'transforms', exact: true })).toBeVisible();
    await panels.getByRole('tab', { name: 'Output', exact: true }).click();
    await expectTabRowReachable(page, page.getByRole('tablist', { name: 'Output tabs' }));
  });

  test('the Extractions field list is closed, and opens as a drawer over the events', async ({ page }) => {
    await page.getByRole('tab', { name: 'Output', exact: true }).click();
    await page.getByRole('tab', { name: /^Extractions$/ }).click();
    const filter = page.getByRole('textbox', { name: 'Filter fields' });
    await expect(filter).toHaveCount(0);
    // The last of the category choices is not cut off by the row.
    await expectOnScreen(page, page.getByRole('button', { name: /^All\s*\(\d+\)$/ }));
    await page.getByRole('button', { name: 'Field list', exact: true }).click();
    await expectOnScreen(page, filter);
    // Wide enough to read the names: it was a fifth of the width.
    expect((await box(filter)).width).toBeGreaterThan(200);
    await expectOnScreen(page, page.locator('[data-field-row="bytes_received"]'));
    await filter.press('Escape');
    await expect(filter).toHaveCount(0);
  });

  test('the Fields table shows that it scrolls sideways', async ({ page }) => {
    await page.getByRole('tab', { name: 'Output', exact: true }).click();
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    const scroller = page.locator('table').locator('xpath=..');
    expect(await overflowsX(scroller)).toBe(true);
    await expect(scroller).toHaveAttribute('data-cut-end', '');
    await scroller.evaluate((e) => {
      e.scrollLeft = e.scrollWidth;
    });
    await expect(scroller).toHaveAttribute('data-cut-start', '');
    await expect(scroller).not.toHaveAttribute('data-cut-end');
  });
});

for (const width of [820, 1024]) {
  test.describe(`the two columns at ${String(width)} px (#893)`, () => {
    test.beforeEach(async ({ page }) => {
      await openAt(page, width);
      await loadExample(page, PALO_ALTO);
    });

    test('the header fits', async ({ page }) => {
      await expectHeaderFits(page);
    });

    test('the output tabs are whole and reachable, with a fade at the cut', async ({ page }) => {
      await expectTabRowReachable(page, page.getByRole('tablist', { name: 'Output tabs' }));
    });

    test('the pane headers do not wrap or collide', async ({ page }) => {
      const rawLog = page.getByText('Raw Log', { exact: true });
      // One line of text-xs.
      expect((await box(rawLog)).height).toBeLessThan(20);
      // The raw log's footer and both editors: none is cut at its pane's edge.
      const clears = page.getByRole('button', { name: 'Clear', exact: true });
      await expect(clears).toHaveCount(3);
      for (const clear of await clears.all()) {
        await expectOnScreen(page, clear);
        const insideRow = await clear.evaluate((e) => {
          const row = e.closest('[class~="@container"]')?.getBoundingClientRect();
          const own = e.getBoundingClientRect();
          return row !== undefined && own.left >= row.left - 1 && own.right <= row.right + 1;
        });
        expect(insideRow, 'a Clear button inside the row of its pane').toBe(true);
      }
      for (const file of ['props.conf', 'transforms.conf']) {
        const title = page.getByTitle(`Collapse ${file}`);
        const header = title.locator('xpath=..');
        const clear = header.getByRole('button', { name: 'Clear', exact: true });
        const copy = header.getByRole('button', { name: 'Copy to clipboard' });
        await expectOnScreen(page, clear);
        await expectOnScreen(page, copy);
        expect((await box(title)).x + (await box(title)).width, `${file} title clears its buttons`).toBeLessThan(
          (await box(clear)).x,
        );
        expect(await overflowsX(header)).toBe(false);
      }
    });

    test('the Extractions field list is closed, and opens wide enough to tell the names apart', async ({ page }) => {
      await page.getByRole('tab', { name: /^Extractions$/ }).click();
      const filter = page.getByRole('textbox', { name: 'Filter fields' });
      await expect(filter).toHaveCount(0);
      await page.getByRole('button', { name: 'Field list', exact: true }).click();
      await expect(filter).toBeVisible();
      for (const name of ['bytes_received', 'bytes_sent', 'bytes_total']) {
        const row = page.locator(`[data-field-row="${name}"]`);
        await expectOnScreen(page, row);
        // The end of each name stays on screen, whole.
        const tail = row.locator('span.shrink-0', { hasText: name.slice(-6) });
        expect(await overflowsX(tail)).toBe(false);
        await expect(row).toHaveAccessibleName(name);
        await expect(row.locator(`[title="${name}"]`)).toHaveCount(1);
      }
    });
  });
}

test.describe('the desktop at 1280 px keeps its layout (#893)', () => {
  test('the header shows its labels and buttons, and the field list starts open', async ({ page }) => {
    await openAt(page, 1280);
    await loadExample(page, PALO_ALTO);
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('button', { name: 'Clear All' })).toHaveText('Clear All');
    await expect(banner.getByRole('button', { name: 'Open settings' })).toBeVisible();
    await expect(banner.getByRole('button', { name: 'More' })).toBeHidden();
    await expect(page.getByTitle('Collapse props.conf').locator('xpath=..').getByText('Copy')).toBeVisible();
    await page.getByRole('tab', { name: /^Extractions$/ }).click();
    await expect(page.getByRole('textbox', { name: 'Filter fields' })).toBeVisible();
  });
});

// The functional test of the phone layout that #891 asks for: an edit, a
// switch to Output, and a result read from it, all at 390 px.
test('at 390 px an edit to props.conf reaches the Output panel (#891)', async ({ page }) => {
  await openAt(page, 390);
  await loadExample(page, APACHE);

  await page.getByRole('tab', { name: 'props', exact: true }).click();
  // The phone mounts one editor: the props.conf one is the first.
  await pasteInto(page, 0, '\nEVAL-phone_marker = "on a phone"\n', 'end');

  await page.getByRole('tab', { name: 'Output', exact: true }).click();
  await page.getByRole('tab', { name: /^Fields$/ }).click();
  await page.getByRole('textbox', { name: /search fields/i }).fill('phone_marker');
  const row = page.locator('tbody tr', { hasText: 'phone_marker' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('5/5');
});
