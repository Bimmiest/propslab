import { test, expect, openApp, loadExample } from './fixtures';

const APACHE = /Apache Access Log/i;

test.describe('boot', () => {
  test('loads with no CSP violation and no console error', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    // Asserted separately from `all` so the failure message names the cause.
    // This is the regression guard for the missing `img-src`: Monaco draws its
    // error/warning underlines as inline `data:` SVGs, and with only
    // `default-src 'self'` to fall back on the browser refused every one.
    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors during load').toEqual([]);
  });

  test('serves the tightened policy from the built artifact', async ({ page }) => {
    await page.goto('/');
    const policy = await page
      .locator('meta[http-equiv="Content-Security-Policy"]')
      .getAttribute('content');

    expect(policy).toBeTruthy();
    // 'unsafe-eval' was removed once main.tsx moved to monaco's slim
    // editor.api entry; nothing may quietly put it back.
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain('img-src');
  });
});

test.describe('monaco', () => {
  test('mounts three editors and lints what is typed into props.conf', async ({ page, complaints }) => {
    await openApp(page);
    // Raw log, props.conf, transforms.conf.
    await expect(page.locator('.monaco-editor')).toHaveCount(3);

    const propsEditor = page.locator('.monaco-editor').nth(1);
    await propsEditor.click();
    await page.keyboard.type('[my:sourcetype]\nSHOULD_LINEMERGE = notabool\n');

    // A marker proves the whole language pipeline is wired: the model changed,
    // computeDiagnostics ran, and setModelMarkers reached the editor.
    await expect(page.locator('.squiggly-warning, .squiggly-error, .squiggly-info').first())
      .toBeVisible({ timeout: 15_000 });

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
  });

  test('re-lints after a programmatic write, not only after typing', async ({ page }) => {
    // Clear writes the model through MonacoEditor's controlled-value path, which
    // withholds onChange; lint used to hang off onChange, so the old file's
    // markers outlived the text they described (#295).
    await openApp(page);
    const propsEditor = page.locator('.monaco-editor').nth(1);
    await propsEditor.click();
    await page.keyboard.type('[my:sourcetype]\nSHOULD_LINEMERGE = notabool\n');
    const squiggles = page.locator('.squiggly-warning, .squiggly-error, .squiggly-info');
    await expect(squiggles.first()).toBeVisible({ timeout: 15_000 });

    // The raw log's Clear only renders once it has data, so with it empty the
    // first exact "Clear" is props.conf's ("Clear All" is the header's).
    await page.getByRole('button', { name: 'Clear', exact: true }).first().click();
    await page.getByRole('button', { name: 'Click again to confirm clear' }).click();

    await expect(squiggles).toHaveCount(0, { timeout: 15_000 });
  });
});

test.describe('pipeline worker', () => {
  test('round-trips an example and reports the result in the status bar', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    // The worker is a separately-bundled chunk; that it produced a result at
    // all is the thing under test. The status bar is the only place that
    // reports the counts, so matching them anywhere on the page is unambiguous.
    const shell = page.locator('body');
    await expect(shell).toContainText(/\d+ events?/);
    await expect(shell).toContainText(/\d+ fields?/);

    const text = await shell.innerText();
    expect(Number(/(\d+) events?/.exec(text)?.[1] ?? 0)).toBeGreaterThan(0);
    expect(Number(/(\d+) fields?/.exec(text)?.[1] ?? 0)).toBeGreaterThan(0);
  });

  test('recomputes when props.conf changes', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    const before = await page.getByRole('tab', { name: /^Fields$/ }).click().then(async () => {
      await expect(page.locator('tbody tr').first()).toBeVisible();
      return page.locator('tbody tr').count();
    });

    // Add an EVAL that must produce a new field, then wait for it to appear.
    await page.locator('.monaco-editor').nth(1).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nEVAL-e2e_marker = "present"\n');

    await expect(page.getByText('e2e_marker', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(before);
  });
});

test.describe('engine output reaches the tabs', () => {
  test('Extractions renders the eval expressions carried on the trace', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Extractions$/ }).click();

    // The filter pills are built from the category sets; "All" is their UNION,
    // so it can never exceed the sum and must not double-count.
    const pills = await page.getByRole('button', { name: /^(Auto|Manual|Calculated|All)/ }).allInnerTexts();
    const count = (label: string) =>
      Number(/\((\d+)\)/.exec(pills.find((p) => p.startsWith(label)) ?? '')?.[1] ?? 0);
    expect(count('All')).toBeLessThanOrEqual(count('Auto') + count('Manual') + count('Calculated'));
    expect(count('All')).toBeGreaterThan(0);

    // Expressions come off the EVAL step's `evalExpressions`, not from
    // re-parsing props.conf in the component.
    const evalSection = page.locator('details', { hasText: 'Eval Expressions' }).first();
    await evalSection.locator('summary').click();
    await expect(evalSection).toContainText('if(');
  });

  test('Fields lists rows and an Aliases column fed by the trace', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    // The column header specifically — "Field Aliases" also appears in the
    // Extractions sidebar, and an example's own description mentions the word.
    await expect(page.locator('thead th', { hasText: 'Aliases' })).toBeVisible();
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(0);
  });

  test('Pipeline lists the processors that ran', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Pipeline$/ }).click();
    await expect(page.locator('#main-content')).toContainText(/EXTRACT|EVAL|lineBreaker/);
  });
});

test.describe('accessibility affordances', () => {
  test('the command palette opens, traps focus, and closes on Escape', async ({ page, complaints }) => {
    await openApp(page);

    // Lowercase `k`: Playwright's `Control+K` delivers `e.key === 'K'`, which is
    // also what a real browser reports with Caps Lock on.
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog');
    await expect(palette).toBeVisible();

    // useOverlay marks the modal's siblings inert while it is open. Asserted on
    // the enclosing subtree rather than on `#main-content` itself: the overlay
    // hides its own siblings, and `main` sits one level down inside the wrapper
    // that holds the activity rail beside it. What matters is that the workspace
    // is unreachable, not which element carries the attribute.
    const hiddenWorkspace = page.locator('[aria-hidden="true"]:has(#main-content)');
    await expect(hiddenWorkspace).toHaveCount(1);

    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();
    await expect(hiddenWorkspace).toHaveCount(0);

    expect(complaints.all, 'browser errors during overlay interaction').toEqual([]);
  });

  test('a raw-event selection can be made and acted on from the keyboard', async ({ page, complaints }) => {
    // #300: token selection was mouse-only. Shift+F10 is delivered as a
    // `contextmenu` event on the focused element, which is what opens the menu.
    await openApp(page);
    await loadExample(page, APACHE);

    const text = page.getByRole('textbox', { name: 'Event text' }).first();
    await text.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByText(/^Selected: \S+/).first()).toBeAttached();

    await page.keyboard.press('Shift+F10');
    const extract = page.getByRole('menuitem', { name: /Create EXTRACT/ });
    await expect(extract).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(extract).toBeHidden();

    expect(complaints.all, 'browser errors during keyboard selection').toEqual([]);
  });

  test('controls that opted out of the outline still show keyboard focus', async ({ page }) => {
    // #300: `outline-none` without a ring left some buttons with no focus
    // indicator at all. The settings panel's close button was one.
    await openApp(page);
    // Opened from the keyboard so the focus Radix moves into the dialog counts
    // as keyboard focus, which is what :focus-visible keys on.
    await page.getByRole('button', { name: 'Open settings' }).focus();
    await page.keyboard.press('Enter');
    const close = page.getByRole('button', { name: 'Close settings' });
    await expect(close).toBeFocused();
    expect(await close.evaluate((el) => el.matches(':focus-visible'))).toBe(true);
    expect(await close.evaluate((el) => getComputedStyle(el).outlineStyle)).not.toBe('none');
  });
});

test.describe('dictionary', () => {
  test('switches views from the rail and keeps the simulator alive behind it', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    const editors = page.locator('.monaco-editor');
    await expect(editors).toHaveCount(3);

    await page.getByRole('tab', { name: 'Dictionary' }).click();
    await expect(page.getByRole('listbox', { name: 'Splunk directives' })).toBeVisible();

    // The whole point of switching with `hidden` instead of unmounting: the
    // editors are still there, so nothing was torn down and rebuilt.
    await expect(editors).toHaveCount(3);

    await page.getByRole('tab', { name: 'Simulator' }).click();
    await expect(page.getByRole('listbox', { name: 'Splunk directives' })).toBeHidden();
    await expect(editors.nth(2)).toBeVisible();

    expect(complaints.all, 'browser errors while switching views').toEqual([]);
  });

  test('filters the directive list and documents the selection', async ({ page }) => {
    await openApp(page);
    await page.getByRole('tab', { name: 'Dictionary' }).click();

    await page.getByLabel('Search directives').fill('KV_MODE');
    const listbox = page.getByRole('listbox', { name: 'Splunk directives' });
    await listbox.getByText('KV_MODE', { exact: true }).click();

    // The detail pane renders from directiveRegistry: description, the enum
    // values, and the pipeline stage the key belongs to.
    await expect(page.getByRole('heading', { level: 2, name: 'KV_MODE' })).toBeVisible();
    await expect(page.getByText('auto_escaped', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: /KV Mode/ })).toBeVisible();
  });

  test('a directive hover in props.conf opens that key in the dictionary', async ({ page }) => {
    await openApp(page);

    // Monaco's hover widget is a contribution, not part of the editor API — it
    // only exists if editor.all made it into the bundle, which is exactly the
    // kind of bundling question a production-build test is here to answer.
    const props = page.locator('.monaco-editor').nth(1);
    await props.click();
    await page.keyboard.type('[web]\nTIME_PREFIX = ^\n');
    // Dismiss the suggest widget, which opens on the new line and covers the
    // very token this test needs to hover.
    await page.keyboard.press('Escape');

    const token = props.getByText('TIME_PREFIX', { exact: true }).first();
    await expect(token).toBeVisible();
    const box = await token.boundingBox();
    if (!box) throw new Error('TIME_PREFIX token not rendered');

    // Monaco opens the hover on mouse DWELL, and it needs movement to start the
    // timer — a single jump to the token can arrive before the editor is
    // listening and then never repeat. Nudge repeatedly until the widget shows.
    const link = page.getByText('Open in dictionary');
    await expect(async () => {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
      await expect(link).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });

    await link.click();

    await expect(page.getByRole('heading', { level: 2, name: 'TIME_PREFIX' })).toBeVisible();
  });
});
