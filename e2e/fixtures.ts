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

/**
 * The keys of the shortcuts, as the page reads them. Monaco takes its
 * platform from the user agent, and Playwright's WebKit reports macOS on
 * every host, so there the editor takes Cmd where it takes Ctrl elsewhere,
 * and goes to the end of the text with Cmd+Down, as Safari's users press.
 */
export interface ShortcutKeys {
  /** Ctrl, or Cmd on a Mac. */
  mod: 'Control' | 'Meta';
  /** To the end of an editor's text. */
  textEnd: 'Control+End' | 'Meta+ArrowDown';
}

export async function shortcutKeys(page: Page): Promise<ShortcutKeys> {
  const mac = await page.evaluate(() => navigator.userAgent.includes('Macintosh'));
  return mac ? { mod: 'Meta', textEnd: 'Meta+ArrowDown' } : { mod: 'Control', textEnd: 'Control+End' };
}

export const test = base.extend<{ complaints: BrowserComplaints; keys: ShortcutKeys }>({
  keys: async ({ page }, use) => {
    await use(await shortcutKeys(page));
  },
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
 * two workers in a row have failed to load, and render exactly what
 * the worker would have — while Chromium logs nothing to the console for a
 * worker script that 404s. The only thing that tells "the worker answered"
 * apart from "the fallback answered" is the reply itself.
 *
 * A reply is a message carrying a numeric `id`; the unprompted
 * `{ type: 'ready' }` signal (workers/workerProtocol.ts) does not count, so a
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
  // The header's library opens on every page, data loaded or not (#666).
  await page.getByRole('banner').getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('group', { name: 'Examples' }).getByRole('button', { name }).click();
  await expect(page.getByText(/^[1-9]\d* events?$/)).toBeVisible({ timeout: 30_000 });
}

/**
 * Type `lines` at the end of an editor's text, each on a new line. Escape
 * before each Enter closes the suggest widget, which would otherwise take the
 * Enter and insert its first suggestion: `DEST_KEY = MetaData:Sourcetype` is
 * itself a suggestion, and accepting it on a value that ends in a colon word
 * writes the word twice.
 */
export async function appendLines(page: Page, editor: number, lines: string[]): Promise<void> {
  await page.locator('.monaco-editor').nth(editor).click();
  await page.keyboard.press((await shortcutKeys(page)).textEnd);
  for (const line of lines) {
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
  await page.keyboard.press('Escape');
}

/** The pipeline worker's built chunk; the name carries a content hash. */
export const PIPELINE_WORKER = /\/pipelineWorker[^/]*\.js$/;

/**
 * Stand-ins for the pipeline worker's script. Each one sends the ready signal
 * (src/workers/workerProtocol.ts), so the page counts what follows as the
 * worker's fault, not as a load failure. Then `hang` never answers, and
 * `crash` throws on each request, which reaches the page as the worker's
 * `error` event, as a real crash does.
 */
const PIPELINE_WORKER_STAND_INS = {
  hang: `self.postMessage({ type: 'ready' }); self.onmessage = () => {};`,
  crash: `self.postMessage({ type: 'ready' }); self.onmessage = () => { throw new Error('e2e: the worker crashed'); };`,
} as const;

/**
 * Serve the first `times` fetches of the pipeline worker's script as a
 * stand-in that fails as `behaviour` says, and each later fetch as the real
 * script. The page's own watchdog and crash handling then run against a real
 * `Worker` in a real browser, with no test hook in the app. A replacement
 * worker fetches its script again, so `times` is how many workers in a row
 * fail. Returns a reader of how many fetches of the script there were.
 *
 * Not a pathological input: the engine's run budget and the regex match
 * limits stop a slow pattern before the 5 s watchdog, by design, and how slow
 * a pattern is depends on the machine. Nor can an input crash the worker: the
 * worker catches what the engine throws and answers with it.
 */
export async function failPipelineWorker(
  page: Page,
  behaviour: keyof typeof PIPELINE_WORKER_STAND_INS,
  times = 1,
): Promise<() => number> {
  let fetches = 0;
  await page.context().route(PIPELINE_WORKER, (route) => {
    fetches++;
    if (fetches > times) return route.continue();
    return route.fulfill({ contentType: 'text/javascript', body: PIPELINE_WORKER_STAND_INS[behaviour] });
  });
  return () => fetches;
}

/** A point in page coordinates. */
export interface Point {
  x: number;
  y: number;
}

/**
 * The point `fx`/`fy` of the way across `target`'s box, read when called. For
 * dwellUntilVisible, which calls it on every attempt, so a layout that settles
 * after the test first found the element cannot leave the pointer aimed at
 * where it used to be.
 */
export function pointIn(target: Locator, fx = 0.5, fy = 0.5): () => Promise<Point> {
  return async () => {
    const box = await target.boundingBox();
    if (!box) throw new Error(`${String(target)} is not rendered`);
    return { x: box.x + box.width * fx, y: box.y + box.height * fy };
  };
}

/**
 * Rest the mouse at `at()` in a Monaco editor until `shown` is visible.
 *
 * Monaco opens the hover on mouse DWELL, and it needs movement to start the
 * timer — a single jump to the token can arrive before the editor is
 * listening and then never repeat. So each attempt moves onto the point and
 * nudges it.
 *
 * Each attempt also starts with the pointer off the editor, which closes
 * whatever hover the last attempt left. Monaco does not ask the provider
 * again while the pointer stays inside the range of a hover it is showing, so
 * without this a first answer that could not be complete stayed on screen for
 * the rest of the wait. That is how the TIME_FORMAT hover test failed (#408):
 * under load the hover's worker can take longer than its load wait (6 s),
 * the first answer comes back without the worker's **Sample:** line, and the
 * replacement worker's answer was never asked for. A user moving the mouse
 * away and back gets that second answer too.
 */
export async function dwellUntilVisible(page: Page, at: () => Promise<Point>, shown: Locator): Promise<void> {
  await expect(async () => {
    await page.mouse.move(0, 0);
    const { x, y } = await at();
    await page.mouse.move(x, y);
    await page.mouse.move(x + 1, y);
    await expect(shown).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Replace an editor's text through Monaco's own paste path: a `paste` event on
 * the editor's input carrying the text, as the browser delivers a real Ctrl+V.
 * With `at` 'end', the text goes after the editor's text instead. Typed, the
 * suggest widget and the auto-closing pairs would change it.
 *
 * The text goes in twice, because the two browsers read different members of
 * the event's init. Chromium takes `clipboardData`. Firefox ignores it and
 * builds the event's DataTransfer from its own `dataType` and `data` members,
 * so with `clipboardData` alone the paste reached Monaco empty and changed
 * nothing. Both failures throw here, not as a wait for text that never comes:
 * an event that does not carry the text, and a paste that Monaco does not
 * cancel, which it does when it takes one.
 */
export async function pasteInto(
  page: Page,
  editor: number,
  text: string,
  at: 'replace' | 'end' = 'replace',
): Promise<void> {
  await page.locator('.monaco-editor').nth(editor).click();
  const keys = await shortcutKeys(page);
  await page.keyboard.press(at === 'end' ? keys.textEnd : `${keys.mod}+a`);
  const problem = await page.evaluate((data) => {
    const input = document.activeElement;
    if (!input) return 'has no focused input';
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', data);
    // `dataType` and `data` are Firefox's, and not in the DOM typings.
    const init = { clipboardData, dataType: 'text/plain', data, bubbles: true, cancelable: true } as ClipboardEventInit;
    const event = new ClipboardEvent('paste', init);
    if (event.clipboardData?.getData('text/plain') !== data) return 'got a paste event without the text';
    return input.dispatchEvent(event) ? 'did not take the paste' : null;
  }, text);
  if (problem !== null) throw new Error(`editor ${editor} ${problem}`);
}
