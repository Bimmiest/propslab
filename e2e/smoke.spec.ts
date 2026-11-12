import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import {
  test,
  expect,
  openApp,
  loadExample,
  recordWorkerReplies,
  workerReplies,
  appendLines,
  failPipelineWorker,
  PIPELINE_WORKER,
  dwellUntilVisible,
  pointIn,
  pasteInto,
} from './fixtures';

const APACHE = /Apache Access Log/i;

test.describe('boot', () => {
  test('loads with no CSP violation and no console error', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    // Asserted separately from `all` so the failure message names the cause.
    // The CSP needs `img-src`: Monaco draws its error/warning underlines as
    // inline `data:` SVGs, which `default-src 'self'` alone refuses.
    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors during load').toEqual([]);
  });

  test('serves the tightened policy from the built artifact', async ({ page }) => {
    const response = await page.goto('/');
    const meta = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    // The header is the copy the workers obey. It must be the built artifact's
    // policy in full, as the deploy checks against Azure's response (#572).
    const header = response?.headers()['content-security-policy'];
    const artifact = (
      JSON.parse(readFileSync('dist/staticwebapp.config.json', 'utf8')) as {
        globalHeaders: Record<string, string>;
      }
    ).globalHeaders['Content-Security-Policy'];
    expect(header).toBe(artifact);

    for (const [copy, policy] of [
      ['<meta>', meta],
      ['header', header],
    ] as const) {
      expect(policy, copy).toBeTruthy();
      // 'unsafe-eval' was removed once the editor moved to monaco's slim
      // `monaco-editor/editor` entry; nothing may quietly put it back. 'wasm-unsafe-eval'
      // is the narrower grant PCRE2's WebAssembly needs, and only that.
      expect(policy, copy).not.toContain("'unsafe-eval'");
      expect(policy, copy).toContain("'wasm-unsafe-eval'");
      expect(policy, copy).toContain("base-uri 'self'");
      expect(policy, copy).toContain("object-src 'none'");
      expect(policy, copy).toContain('img-src');
      expect(policy, copy).toContain("form-action 'none'");
      // Every worker is a same-origin file; see the comment above the tag.
      expect(policy, copy).not.toContain('blob:');
    }
  });
});

/**
 * The CSP requires Trusted Types (#458), with an allowlist of the policies
 * the build creates. A Monaco feature that brings a policy of its own, or a
 * new string reaching a script or HTML sink, shows up here as a violation.
 */
test.describe('trusted types', () => {
  test('the editor, hovers, the palette and the dictionary run with no violation', async ({
    page,
    complaints,
    keys,
  }) => {
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.defineProperty(window, '__e2eViolations', { value: seen });
      document.addEventListener('securitypolicyviolation', (e) => {
        seen.push(`${e.violatedDirective}: ${e.sample} (${e.sourceFile}:${e.lineNumber})`);
      });
    });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("require-trusted-types-for 'script'");
    await expect(page.locator('.monaco-editor').nth(2)).toBeVisible({ timeout: 30_000 });
    await loadExample(page, APACHE);
    // Room for the editor beside the diagnostics list the typed lines open,
    // and for the hover above them.
    await page.setViewportSize({ width: 1280, height: 1200 });

    // Typing, the suggest widget and the lint squiggles.
    const props = page.locator('.monaco-editor').nth(1);
    await props.click();
    await page.keyboard.press(keys.textEnd);
    await page.keyboard.type('\n[tt]\nSHOULD_LINEMERGE = notabool\nTIME_PRE');
    await expect(page.locator('.suggest-widget')).toBeVisible();
    await page.keyboard.press('Escape');
    // The diagnostics the typed lines raise open a list that shrinks the
    // editor, which keeps its scroll position. Once the list is open, moving
    // the cursor reveals the typed lines, where the squiggles are, again.
    // Pressed again until they show: the list can finish opening after the
    // first press has revealed the lines, and push them out of view again.
    await expect(page.getByText(/takes a boolean, and "notabool" is not one/)).toBeVisible();
    await expect(async () => {
      await page.keyboard.press(keys.textEnd);
      await expect(page.locator('.squiggly-warning, .squiggly-error, .squiggly-info').first()).toBeVisible({
        timeout: 3_000,
      });
    }).toPass({ timeout: 15_000 });

    // A directive hover: markdown rendered through Monaco's sanitizer. The
    // token is looked for in the text lines only: the hover names the key
    // too, and the last match would be the hover itself, not the token.
    const token = props.locator('.view-lines').getByText('SHOULD_LINEMERGE', { exact: true }).last();
    // Temporary diagnostics for the WebKit job.
    {
      await page.mouse.move(0, 0);
      const { x, y } = await pointIn(token)();
      await page.mouse.move(x, y);
      await page.mouse.move(x + 1, y);
      const ok = await expect(page.getByText('Open in dictionary'))
        .toBeVisible({ timeout: 6_000 })
        .then(
          () => true,
          () => false,
        );
      if (!ok) {
        const state = await page.evaluate(
          ({ px, py }) => {
            const hit = document.elementFromPoint(px, py);
            const hovers = [...document.querySelectorAll('.monaco-hover')].map((h) => ({
              hidden: h.classList.contains('hidden'),
              text: h.textContent.slice(0, 160),
              box: JSON.stringify(h.getBoundingClientRect()),
            }));
            return {
              hit: hit ? `${hit.tagName}.${hit.className} ${hit.textContent.slice(0, 60)}` : 'none',
              active: `${document.activeElement?.tagName}.${String(document.activeElement?.className)}`,
              hovers,
              vh: window.innerHeight,
            };
          },
          { px: x, py: y },
        );
        expect(ok, `DIAGTT ${JSON.stringify({ x, y, state })}`).toBe(true);
      }
    }
    await dwellUntilVisible(page, pointIn(token), page.getByText('Open in dictionary'));

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.type('dictionary');
    await page.keyboard.press('Escape');

    await page.getByRole('tab', { name: 'Dictionary' }).click();
    await expect(page.getByRole('listbox', { name: 'Splunk directives' })).toBeVisible();

    const violations = await page.evaluate(() => (window as unknown as { __e2eViolations: string[] }).__e2eViolations);
    expect(violations, 'Trusted Types / CSP violations').toEqual([]);
    expect(
      complaints.all.filter((c) => /Trusted ?Type/i.test(c)),
      'Trusted Types errors',
    ).toEqual([]);
    expect(complaints.all).toEqual([]);
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
    await expect(page.locator('.squiggly-warning, .squiggly-error, .squiggly-info').first()).toBeVisible({
      timeout: 15_000,
    });

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
  });

  test('re-lints after a programmatic write, not only after typing', async ({ page }) => {
    // Clear writes the model through MonacoEditor's controlled-value path, which
    // withholds onChange; the old file's markers must not outlive the text they
    // described.
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

/**
 * Each editor contribution MonacoEditor.tsx imports by hand. Dropping
 * one type-checks, builds and mounts fine, and silently removes its feature;
 * hover is covered by the dictionary and TIME_FORMAT tests below.
 */
test.describe('raw-log editor', () => {
  test('marks where a long line soft-wraps', async ({ page }) => {
    await openApp(page);
    const raw = page.locator('.monaco-editor').first();
    await raw.click();
    await page.keyboard.type('x=1 '.repeat(80));
    await expect(raw.locator('.wwi').first()).toBeAttached();
  });

  test('names the format of the sample beside the line count (#742)', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);
    await expect(page.getByText('Format: Access log')).toBeVisible();
  });
});

test.describe('editor context menu (#745)', () => {
  test('a right-click on a directive looks it up in the dictionary', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);
    // Line 2 is TIME_PREFIX; the right-click puts the cursor on it.
    await page.locator('.monaco-editor').nth(1).locator('.view-line').nth(1).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Look up TIME_PREFIX in the Dictionary' }).click();
    await expect(page.getByRole('tabpanel', { name: 'Dictionary' })).toBeVisible();
  });

  test('Ctrl+/ comments out the line in props.conf, as the menu does (#762)', async ({ page, keys }) => {
    await openApp(page);
    await loadExample(page, APACHE);
    const line = page.locator('.monaco-editor').nth(1).locator('.view-line').nth(1);
    await line.click();
    await page.keyboard.press(`${keys.mod}+/`);
    await expect(line).toHaveText(/^#\sTIME_PREFIX/);
  });

  test('Shift+F10 opens the menu from the keyboard, and Find opens the find widget', async ({ page, browserName }) => {
    // See 'a raw-event selection can be made and acted on from the keyboard'.
    test.skip(browserName === 'firefox', "Playwright's Firefox fires no contextmenu event from the keyboard");
    await openApp(page);
    await loadExample(page, APACHE);
    const props = page.locator('.monaco-editor').nth(1);
    await props.click();
    await page.keyboard.press('Shift+F10');
    await page.getByRole('menuitem', { name: 'Find' }).click();
    await expect(props.locator('.find-widget')).toBeVisible();
  });
});

test.describe('monaco contributions', () => {
  const typeIntoProps = async (page: Page, text: string) => {
    await openApp(page);
    await page.locator('.monaco-editor').nth(1).click();
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
  };

  test('suggest offers directive completions', async ({ page }) => {
    await typeIntoProps(page, '[web]\n');
    await page.keyboard.type('TIME_PRE');
    const suggest = page.locator('.suggest-widget');
    await expect(suggest).toBeVisible();
    await expect(suggest.getByText('TIME_PREFIX').first()).toBeVisible();
  });

  test('a quick fix renames a mis-cased key', async ({ page, keys }) => {
    await typeIntoProps(page, '[web]\ntime_prefix = x');
    await expect(page.locator('.squiggly-warning, .squiggly-error, .squiggly-info').first()).toBeVisible({
      timeout: 15_000,
    });

    await page.keyboard.press('Home');
    await page.keyboard.press(`${keys.mod}+.`);
    await expect(page.getByText('Change "time_prefix" to "TIME_PREFIX"')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.locator('.monaco-editor').nth(1).locator('.view-lines')).toContainText('TIME_PREFIX = x');
  });

  test('stanzas fold', async ({ page }) => {
    await typeIntoProps(page, '[web]\nTRUNCATE = 1\n[db]\nTRUNCATE = 2');
    const props = page.locator('.monaco-editor').nth(1);
    await props.locator('.codicon-folding-expanded').first().click({ force: true });
    await expect(props.locator('.codicon-folding-collapsed')).toHaveCount(1);
    await expect(props.locator('.view-lines')).not.toContainText('TRUNCATE = 1');
  });

  test('find opens its widget', async ({ page, keys }) => {
    await typeIntoProps(page, '[web]\nTRUNCATE = 1');
    await page.keyboard.press(`${keys.mod}+f`);
    await expect(page.locator('.monaco-editor').nth(1).locator('.find-widget.visible')).toBeVisible();
  });
});

test.describe('editor state across remounts', () => {
  // Collapsing a panel remounts the editors; each file's model is kept, so
  // what was typed before the collapse can still be undone after it (#453).
  test('undo still works after props.conf is collapsed and expanded', async ({ page, complaints, keys }) => {
    await openApp(page);
    const props = () => page.locator('.monaco-editor').nth(1);
    await props().click();
    await page.keyboard.type('[web]\nTRUNCATE = 1');
    await expect(props().locator('.view-lines')).toContainText('TRUNCATE = 1');

    await page.getByTitle('Collapse props.conf').click();
    await expect(page.locator('.monaco-editor')).toHaveCount(2);
    await page.getByTitle('Expand props.conf').click();
    await expect(page.locator('.monaco-editor')).toHaveCount(3);
    await expect(props().locator('.view-lines')).toContainText('TRUNCATE = 1');

    await props().locator('.view-lines').click();
    await expect(async () => {
      await page.keyboard.press(`${keys.mod}+z`);
      await expect(props().locator('.view-lines')).not.toContainText('TRUNCATE', { timeout: 500 });
    }).toPass({ timeout: 10_000 });
    expect(complaints.all).toEqual([]);
  });

  test('a close or reload asks first only once the session is edited', async ({ page }) => {
    await openApp(page);
    let prompts = 0;
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') prompts++;
      void dialog.dismiss();
    });
    // Chromium shows the prompt only after a user gesture on the page.
    await page.locator('.monaco-editor').nth(1).click();
    // A reload, not a close: Playwright's WebKit does not close a page that
    // has run its beforeunload handlers, though none of them asked to stay.
    // A prompt here would be dismissed, and the reload would never finish.
    await page.reload();
    await expect(page.locator('#main-content')).toBeVisible();
    expect(prompts).toBe(0);
  });

  test('a close with edits in props.conf is held for confirmation', async ({ page }) => {
    await openApp(page);
    await page.locator('.monaco-editor').nth(1).click();
    await page.keyboard.type('[web]');
    const dialog = page.waitForEvent('dialog');
    await page.close({ runBeforeUnload: true });
    const shown = await dialog;
    expect(shown.type()).toBe('beforeunload');
    await shown.dismiss();
    expect(page.isClosed()).toBe(false);
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

  test('recomputes when props.conf changes', async ({ page, keys }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    const before = await page
      .getByRole('tab', { name: /^Fields$/ })
      .click()
      .then(async () => {
        await expect(page.locator('tbody tr').first()).toBeVisible();
        return page.locator('tbody tr').count();
      });

    // Add an EVAL that must produce a new field, then wait for it to appear.
    await page.locator('.monaco-editor').nth(1).click();
    await page.keyboard.press(keys.textEnd);
    await page.keyboard.type('\nEVAL-e2e_marker = "present"\n');

    await expect(page.getByText('e2e_marker', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await page.locator('tbody tr').count()).toBeGreaterThan(before);
  });

  // The watchdog and the crash policy (ADR 0014) against a real Worker (#891).
  // The unit tests drive them with a fake one. Each stand-in fails the run
  // that the app makes on mount, with the raw log empty.
  const failure = (page: Page) => page.getByRole('alert').filter({ hasText: 'Processing failed' });

  test('the watchdog stops a run that hangs its worker, and the next run uses a new worker', async ({ page }) => {
    const fetches = await failPipelineWorker(page, 'hang');
    await recordWorkerReplies(page);
    await openApp(page);

    await expect(failure(page)).toContainText('Pipeline timed out after 5 s', { timeout: 20_000 });
    await expect(page.getByRole('contentinfo')).toContainText('1 error');
    // The watchdog built the replacement at once, not at the next request.
    await expect.poll(fetches).toBe(2);

    await loadExample(page, APACHE);
    await expect(failure(page)).toHaveCount(0);
    expect(await workerReplies(page, PIPELINE_WORKER)).toBeGreaterThan(0);
    await expect(page.getByTestId('pipeline-main-thread')).toHaveCount(0);
  });

  test('a run that crashes its worker once is run again on a new worker', async ({ page }) => {
    const fetches = await failPipelineWorker(page, 'crash');
    await recordWorkerReplies(page);
    await openApp(page);

    // The replay answers the run, so the user sees no failure.
    await expect.poll(() => workerReplies(page, PIPELINE_WORKER), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(fetches).toBe(2);
    await expect(failure(page)).toHaveCount(0);
    await loadExample(page, APACHE);
  });

  test('a run that crashes two workers is stopped, and the next run uses a third', async ({ page }) => {
    const fetches = await failPipelineWorker(page, 'crash', 2);
    await recordWorkerReplies(page);
    await openApp(page);

    await expect(failure(page)).toContainText('Worker crashed repeatedly while processing this input', {
      timeout: 20_000,
    });
    await expect.poll(fetches).toBe(3);

    // The input that crashed is not run again on the main thread, and the
    // next one runs on the third worker.
    await expect(page.getByTestId('pipeline-main-thread')).toHaveCount(0);
    await loadExample(page, APACHE);
    await expect(failure(page)).toHaveCount(0);
    expect(await workerReplies(page, PIPELINE_WORKER)).toBeGreaterThan(0);
  });
});

/**
 * The two pipeline settings (#891). Manual apply holds each edit until Run or
 * Ctrl+Enter. Per-event mode re-matches the stanzas of an event whose
 * sourcetype a transform rewrote, and it turns manual apply on.
 */
test.describe('pipeline settings', () => {
  const toggleSetting = async (page: Page, name: string) => {
    await page.getByRole('button', { name: 'Open settings' }).click();
    await page.getByRole('switch', { name }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.getByRole('button', { name: 'Close settings' })).toBeHidden();
  };
  // In the Fields table only: the editors show the same names.
  const fieldRow = (page: Page, name: string) => page.locator('tbody').getByText(name, { exact: true });
  const outOfDate = (page: Page) => page.getByRole('contentinfo').getByText('● Out of date');

  test('manual apply runs an edit only on Run or Ctrl+Enter', async ({ page, keys }) => {
    await openApp(page);
    await toggleSetting(page, 'Manual apply');
    // Loading an example is a decision to look at it, so it runs (#492).
    await loadExample(page, APACHE);
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();

    await appendLines(page, 1, ['EVAL-e2e_run = "button"']);
    await expect(outOfDate(page)).toBeVisible();
    await expect(fieldRow(page, 'e2e_run')).toHaveCount(0);
    await page.getByRole('button', { name: 'Run pipeline' }).click();
    await expect(fieldRow(page, 'e2e_run')).toBeVisible({ timeout: 20_000 });
    await expect(outOfDate(page)).toHaveCount(0);

    // Ctrl+Enter with the focus in the editor runs too, and adds no line.
    await appendLines(page, 1, ['EVAL-e2e_key = "shortcut"']);
    await expect(outOfDate(page)).toBeVisible();
    await expect(fieldRow(page, 'e2e_key')).toHaveCount(0);
    await page.keyboard.press(`${keys.mod}+Enter`);
    await expect(fieldRow(page, 'e2e_key')).toBeVisible({ timeout: 20_000 });
    await expect(outOfDate(page)).toHaveCount(0);
  });

  test('per-event mode applies the search-time stanza of a rewritten sourcetype', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);
    // The POST event becomes sourcetype e2e_web, whose stanza adds a field.
    await appendLines(page, 2, [
      '[e2e_retype]',
      'REGEX = POST',
      'DEST_KEY = MetaData:Sourcetype',
      'FORMAT = sourcetype::e2e_web',
    ]);
    await appendLines(page, 1, ['TRANSFORMS-e2e = e2e_retype', '[e2e_web]', 'EVAL-e2e_rematched = "yes"']);

    // In batch mode the rewrite is reported, and the stanza does not apply.
    const batchWarning = page.getByText(/One or more events had their sourcetype\/host\/source rewritten/).first();
    await expect(batchWarning).toBeVisible({ timeout: 20_000 });
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await expect(page.locator('tbody tr').first()).toBeVisible();
    await expect(fieldRow(page, 'e2e_rematched')).toHaveCount(0);

    await toggleSetting(page, 'Re-match stanzas after metadata rewrites');
    await expect(page.getByRole('contentinfo').getByRole('button', { name: 'Per-event pipeline' })).toBeVisible();
    // Per-event mode turned manual apply on, so the change waits for Run.
    await expect(outOfDate(page)).toBeVisible();
    await page.getByRole('button', { name: 'Run pipeline' }).click();

    await expect(fieldRow(page, 'e2e_rematched')).toBeVisible({ timeout: 20_000 });
    await expect(batchWarning).toHaveCount(0);
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
    const count = (label: string) => Number(/\((\d+)\)/.exec(pills.find((p) => p.startsWith(label)) ?? '')?.[1] ?? 0);
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

  test('a Fields row opens its menu from the keyboard, and Jump to config reaches the directive (#745)', async ({
    page,
    browserName,
  }) => {
    // See 'a raw-event selection can be made and acted on from the keyboard'.
    test.skip(browserName === 'firefox', "Playwright's Firefox fires no contextmenu event from the keyboard");
    await openApp(page);
    await loadExample(page, APACHE);
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    // EVAL-action is line 15 of the example's props.conf.
    await page.locator('tbody tr[data-field-row="action"]').focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: 'Create FIELDALIAS…' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Jump to config' }).click();
    await expect(page.getByText('Ln 15, Col 1', { exact: true })).toBeVisible();
  });

  test('Pipeline lists the processors that ran', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Pipeline$/ }).click();
    await expect(page.locator('#main-content')).toContainText(/EXTRACT|EVAL|lineBreaker/);
  });

  test('Pipeline marks a field EVAL changed as modified, not added (#900)', async ({ page }) => {
    await openApp(page);
    await loadExample(page, /Palo Alto Firewall/i);
    await page.getByRole('tab', { name: /^Pipeline$/ }).click();
    const report = page.getByRole('group', { name: /: REPORT-pan_traffic/ });
    const evalStep = page.getByRole('group', { name: /: EVAL$/ });
    await expect(report.getByText('+action', { exact: true })).toBeVisible();
    await expect(evalStep.getByText('~action', { exact: true })).toBeVisible();
    await expect(evalStep.getByText('+action', { exact: true })).toHaveCount(0);
    await expect(evalStep.getByText('+bytes_total', { exact: true })).toBeVisible();
  });
});

test.describe('event pager (#880, #881)', () => {
  // The Apache example's five lines six times over: line 3, the only one with
  // a query string, gives `uri_query` to events 3, 8, 13, 18, 23 and 28.
  const APACHE_LINES = [
    '198.51.100.10 - frank [25/Oct/2026:13:55:36 -0700] "GET /apache_pb.gif HTTP/1.0" 200 2326',
    '198.51.100.20 - - [25/Oct/2026:13:55:37 -0700] "POST /login HTTP/1.1" 403 512',
    '203.0.113.30 - admin [25/Oct/2026:13:55:38 -0700] "GET /admin/dashboard?view=week HTTP/1.0" 200 1024',
    '203.0.113.40 - - [25/Oct/2026:13:55:39 -0700] "GET /nonexistent HTTP/1.1" 404 209',
    '192.0.2.50 - jdoe [25/Oct/2026:13:55:40 -0700] "DELETE /api/v1/record/42 HTTP/1.1" 204 0',
  ];

  test('pages through the events with a pinned field, from the keyboard too', async ({ page }) => {
    await openApp(page);
    await loadExample(page, APACHE);
    await pasteInto(page, 0, Array.from({ length: 6 }, () => APACHE_LINES.join('\n')).join('\n'));
    await expect(page.getByText('30 events', { exact: true })).toBeVisible({ timeout: 30_000 });

    await page.getByRole('tab', { name: /^Extractions$/ }).click();
    await page.getByRole('combobox', { name: 'Per page:' }).selectOption('5');
    const footer = page.getByText(/^Showing events/);
    await expect(footer).toHaveText('Showing events 1-5 of 30');

    await page
      .getByTitle(/^uri_query /)
      .first()
      .click();
    await expect(footer).toHaveText('Showing events 1-5 of 6 with uri_query');
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(footer).toHaveText('Showing events 6-6 of 6 with uri_query');
    await expect(page.getByText(/^Event #28\b/)).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'Page 2 of 2' })).toBeAttached();

    // Unpinned: every event again, and the page box goes where it is told.
    await page
      .getByTitle(/^uri_query /)
      .first()
      .click();
    await expect(footer).toHaveText('Showing events 1-5 of 30');
    const pageBox = page.getByRole('textbox', { name: 'Page' });
    await pageBox.fill('4');
    await pageBox.press('Enter');
    await expect(footer).toHaveText('Showing events 16-20 of 30');
    await expect(pageBox).toBeFocused();
    await page.getByRole('button', { name: 'Last page' }).click();
    await expect(footer).toHaveText('Showing events 26-30 of 30');
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

  test('Ctrl+K opens the palette while an editor has focus', async ({ page }) => {
    // Monaco takes Ctrl+K as a chord prefix, so the shortcut has to be caught
    // before it reaches an editor.
    await openApp(page);
    const propsEditor = page.getByRole('textbox', { name: 'props.conf' });
    await page.locator('.monaco-editor').nth(1).click();
    await expect(propsEditor).toBeFocused();

    await page.keyboard.press('Control+k');
    await expect(page.getByRole('dialog')).toBeVisible();
    // The chord never started, so Escape closes the palette rather than
    // being swallowed as its second key.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('each editor has its own accessible name', async ({ page }) => {
    await openApp(page);
    for (const name of ['Raw log', 'props.conf', 'transforms.conf']) {
      await expect(page.getByRole('textbox', { name, exact: true })).toHaveCount(1);
    }
  });

  test('a raw-event selection can be made and acted on from the keyboard', async ({
    page,
    complaints,
    browserName,
  }) => {
    // Token selection from the keyboard. Shift+F10 is delivered as a
    // `contextmenu` event on the focused element, which is what opens the menu.
    // Firefox fires that event natively, but Playwright's Firefox fires no
    // `contextmenu` for Shift+F10 or the ContextMenu key, even at the
    // document (measured, #572), so there is nothing here to test it with.
    test.skip(browserName === 'firefox', "Playwright's Firefox fires no contextmenu event from the keyboard");
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

  test('a highlighted value pins and opens its menu from the keyboard (#882)', async ({ page, browserName }) => {
    // See 'a raw-event selection can be made and acted on from the keyboard'.
    test.skip(browserName === 'firefox', "Playwright's Firefox fires no contextmenu event from the keyboard");
    await openApp(page);
    await loadExample(page, APACHE);
    await page.getByRole('tab', { name: /^Extractions$/ }).click();

    // One tab stop per card: its first value.
    const card = page.locator('pre').first();
    const values = card.locator('[data-field]');
    expect(await card.locator('[data-field][tabindex="0"]').count()).toBe(1);
    await values.first().focus();
    await page.keyboard.press('ArrowRight');
    const second = values.nth(1);
    await expect(second).toBeFocused();
    const field = await second.getAttribute('data-field');

    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu');
    await expect(menu.getByText(field ?? '', { exact: true })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Copy value' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(second).toBeFocused();

    await page.keyboard.press('Enter');
    await expect(page.getByText(/events match 1 pinned field/)).toBeVisible();
    await expect(page.locator('pre [aria-pressed="true"]').first()).toHaveAttribute('data-field', field ?? '');
  });

  test('controls that opted out of the outline still show keyboard focus', async ({ page }) => {
    // Every focusable control shows a focus indicator, including those that
    // set `outline-none` without a ring, such as the settings panel's close button.
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

test.describe('global styles (#498)', () => {
  test('a Tailwind transition utility beats the global colour transition', async ({ page }) => {
    await openApp(page);
    // `transition-transform` is in the built CSS (the editor panel chevrons use
    // it). The theme transition used to be unlayered, so it outranked it.
    const property = await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'transition-transform';
      document.body.append(el);
      const value = getComputedStyle(el).transitionProperty;
      el.remove();
      return value;
    });
    expect(property).toContain('transform');
    expect(property).not.toContain('background-color');
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`declares color-scheme ${theme} so native controls follow the theme`, async ({ page }) => {
      await page.addInitScript((t) => {
        try {
          localStorage.setItem('propslab:theme', t);
        } catch {
          /* ignore */
        }
      }, theme);
      await openApp(page);
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe(theme);
    });
  }

  test('collapses transitions and animations under prefers-reduced-motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openApp(page);
    const seconds = await page.evaluate(() => {
      const bar = document.createElement('div');
      bar.className = 'progress-indeterminate';
      document.body.append(bar);
      const cs = getComputedStyle(bar);
      const out = {
        transition: parseFloat(getComputedStyle(document.body).transitionDuration),
        animation: cs.animationName,
      };
      bar.remove();
      return out;
    });
    expect(seconds.transition).toBeLessThan(0.001);
    expect(seconds.animation).toBe('none');
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
    // only exists if MonacoEditor.tsx imports it, which is exactly the
    // kind of bundling question a production-build test is here to answer.
    const props = page.locator('.monaco-editor').nth(1);
    await props.click();
    await page.keyboard.type('[web]\nTIME_PREFIX = ^\n');
    // Dismiss the suggest widget, which opens on the new line and covers the
    // very token this test needs to hover.
    await page.keyboard.press('Escape');

    const token = props.getByText('TIME_PREFIX', { exact: true }).first();
    await expect(token).toBeVisible();

    const link = page.getByText('Open in dictionary');
    await dwellUntilVisible(page, pointIn(token), link);

    await link.click();

    await expect(page.getByRole('heading', { level: 2, name: 'TIME_PREFIX' })).toBeVisible();
  });

  test('a tab left open across a redeploy reloads onto the new build and keeps its edits (#706)', async ({ page }) => {
    await openApp(page);
    // The redeploy deleted the chunk this tab knows: its fetch 404s, as the
    // old hash would. The new build names the chunk by a new URL, as a real
    // one does: WebKit does not fetch a URL again in the reloaded page after
    // a reload cancelled its 404, and fails the import with no request.
    let redeployed = false;
    await page.route(/\/assets\/DictionaryView-[^/]+\.js$/, (route) => {
      redeployed = true;
      return route.fulfill({ status: 404 });
    });
    await page.route(/\/assets\/index-[^/]+\.js$/, async (route) => {
      if (!redeployed) return route.continue();
      const response = await route.fetch();
      const body = (await response.text()).replace(/DictionaryView-[\w-]+\.js/g, '$&?build=new');
      return route.fulfill({ response, body });
    });
    let prompts = 0;
    page.on('dialog', (dialog) => {
      if (dialog.type() === 'beforeunload') prompts++;
      void dialog.dismiss();
    });
    const props = page.locator('.monaco-editor').nth(1);
    await props.click();
    await page.keyboard.type('[web]');

    const reloaded = page.waitForEvent('load');
    await page.getByRole('tab', { name: 'Dictionary' }).click();
    await reloaded;

    await expect(page.getByRole('listbox', { name: 'Splunk directives' })).toBeVisible({ timeout: 30_000 });
    // The edits were saved for the reload, so there was nothing to ask about.
    expect(prompts).toBe(0);
    await page.getByRole('tab', { name: 'Simulator' }).click();
    await expect(props).toContainText('[web]');
  });
});

/**
 * The simulator's splits preview a pointer drag and apply it on release
 * (resizePreviewMode="separator"); the keyboard still resizes per key press.
 */
test.describe('split panels', () => {
  const separator = (page: Page) => page.locator('#main-horizontal > [role="separator"]');
  const outputWidth = async (page: Page) => (await page.locator('#output-panel').boundingBox())?.width ?? 0;

  test('a drag previews the split and applies it on release', async ({ page, complaints }) => {
    await openApp(page);
    const box = await separator(page).boundingBox();
    if (!box) throw new Error('main separator not rendered');
    const before = await outputWidth(page);
    const y = box.y + box.height / 2;

    await page.mouse.move(box.x + box.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(box.x - 120, y, { steps: 5 });
    // Mid-drag: a preview is drawn and the panels have not moved.
    await expect(page.locator('[data-resize-preview]').first()).toBeAttached();
    expect(await outputWidth(page)).toBeCloseTo(before, 0);

    await page.mouse.up();
    await expect(page.locator('[data-resize-preview]')).toHaveCount(0);
    await expect.poll(() => outputWidth(page)).toBeGreaterThan(before + 60);
    expect(complaints.all, 'browser errors while resizing').toEqual([]);
  });

  test('the keyboard resizes the split directly', async ({ page }) => {
    await openApp(page);
    const handle = separator(page);
    const before = Number(await handle.getAttribute('aria-valuenow'));
    await handle.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => Number(await handle.getAttribute('aria-valuenow'))).toBeGreaterThan(before);
  });
});

/**
 * The two on-demand workers. Neither is built until its tab opens or a
 * TIME_FORMAT is hovered, so the boot tests above never load their chunks.
 *
 * The tabs' visible output cannot prove a worker ran: past two load failures
 * they match on the main thread instead and render the same thing,
 * and a worker script that 404s logs nothing to the console. So each test
 * also asserts that the worker itself replied (`recordWorkerReplies`). The
 * hover has no fallback at all — without its worker the preview
 * silently drops the sample line — so there the UI is proof on its own.
 *
 * All three use the Apache example: its props.conf sets `TIME_PREFIX = \[`
 * and `TIME_FORMAT = %d/%b/%Y:%H:%M:%S %z`, and its first event's timestamp
 * is `25/Oct/2026:13:55:36 -0700`, i.e. 2026-10-25T20:55:36Z in any browser
 * time zone.
 */
test.describe('match workers', () => {
  const REGEX_WORKER = /\/regexMatchWorker[^/]*\.js$/;
  const TIMESTAMP_WORKER = /\/timestampMatchWorker[^/]*\.js$/;
  const FIRST_EVENT_TIME = '25/Oct/2026:13:55:36 -0700';
  const FIRST_EVENT_ISO = '2026-10-25T20:55:36.000Z';

  test.beforeEach(async ({ page }) => {
    await recordWorkerReplies(page);
  });

  test('the Regex tab matches a typed pattern in its worker', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Regex$/ }).click();
    await page.getByRole('textbox', { name: 'Regex Pattern' }).fill('HTTP/1\\.(?P<minor>\\d)');

    // Every Apache event carries an HTTP version, so all of them match: the
    // count and one card per event are the worker's results rendered.
    await expect(page.getByText(/^5\/5 events matched$/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('tabpanel', { name: 'Regex' }).getByText(/^Event #\d+$/)).toHaveCount(5);
    await expect
      .poll(() => workerReplies(page, REGEX_WORKER), { message: 'replies from regexMatchWorker' })
      .toBeGreaterThan(0);

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors in the Regex tab').toEqual([]);
  });

  test('the Timestamp tab highlights the TIME_FORMAT match from its worker', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    await page.getByRole('tab', { name: /^Timestamp$/ }).click();

    // The highlighted span's title carries the parsed instant, which only
    // exists once the prober has answered for these events.
    const highlight = page.getByTitle(`TIME_FORMAT: %d/%b/%Y:%H:%M:%S %z\nParsed: ${FIRST_EVENT_ISO}`, {
      exact: true,
    });
    await expect(highlight).toBeVisible({ timeout: 15_000 });
    await expect(highlight).toHaveText(FIRST_EVENT_TIME);
    await expect
      .poll(() => workerReplies(page, TIMESTAMP_WORKER), { message: 'replies from timestampMatchWorker' })
      .toBeGreaterThan(0);

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors in the Timestamp tab').toEqual([]);
  });

  test('a TIME_FORMAT hover in props.conf previews the sample line', async ({ page, complaints }) => {
    await openApp(page);
    await loadExample(page, APACHE);

    // At the default 720px height the props.conf editor shares the column with
    // three others, and line 3 is not always rendered.
    await page.setViewportSize({ width: 1280, height: 1200 });
    const props = page.locator('.monaco-editor').nth(1);
    const key = props.getByText('TIME_FORMAT', { exact: true }).first();
    await expect(key).toBeVisible();

    // The preview hangs off the VALUE, not the key. The font is monospaced, so
    // the key's width gives the character width: `TIME_FORMAT = ` is 14
    // characters, and six more lands inside `%d/%b/%Y:%H:%M:%S %z`. Measured
    // on every attempt: the resize above re-lays out the panels and the editor
    // asynchronously.
    const onValue = pointIn(key, 20 / 'TIME_FORMAT'.length);

    // "Sample: matched <text> → <iso>" is only rendered from the worker's
    // TIME_PREFIX match; with no worker the hover shows "Now:" alone.
    const sample = page.getByText(/^Sample:/);
    await dwellUntilVisible(page, onValue, sample);
    const hover = page.locator('.monaco-hover').filter({ has: sample });
    await expect(hover).toContainText(`matched ${FIRST_EVENT_TIME} → ${FIRST_EVENT_ISO}`);
    await expect
      .poll(() => workerReplies(page, TIMESTAMP_WORKER), { message: 'replies from timestampMatchWorker' })
      .toBeGreaterThan(0);

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors during the TIME_FORMAT hover').toEqual([]);
  });

  // #408: under full-suite load the hover's worker can take longer to load
  // than its load wait (6 s). The first hover then answers without its sample
  // line, and Monaco keeps showing that answer while the pointer stays put.
  // Held up here on purpose, so the path is taken on every run.
  test('a TIME_FORMAT hover whose worker loaded too slowly previews the sample on the next hover', async ({ page }) => {
    let held = false;
    await page.context().route(TIMESTAMP_WORKER, async (route) => {
      if (!held) {
        held = true;
        await new Promise((resolve) => setTimeout(resolve, 7_000));
      }
      await route.continue();
    });
    await openApp(page);
    await loadExample(page, APACHE);
    await page.setViewportSize({ width: 1280, height: 1200 });
    const key = page.locator('.monaco-editor').nth(1).getByText('TIME_FORMAT', { exact: true }).first();
    await expect(key).toBeVisible();
    const onValue = pointIn(key, 20 / 'TIME_FORMAT'.length);

    // The first answer, given up on after the load wait: no sample line.
    const { x, y } = await onValue();
    await page.mouse.move(x, y);
    await page.mouse.move(x + 1, y);
    const hover = page.locator('.monaco-hover');
    await expect(hover.getByText(/^Now:/)).toBeVisible({ timeout: 15_000 });
    await expect(hover.getByText(/^Sample:/)).toHaveCount(0);

    // The replacement worker answers the next hover.
    await dwellUntilVisible(page, onValue, page.getByText(/^Sample:/));
    await expect(hover.filter({ has: page.getByText(/^Sample:/) })).toContainText(
      `matched ${FIRST_EVENT_TIME} → ${FIRST_EVENT_ISO}`,
    );
  });
});

/**
 * Every user pattern runs on PCRE2 compiled to WebAssembly. The page
 * and each worker load it from the one hashed asset URL the build fixed —
 * never from a message — and compiling it takes milliseconds.
 */
test.describe('regex engine', () => {
  // Generous next to what Chromium measures (tens of milliseconds, cold), and
  // well inside the 5 s a worker has to load: the point is to fail loudly if
  // compilation ever turns into the multi-second, fully optimised kind.
  const LOAD_BUDGET_MS = 2_000;

  test('loads fast, from the one built asset, and every worker runs on it', async ({ page, complaints, keys }) => {
    const wasmFetches: string[] = [];
    page.on('request', (request) => {
      if (/\.wasm$/.test(new URL(request.url()).pathname)) wasmFetches.push(request.url());
    });
    await recordWorkerReplies(page);
    await openApp(page);
    await loadExample(page, APACHE);

    // PCRE-only syntax, in all three workers: a possessive group in the Regex
    // tab, `\K` in an EXTRACT the pipeline runs, and the Timestamp tab's prober.
    await page.getByRole('tab', { name: /^Regex$/ }).click();
    await page.getByRole('textbox', { name: 'Regex Pattern' }).fill('HTTP/1\\.(?P<minor>\\d)++');
    await expect(page.getByText(/^5\/5 events matched$/)).toBeVisible({ timeout: 15_000 });

    // Before Fields: selecting a tab scrolls the strip, which can take this one out of reach.
    await page.getByRole('tab', { name: /^Timestamp$/ }).click();
    await expect.poll(() => workerReplies(page, /\/timestampMatchWorker[^/]*\.js$/)).toBeGreaterThan(0);

    await page.locator('.monaco-editor').nth(1).click();
    await page.keyboard.press(keys.textEnd);
    await page.keyboard.type('\nEXTRACT-e2e = HTTP/\\K(?<e2e_ver>[\\d.]++)\n');
    await page.getByRole('tab', { name: /^Fields$/ }).click();
    await expect(page.getByText('e2e_ver', { exact: true })).toBeVisible({ timeout: 20_000 });

    await expect.poll(() => workerReplies(page, /\/regexMatchWorker[^/]*\.js$/)).toBeGreaterThan(0);
    await expect.poll(() => workerReplies(page, /\/pipelineWorker[^/]*\.js$/)).toBeGreaterThan(0);

    const loadMs = await page.evaluate(
      () => performance.getEntriesByName('propslab:regex-engine')[0]?.duration ?? Number.NaN,
    );
    test
      .info()
      .annotations.push({ type: 'regex engine fetch+compile+instantiate (ms)', description: loadMs.toFixed(1) });
    expect(loadMs).toBeLessThan(LOAD_BUDGET_MS);
    expect(wasmFetches.length, 'the page loads the module').toBeGreaterThan(0);
    expect(new Set(wasmFetches).size, 'every load is of the one same-origin asset').toBe(1);
    for (const url of new Set(wasmFetches)) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
    }

    expect(complaints.csp, 'blocked by Content-Security-Policy').toEqual([]);
    expect(complaints.all, 'browser errors').toEqual([]);
  });
});

/**
 * A worker that cannot load the regex engine is a load failure; past the cap
 * the pipeline runs on the main thread, and the status bar must say so rather
 * than "Worker idle" (#403). The page's own load is let through, so only the
 * workers' fetches fail.
 */
test.describe('worker load failure', () => {
  test('the status bar reports the main-thread fallback', async ({ page }) => {
    let wasmLoads = 0;
    await page
      .context()
      .route(/\.wasm$/, (route) => (wasmLoads++ === 0 ? route.continue() : route.fulfill({ status: 404, body: '' })));
    await openApp(page);
    await loadExample(page, APACHE);

    const state = page.getByTestId('pipeline-main-thread');
    await expect(state).toContainText('Main thread (no watchdog)', { timeout: 30_000 });
    await expect(page.getByText('Worker idle')).toHaveCount(0);
    await state.focus();
    await expect(page.getByRole('tooltip')).toContainText('no watchdog');
    expect(wasmLoads).toBeGreaterThan(1);
  });
});
