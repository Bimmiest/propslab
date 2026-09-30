// @vitest-environment jsdom
// ---------------------------------------------------------------------------
// timePrefixMatcher.test.ts
// The TIME_FORMAT hover matches TIME_PREFIX in a worker, never on the main
// thread. The worker is faked so a response can be held back, withheld past
// the watchdog, or replaced by a load failure.
//
// An error before the worker's ready signal is a load failure, after it a
// crash, so a script that throws at top level is capped rather than building
// a new worker on every hover and blaming its prefix.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Position, languages, CancellationToken } from 'monaco-editor';
import type { TimestampMatchRequest, TimestampMatchResponse } from '../../engine/timestampMatchWorker';
import { probeTimestamps } from '../../engine/timestampMatch';
import { SplunkRegex } from '../../utils/splunkRegex';
import { useAppStore } from '../../store/useAppStore';
import { LOAD_WAIT_FACTOR } from '../../hooks/workerLifecycle';
import { createHoverProvider } from '../splunkConfHover';
import { buildTimeFormatPreview, renderTimeFormatPreview } from '../timeFormatPreview';
import {
  matchTimePrefix,
  resetTimePrefixMatcherForTests,
  TIME_PREFIX_TIMEOUT_MS,
  type PrefixMatcher,
} from '../timePrefixMatcher';
import { fakeModel } from '../../test/fakeModel';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((e: MessageEvent<TimestampMatchResponse>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  posted: TimestampMatchRequest[] = [];
  terminated = false;
  loaded = false;
  constructor() {
    FakeWorker.instances.push(this);
  }
  /** The module finished evaluating: what every worker entry posts first. */
  ready() {
    if (this.loaded) return;
    this.loaded = true;
    this.onmessage?.({ data: { type: 'ready' } } as unknown as MessageEvent<TimestampMatchResponse>);
  }
  /** A module that throws while evaluating: an ErrorEvent with a message, before ready. */
  throwOnLoad() {
    this.onerror?.(new ErrorEvent('error', { message: 'SyntaxError: Unexpected token' }));
  }
  /** Code that ran threw: the module loaded first. */
  crash(message = 'boom') {
    this.ready();
    this.onerror?.(new ErrorEvent('error', { message }));
  }
  postMessage(message: TimestampMatchRequest) {
    this.posted.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  /** Answer the last request the way the real worker would, by running it. */
  answer(request: TimestampMatchRequest = this.posted[this.posted.length - 1]!) {
    this.ready();
    this.onmessage?.({
      data: { id: request.id, probes: probeTimestamps(request.raws!, request.config) },
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

    // The text the hover produces for this config when matched in-thread, verbatim.
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
    hung.ready();
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
    worker().ready();
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
    busy.ready();
    cancel();
    expect(await pending).toBeNull();

    // A late answer is ignored; a match that never ends is still terminated.
    vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
    expect(busy.terminated).toBe(true);
  });

  describe('a worker slow to load (#403)', () => {
    it('does not blame the prefix for the load: its run is timed alone', async () => {
      vi.useFakeTimers();
      const pending = hover();
      await flush();
      const slow = worker();
      // Loading (the PCRE2 wasm fetch and compile) takes several run budgets.
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS * 3);
      expect(slow.terminated).toBe(false);
      slow.ready();
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS / 2);
      slow.answer();
      expect(FakeWorker.instances).toHaveLength(1);
      const markdown = text(await pending);
      expect(markdown).toContain('matched `2024-01-15`');
      expect(markdown).not.toContain('timed out');
    });

    it('runs the requests queued behind it too, in order, once it loads', async () => {
      vi.useFakeTimers();
      const first = matchTimePrefix('ts=', SAMPLE);
      const second = matchTimePrefix('id=', SAMPLE);
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
      worker().ready();
      expect(worker().posted.map((r) => r.config.timePrefix)).toEqual(['ts=', 'id=']);
      worker().answer(worker().posted[0]);
      worker().answer(worker().posted[1]);
      await expect(first).resolves.toEqual({ status: 'matched', end: 8 });
      await expect(second).resolves.toEqual({ status: 'matched', end: 3 });
    });

    it('omits the sample line, not a timeout, when the worker never loads', async () => {
      vi.useFakeTimers();
      const pending = hover();
      await flush();
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS * LOAD_WAIT_FACTOR);
      const markdown = text(await pending);
      expect(markdown).toContain('**Now:**');
      expect(markdown).not.toContain('**Sample:**');
    });

    it('still blames a prefix that overruns once the worker has loaded', async () => {
      vi.useFakeTimers();
      const pending = matchTimePrefix('(a|aa)+b', 'a'.repeat(4000));
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
      worker().ready();
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
      await expect(pending).resolves.toEqual({ status: 'timed-out' });
    });
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
    worker().crash('boom');
    await expect(pending).resolves.toEqual({ status: 'error', message: 'boom' });
  });

  describe('lifecycle (#339)', () => {
    it('counts a script that throws at top level as a load failure, and stops after the cap', async () => {
      // It was a crash: reported as the prefix's error, and uncapped, so every
      // hover built a new worker for a script that could never run.
      for (let i = 0; i < 2; i++) {
        const pending = matchTimePrefix('ts=', SAMPLE);
        worker().throwOnLoad();
        await expect(pending).resolves.toEqual({ status: 'unavailable' });
      }
      await expect(matchTimePrefix('ts=', SAMPLE)).resolves.toEqual({ status: 'unavailable' });
      expect(FakeWorker.instances).toHaveLength(2);
    });

    it('omits the sample line, not an error, when the first worker throws at top level', async () => {
      const pending = hover();
      await flush();
      worker().throwOnLoad();
      const markdown = text(await pending);
      expect(markdown).toContain('**Now:**');
      expect(markdown).not.toContain('**Sample:**');
    });

    it('blames only the running entry for a crash, and replays the ones queued behind it', async () => {
      // A crash replays the queued entries, as a hang does, rather than
      // reporting each as an error.
      const first = matchTimePrefix('(a|aa)+b', 'a'.repeat(4000));
      const second = matchTimePrefix('ts=', SAMPLE);
      const crashed = worker();
      crashed.crash('out of memory');
      await expect(first).resolves.toEqual({ status: 'error', message: 'out of memory' });

      expect(FakeWorker.instances).toHaveLength(2);
      expect(worker().posted.map((r) => r.config.timePrefix)).toEqual(['ts=']);
      worker().answer();
      await expect(second).resolves.toEqual({ status: 'matched', end: 8 });
    });

    it('keeps building workers however many crashes there are', async () => {
      for (let i = 0; i < 4; i++) {
        const pending = matchTimePrefix('(a|aa)+b', SAMPLE);
        worker().crash();
        await expect(pending).resolves.toMatchObject({ status: 'error' });
      }
      const pending = matchTimePrefix('ts=', SAMPLE);
      worker().answer();
      await expect(pending).resolves.toEqual({ status: 'matched', end: 8 });
    });

    it('drops a cancelled entry queued behind a hang instead of replaying it', async () => {
      vi.useFakeTimers();
      const first = matchTimePrefix('(a|aa)+b', 'a'.repeat(4000));
      worker().ready();
      const { token, cancel } = cancellable();
      const second = matchTimePrefix('ts=', SAMPLE, token);
      cancel();
      await expect(second).resolves.toEqual({ status: 'cancelled' });
      vi.advanceTimersByTime(TIME_PREFIX_TIMEOUT_MS);
      await expect(first).resolves.toEqual({ status: 'timed-out' });
      expect(worker().posted).toEqual([]);
    });
  });
});

describe('TIME_FORMAT preview — no main-thread TIME_PREFIX execution (#334)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never executes the prefix regex on this thread, even one that compiles', async () => {
    // `(a|aa)+b` against a run of `a`s is exponential; PCRE's limit stops each
    // match, but the hover must not pay even that on the main thread.
    const prefix = '(a|aa)+b';
    const executed: string[] = [];
    const exec = SplunkRegex.prototype.exec;
    vi.spyOn(SplunkRegex.prototype, 'exec').mockImplementation(function (this: SplunkRegex, s: string, start?: number) {
      executed.push(this.source);
      return exec.call(this, s, start);
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
    expect(executed).not.toContain(prefix);
    expect(renderTimeFormatPreview(preview!)).toContain('**Sample:** preview timed out');
  });
});
