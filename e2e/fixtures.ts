import { test as base, expect, type Locator, type Page } from '@playwright/test';

/**
 * Everything the browser complained about during a test.
 *
 * Collected rather than asserted eagerly so a test can read the list and say
 * something specific about it ("no CSP violation") instead of every failure
 * arriving as an undifferentiated "there was a console error".
 */
export interface BrowserComplaints {
  all: string[];
  /** The subset Chromium attributes to a Content-Security-Policy directive. */
  csp: string[];
}

export const test = base.extend<{ complaints: BrowserComplaints }>({
  complaints: async ({ page }, use) => {
    const all: string[] = [];
    const csp: string[] = [];

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      all.push(`console.error: ${text}`);
      // Chromium's wording for every blocked-by-policy subresource.
      if (/Content Security Policy|Refused to (load|execute|connect|frame)/i.test(text)) {
        csp.push(text);
      }
    });
    page.on('pageerror', (error) => all.push(`pageerror: ${error.message}`));

    await use({ all, csp });
  },
});

export { expect };

/**
 * Count, per worker script, the responses the page received from it.
 *
 * Installed before any page script runs, and observes only: the wrapped
 * constructor is the real `Worker`, with a `message` listener added.
 *
 * Needed because a worker chunk that fails to load is INVISIBLE from the UI.
 * The Regex and Timestamp tabs fall back to matching on the main thread once
 * two workers in a row have failed to load (#309), and render exactly what
 * the worker would have — while Chromium logs nothing to the console for a
 * worker script that 404s. The only thing that tells "the worker answered"
 * apart from "the fallback answered" is the reply itself.
 *
 * A reply is a message carrying a numeric `id`; the unprompted
 * `{ type: 'ready' }` signal (engine/workerProtocol.ts) does not count, so a
 * worker that loads and then cannot answer is not mistaken for a working one.
 */
export async function recordWorkerReplies(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const replies: Record<string, number> = {};
    Object.defineProperty(window, '__e2eWorkerReplies', { value: replies });
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const script = String(url);
        this.addEventListener('message', (event: MessageEvent<unknown>) => {
          const data = event.data as { id?: unknown } | null;
          if (typeof data === 'object' && data !== null && typeof data.id === 'number') {
            replies[script] = (replies[script] ?? 0) + 1;
          }
        });
      }
    };
  });
}

/**
 * How many replies came back from workers whose script URL matches `script`.
 * Built chunk names carry a content hash (`regexMatchWorker-<hash>.js`), so
 * callers pass the stable part. Requires `recordWorkerReplies` before `goto`.
 */
export async function workerReplies(page: Page, script: RegExp): Promise<number> {
  const replies = await page.evaluate(
    () => (window as unknown as { __e2eWorkerReplies?: Record<string, number> }).__e2eWorkerReplies ?? {},
  );
  return Object.entries(replies)
    .filter(([url]) => script.test(url))
    .reduce((sum, [, n]) => sum + n, 0);
}

/**
 * Open the app and wait for it to be interactive: the shell rendered and all
 * three Monaco editors mounted.
 *
 * Monaco is the slowest thing on the page and the most likely to be broken by a
 * bundling change, so waiting on it is both the readiness signal and an
 * assertion.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('#main-content')).toBeVisible();
  await expect(page.locator('.monaco-editor').nth(2)).toBeVisible({ timeout: 30_000 });
}

/**
 * Load a built-in example and wait for the pipeline worker to return ITS result.
 *
 * The readiness signal is a NON-ZERO event count, not "Worker idle" and not a
 * sleep. The app runs the pipeline once on mount with an empty raw log, and
 * `runPipeline` returns a real result for empty input — `eventCount: 0` — so
 * the status bar already reads "Worker idle · 0 events" before the example is
 * clicked. Waiting on that is a race the test wins often enough to look stable
 * and loses whenever the machine is slow, which is the worst failure mode an
 * end-to-end suite can have.
 */
export async function loadExample(page: Page, name: RegExp): Promise<void> {
  await page.getByRole('button', { name }).first().click();
  await expect(page.getByText(/^[1-9]\d* events?$/)).toBeVisible({ timeout: 30_000 });
}

/**
 * Rest the mouse at (`x`, `y`) in a Monaco editor until `shown` is visible.
 *
 * Monaco opens the hover on mouse DWELL, and it needs movement to start the
 * timer — a single jump to the token can arrive before the editor is
 * listening and then never repeat. Nudge repeatedly until the widget shows.
 */
export async function dwellUntilVisible(page: Page, x: number, y: number, shown: Locator): Promise<void> {
  await expect(async () => {
    await page.mouse.move(x, y);
    await page.mouse.move(x + 1, y);
    await expect(shown).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
}
