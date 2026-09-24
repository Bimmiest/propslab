// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// timePrefixMatcher.test.ts
// The TIME_FORMAT hover matches TIME_PREFIX in a worker, never on the main
// thread (#334). The worker is faked so a response can be held back, withheld
// past the watchdog, or replaced by a load failure.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { editor, Position, languages, CancellationToken } from 'monaco-editor';
import type { TimestampMatchRequest, TimestampMatchResponse } from '../../engine/timestampMatchWorker';
import { probeTimestamps } from '../../engine/timestampMatch';
import { translatePcreToJs } from '../../utils/splunkRegex';
import { useAppStore } from '../../store/useAppStore';
import { createHoverProvider } from '../splunkConfHover';
import { buildTimeFormatPreview, renderTimeFormatPreview } from '../timeFormatPreview';
import {
  matchTimePrefix,
  resetTimePrefixMatcherForTests,
  TIME_PREFIX_TIMEOUT_MS,
  type PrefixMatcher,
} from '../timePrefixMatcher';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<TimestampMatchResponse>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  posted: TimestampMatchRequest[] = [];
  terminated = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(message: TimestampMatchRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** Answer the last request the way the real worker would, by running it. */
  answer(request: TimestampMatchRequest = this.posted[this.posted.length - 1]!) {
    this.onmessage?.({
      data: { id: request.id, probes: probeTimestamps(request.raws, request.config) },
    } as MessageEvent<TimestampMatchResponse>);
  }
}

const worker = () => FakeWorker.instances[FakeWorker.instances.length - 1]!;

/** A Monaco-shaped cancellation token the test can trip. */
function cancellable() {
  const listeners: (() => void)[] = [];
  const token = {
    isCancellationRequested: false,
    onCancellationRequested: (l: () => void) => {
      listeners.push(l);
      return { dispose: () => {} };
    },
  };
  return {
    token: token as unknown as CancellationToken,
    cancel() {
      token.isCancellationRequested = true;
      listeners.forEach((l) => l());
    },
  };
}

function fakeModel(text: string): editor.ITextModel {
  const lines = text.split('\n');
  return {
    getLineCount: () => lines.length,
    getLineContent: (n: number) => lines[n - 1] ?? '',
  } as unknown as editor.ITextModel;
}

const CONF = '[my:st]\nTIME_PREFIX = ts=\nTIME_FORMAT = %Y-%m-%d';
const SAMPLE = 'id=5 ts=2024-01-15 rest';

/** Hover the TIME_FORMAT value in CONF. */
function hover(token: CancellationToken = cancellable().token) {
  const result = createHoverProvider('props.conf').provideHover(
    fakeModel(CONF),
    { lineNumber: 3, column: 16 } as Position,
    token,
    undefined,
  );
  return Promise.resolve(result as languages.Hover | null | undefined);
}

const text = (h: languages.Hover | null | undefined) => h?.contents.map((c) => c.value).join('\n') ?? '';

/** Let the hover's awaits reach the worker. */
const flush = () => new Promise<void>((r) => queueMicrotask(r));

describe('TIME_FORMAT hover — TIME_PREFIX in a worker (#334)', () => {
  beforeEach(() => {
    resetTimePrefixMatcherForTests();
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker);
    useAppStore.getState().setRawData(SAMPLE);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetTimePrefixMatcherForTests();
    useAppStore.getState().setRawData('');
  });

  it('asks the worker for the prefix alone, and renders what the main-thread preview did', async () => {
    const pending = hover();
    await flush();
    expect(worker().posted).toHaveLength(1);
    expect(worker().posted[0]!.config).toMatchObject({ timePrefix: 'ts=', timeFormat: null });
    expect(worker().posted[0]!.raws).toEqual([SAMPLE]);
    worker().answer();

    // The text the pre-#334 hover produced for this config, verbatim.
    const markdown = text(await pending);
    expect(markdown).toContain('**Sample:** matched `2024-01-15` → `2024-01-15T00:00:00.000Z`');
    expect(markdown).toMatch(/^\*\*Now:\*\* `\d{4}-\d{2}-\d{2}`\n\n\*\*Sample:\*\*/);
  });

  it('keeps one worker alive across hovers', async () => {
    for (let i = 0; i < 3; i++) {
      const pending = hover();
      await flush();
      worker().answer();
      await pending;
    }
    expect(FakeWorker.instances).toHaveLength(1);
    expect(worker().posted).toHaveLength(3);
    expect(worker().terminated).toBe(false);
  });

  it('terminates a worker that overruns, says so, and uses a fresh one next time', async () => {
    vi.useFakeTimers();
    const pending = hover();
    await flush();
    const hung = worker();
    vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
    expect(hung.terminated).toBe(true);
    expect(text(await pending)).toContain('**Sample:** preview timed out');

    const next = hover();
    await flush();
    expect(FakeWorker.instances).toHaveLength(2);
    worker().answer();
    expect(text(await next)).toContain('matched `2024-01-15`');
  });

  it('replays a request queued behind the one that hung, instead of blaming it', async () => {
    vi.useFakeTimers();
    const first = matchTimePrefix('(a|aa)+b', 'a'.repeat(4000));
    vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS / 2);
    const second = matchTimePrefix('ts=', SAMPLE);
    vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS / 2);
    await expect(first).resolves.toEqual({ status: 'timed-out' });

    expect(FakeWorker.instances).toHaveLength(2);
    expect(worker().posted.map((r) => r.config.timePrefix)).toEqual(['ts=']);
    worker().answer();
    await expect(second).resolves.toEqual({ status: 'matched', end: 8 });
  });

  it('honours cancellation: resolves null at once, but still reaps a hang', async () => {
    vi.useFakeTimers();
    const { token, cancel } = cancellable();
    const pending = hover(token);
    await flush();
    const busy = worker();
    cancel();
    expect(await pending).toBeNull();

    // A late answer is ignored; a match that never ends is still terminated.
    vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
    expect(busy.terminated).toBe(true);
  });

  it('does not post at all for an already-cancelled token', async () => {
    const { token, cancel } = cancellable();
    cancel();
    expect(await hover(token)).toBeNull();
    expect(FakeWorker.instances.flatMap((w) => w.posted)).toHaveLength(0);
  });

  it('omits the sample line when the worker cannot load, and does not run the prefix here', async () => {
    const pending = hover();
    await flush();
    worker().onerror?.(new Event('error')); // a failed fetch: a plain Event, no message
    const markdown = text(await pending);
    expect(markdown).toContain('**Now:**');
    expect(markdown).not.toContain('**Sample:**');
  });

  it('stops constructing workers after repeated load failures', async () => {
    for (let i = 0; i < 2; i++) {
      const pending = matchTimePrefix('ts=', SAMPLE);
      worker().onerror?.(new Event('error'));
      await expect(pending).resolves.toEqual({ status: 'unavailable' });
    }
    await expect(matchTimePrefix('ts=', SAMPLE)).resolves.toEqual({ status: 'unavailable' });
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('omits the sample line where there is no Worker at all', async () => {
    vi.stubGlobal('Worker', undefined);
    const markdown = text(await hover());
    expect(markdown).toContain('**Now:**');
    expect(markdown).not.toContain('**Sample:**');
  });

  it('reports a crash in the worker rather than a timeout', async () => {
    const pending = matchTimePrefix('ts=', SAMPLE);
    worker().onerror?.(new ErrorEvent('error', { message: 'boom' }));
    await expect(pending).resolves.toEqual({ status: 'error', message: 'boom' });
  });
});

describe('TIME_FORMAT preview — no main-thread TIME_PREFIX execution (#334)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never executes the prefix regex on this thread, even for a pattern safeRegex allows', async () => {
    // `(a|aa)+b` is the alternation-overlap shape `safeRegex` documents it
    // cannot see; against a run of `a`s it is exponential.
    const prefix = '(a|aa)+b';
    const { source } = translatePcreToJs(prefix);
    const executed: string[] = [];
    const record = function (this: RegExp) {
      executed.push(this.source);
    };
    const exec = RegExp.prototype.exec;
    const test = RegExp.prototype.test;
    vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, s: string) {
      record.call(this);
      return exec.call(this, s);
    });
    vi.spyOn(RegExp.prototype, 'test').mockImplementation(function (this: RegExp, s: string) {
      record.call(this);
      return test.call(this, s);
    });

    const seen: string[] = [];
    const matcher: PrefixMatcher = (pattern) => {
      seen.push(pattern);
      return Promise.resolve({ status: 'timed-out' });
    };
    const preview = await buildTimeFormatPreview('%Y-%m-%d', {
      sampleLine: 'a'.repeat(4000),
      timePrefix: prefix,
      matchPrefix: matcher,
    });

    expect(seen).toEqual([prefix]);
    expect(executed).not.toContain(source);
    expect(renderTimeFormatPreview(preview!)).toContain('**Sample:** preview timed out');
  });
});
