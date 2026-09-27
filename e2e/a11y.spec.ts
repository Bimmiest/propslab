import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { test, expect, openApp, loadExample } from './fixtures';

const APACHE = /Apache Access Log/i;

/**
 * axe-core scans of every main view (#372), in both themes: most of what axe
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

    test('every output tab and preview sub-tab', async ({ page }) => {
      await openApp(page);
      await loadExample(page, APACHE);

      for (const sub of ['Raw', 'Timestamp', 'Extractions', 'Diff', 'Regex']) {
        await page.getByRole('tab', { name: new RegExp(`^${sub}$`) }).click();
        await expectNoViolations(page, `Preview › ${sub}`);
      }
      for (const tab of ['CIM Models', 'Fields', 'Pipeline', 'Effective config', 'Architecture']) {
        await page.getByRole('tab', { name: new RegExp(`^${tab}$`) }).click();
        await expectNoViolations(page, tab);
      }
    });

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
