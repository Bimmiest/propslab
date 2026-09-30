import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, openApp, loadExample, pasteInto } from './fixtures';

const APACHE = /Apache Access Log/i;

/**
 * axe-core scans of every main view, in both themes: most of what axe
 * finds here is contrast, and the two palettes fail differently.
 *
 * Nothing is excluded, Monaco included — its colours come from our own
 * splunk-light/splunk-dark themes, so its violations are ours to fix.
 */
async function expectNoViolations(page: Page, label: string): Promise<void> {
  // Let transitions settle so contrast is measured on final colours.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))));

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'])
    .analyze();

  const report = results.violations.map((v) => ({
    rule: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.map((n) => `${n.target.join(' ')} — ${n.failureSummary?.split('\n').slice(1).join(' ').trim()}`),
  }));
  // Soft, so one test reports every view's violations rather than the first.
  expect.soft(report, `axe violations in ${label}`).toEqual([]);
}

for (const theme of ['dark', 'light'] as const) {
  test.describe(`accessibility (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('propslab:theme', t);
        } catch {
          /* ignore */
        }
      }, theme);
    });

    test('simulator, empty and loaded', async ({ page }) => {
      await openApp(page);
      await expectNoViolations(page, 'simulator (empty)');
      await loadExample(page, APACHE);
      await expectNoViolations(page, 'simulator (Apache example)');
    });

    // One test per tab: each axe scan takes a few seconds, and ten in one
    // test ran close to the default timeout on a loaded machine.
    for (const sub of ['Raw', 'Timestamp', 'Extractions', 'Diff', 'Regex']) {
      test(`preview sub-tab ${sub}`, async ({ page }) => {
        await openApp(page);
        await loadExample(page, APACHE);
        await page.getByRole('tab', { name: new RegExp(`^${sub}$`) }).click();
        await expectNoViolations(page, `Preview › ${sub}`);
      });
    }
    for (const tab of ['CIM Models', 'Fields', 'Pipeline', 'Effective config', 'Architecture']) {
      test(`output tab ${tab}`, async ({ page }) => {
        await openApp(page);
        await loadExample(page, APACHE);
        await page.getByRole('tab', { name: new RegExp(`^${tab}$`) }).click();
        await expectNoViolations(page, tab);
      });
    }

    test('dictionary', async ({ page }) => {
      await openApp(page);
      await page.getByRole('tab', { name: 'Dictionary' }).click();
      await expect(page.getByRole('listbox', { name: 'Splunk directives' })).toBeVisible();
      await expectNoViolations(page, 'dictionary');
    });

    test('command palette', async ({ page }) => {
      await openApp(page);
      await page.keyboard.press('Control+k');
      await expect(page.getByRole('dialog')).toBeVisible();
      await expectNoViolations(page, 'command palette');
    });

    test('settings', async ({ page }) => {
      await openApp(page);
      await page.getByRole('button', { name: 'Open settings' }).click();
      await expect(page.getByRole('button', { name: 'Close settings' })).toBeVisible();
      await expectNoViolations(page, 'settings');
    });

    test('header info panel', async ({ page }) => {
      await openApp(page);
      await page.getByRole('button', { name: 'Open pipeline reference' }).click();
      await expect(page.getByRole('button', { name: 'Close panel' })).toBeVisible();
      await expectNoViolations(page, 'pipeline reference');
    });

    test('mobile layout', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto('/');
      await expect(page.getByRole('tablist', { name: 'Workspace panels' })).toBeVisible();
      await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 30_000 });
      await expectNoViolations(page, 'mobile › Raw');

      for (const panel of ['props', 'transforms', 'Output', 'Docs']) {
        await page.getByRole('tab', { name: panel, exact: true }).click();
        await expectNoViolations(page, `mobile › ${panel}`);
      }
    });
  });
}

/**
 * States the example-driven scans above never reach (#493): a dropped and a
 * routed event, a nested JSON parent, a diff with added and removed lines, and
 * CIM models that match nothing. Each one was a contrast failure that no scan
 * saw because nothing put the page in that state.
 */
for (const theme of ['dark', 'light'] as const) {
  test.describe(`accessibility of de-emphasised states (${theme})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('propslab:theme', t);
        } catch {
          /* ignore */
        }
      }, theme);
    });

    async function openDroppedAndRouted(page: Page): Promise<void> {
      await openApp(page);
      await loadExample(page, APACHE);
      await pasteInto(
        page,
        1,
        [
          '[access_combined]',
          'SHOULD_LINEMERGE = false',
          'KV_MODE = json',
          'SEDCMD-rename = s/keep/kept/',
          'TRANSFORMS-queues = drop_it, route_it',
        ].join('\n'),
      );
      await pasteInto(
        page,
        2,
        [
          '[drop_it]',
          'REGEX = drop me',
          'DEST_KEY = queue',
          'FORMAT = nullQueue',
          '',
          '[route_it]',
          'REGEX = route me',
          'DEST_KEY = queue',
          'FORMAT = parsingQueue',
        ].join('\n'),
      );
      await pasteInto(
        page,
        0,
        [
          '{"src":"10.0.0.1","user":"alice","user.id":1,"user.dept":"ops","msg":"keep"}',
          '{"src":"10.0.0.2","user":"bob","user.id":2,"user.dept":"ops","msg":"drop me"}',
          '{"src":"10.0.0.3","user":"carol","user.id":3,"user.dept":"ops","msg":"route me"}',
        ].join('\n'),
      );
      await expect(page.getByText('3 events', { exact: true })).toBeVisible({ timeout: 30_000 });
    }

    test('Raw: a dropped row and a routed badge', async ({ page }) => {
      await openDroppedAndRouted(page);
      await page.getByRole('tab', { name: /^Raw$/ }).click();
      await expect(page.getByText('Dropped', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Routed \(parsingQueue\)$/)).toBeVisible();
      await expectNoViolations(page, 'Raw (dropped, routed)');
    });

    test('Fields: nested JSON parent chips', async ({ page }) => {
      await openDroppedAndRouted(page);
      await page.getByRole('tab', { name: /^Fields$/ }).click();
      await page.getByRole('button', { name: 'Expand all' }).click();
      await expect(page.getByText('JSON', { exact: true }).first()).toBeVisible();
      await expect(page.getByText('.id').first()).toBeVisible();
      await expectNoViolations(page, 'Fields (nested JSON)');
    });

    test('Diff: added and removed lines', async ({ page }) => {
      await openDroppedAndRouted(page);
      await page.getByRole('tab', { name: /^Diff$/ }).click();
      await expectNoViolations(page, 'Diff (added, removed)');
    });

    test('CIM Models: models with no matching field', async ({ page }) => {
      await openDroppedAndRouted(page);
      await page.getByRole('tab', { name: /^CIM Models$/ }).click();
      await expect(page.getByRole('button', { name: 'Show matching only' })).toBeVisible();
      await expectNoViolations(page, 'CIM Models (non-matching)');
    });

    test('Architecture: nothing configured, every box inactive', async ({ page }) => {
      await openApp(page);
      await page.getByRole('tab', { name: /^Architecture$/ }).click();
      await expectNoViolations(page, 'Architecture (inactive)');
    });
  });
}

/**
 * A nested JSON event wide enough that the Fields table and the Extractions
 * sidebar are windowed (#454).
 */
async function openWideFields(page: Page): Promise<void> {
  await openApp(page);
  await loadExample(page, APACHE);
  await pasteInto(page, 1, '[access_combined]\nSHOULD_LINEMERGE = false\nTRUNCATE = 0\nKV_MODE = json');
  // Literal dotted keys beside their prefix, so the Fields table nests each
  // group under a parent row with a toggle: 60 parents, 360 rows.
  const wide: Record<string, string | number> = {};
  for (let g = 0; g < 60; g++) {
    wide[`g${g}`] = 'a';
    for (let f = 0; f < 5; f++) wide[`g${g}.f${f}`] = g * 5 + f;
  }
  await pasteInto(page, 0, JSON.stringify(wide));
  await expect(page.getByText('1 event', { exact: true })).toBeVisible({ timeout: 30_000 });
}

test.describe('windowed field lists', () => {
  test('the Fields table has no axe violations, scrolled or not', async ({ page }) => {
    await openWideFields(page);
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await page.getByRole('button', { name: 'Expand all' }).click();
    const table = page.getByRole('table');
    await expect.poll(async () => Number(await table.getAttribute('aria-rowcount'))).toBeGreaterThan(300);
    await expectNoViolations(page, 'Fields (windowed)');
    await table.locator('xpath=..').evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await expectNoViolations(page, 'Fields (windowed, scrolled)');
  });

  test('Tab walks the Fields toggles past the first window, in row order', async ({ page }) => {
    await openWideFields(page);
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await page.getByRole('button', { name: 'Expand all' }).click();
    await page
      .getByRole('button', { name: /^Toggle g\d+$/ })
      .first()
      .focus();
    // 60 parents of 6 rows each: the last toggle is far outside the first window.
    const rowIndex = () =>
      page.evaluate(() => Number(document.activeElement?.closest('tr')?.getAttribute('aria-rowindex')));
    let previous = await rowIndex();
    for (let i = 1; i < 60; i++) {
      await page.keyboard.press('Tab');
      // Polled: the window re-renders around the newly focused row, and a read
      // taken in that gap (focus momentarily on <body>) failed this on a
      // loaded CI runner. The row must still be reached, and in order.
      await expect.poll(rowIndex, { message: `row focused after ${i} Tabs` }).toBeGreaterThan(previous);
      previous = await rowIndex();
    }
  });

  // The tree is ONE tab stop (roving tabindex, #495): Tab enters and leaves it,
  // the arrow keys walk the rows. The walk used to be 44 Tabs, one per row.
  test('the Extractions sidebar is windowed, one Tab stop, and walkable by arrow keys', async ({ page }) => {
    test.setTimeout(60_000);
    await openWideFields(page);
    await page.getByRole('tab', { name: /^Extractions$/ }).click();
    const sidebar = page
      .getByRole('textbox', { name: 'Filter fields' })
      .locator('xpath=ancestor::div[contains(@class,"flex-col")][1]');
    await sidebar.getByRole('button', { name: 'Expand all' }).click();
    const rows = sidebar.locator('[data-window-row]');
    await expect.poll(() => rows.count()).toBeGreaterThan(10);
    expect(await rows.count()).toBeLessThan(200);
    await expectNoViolations(page, 'Extractions sidebar (windowed)');

    // The walk ends on a row that was not rendered when it began.
    await expect(sidebar.locator('[data-window-index="44"]')).toHaveCount(0);
    // Exactly one rendered row is in the tab order.
    await expect(sidebar.locator('[data-field-row][tabindex="0"]')).toHaveCount(1);

    await rows.first().getByRole('button').focus();
    const focusedIndex = () =>
      page.evaluate(() =>
        Number(document.activeElement?.closest<HTMLElement>('[data-window-index]')?.dataset['windowIndex']),
      );
    let previous = await focusedIndex();
    for (let i = 1; i < 45; i++) {
      await page.keyboard.press('ArrowDown');
      const current = await focusedIndex();
      expect(current, `sidebar row focused after ${i} ArrowDowns`).toBe(previous + 1);
      previous = current;
    }
    // The roving stop followed the focus, and is still the only one.
    await expect(sidebar.locator('[data-field-row][tabindex="0"]')).toHaveCount(1);
    await expect(sidebar.locator(`[data-window-index="${previous}"] [data-field-row]`)).toHaveAttribute(
      'tabindex',
      '0',
    );

    // Tab leaves the tree rather than stepping to the next row.
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.closest('[data-window-index]') != null)).toBe(false);
  });
});
