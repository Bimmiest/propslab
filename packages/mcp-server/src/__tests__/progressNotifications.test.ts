import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { runInWorker, Semaphore, type CallProgress } from '../runInWorker';
import type { WorkerRequest } from '../protocol';
import { describeProgress, progressNotifier, type ToolExtra } from '../progressNotifications';
import { handleSimulate } from '../tools';
import { resultText } from './resultText';
import { STALLING_RAW, stallingStanza } from './stallingConf';

/**
 * Progress for a call whose client asked for it (#885): what runInWorker
 * reports while a call queues and runs, and how the tools turn that into
 * `notifications/progress`. No assertion here is about how long anything
 * takes (#507): the reports are checked by their content and order.
 */
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const SLEEP_WORKER = fixture('sleepWorker.cjs');
const WORKER_PATH = fileURLToPath(new URL('../../dist/simulateWorker.js', import.meta.url));
const sleep = (ms: number) => ({ ms }) as unknown as WorkerRequest;

describe('runInWorker onProgress', () => {
  it('reports a queued call at once, then its worker starting, and nothing after it settles', async () => {
    const limiter = new Semaphore(1);
    const release = await limiter.acquire();
    const reports: CallProgress[] = [];
    // An interval longer than the test: every report below comes from a
    // change of state, not from a tick.
    const run = runInWorker(sleep(0), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter,
      onProgress: (p) => reports.push(p),
      progressIntervalMs: 60_000,
    });
    await vi.waitFor(() => expect(reports).toHaveLength(1));
    expect(reports[0]).toEqual({ phase: 'queued', running: 1, queued: 1 });

    release();
    await run;
    // Spawned, then ready: the fixture writes no progress word, so both read
    // as starting.
    expect(reports.slice(1)).toEqual([{ phase: 'starting' }, { phase: 'starting' }]);
  });

  it('reports nothing about a queue for a call that gets a slot at once', async () => {
    const reports: CallProgress[] = [];
    await runInWorker(sleep(0), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter: new Semaphore(1),
      onProgress: (p) => reports.push(p),
      progressIntervalMs: 60_000,
    });
    expect(reports.map((p) => p.phase)).not.toContain('queued');
    expect(reports[0]).toEqual({ phase: 'starting' });
  });

  it('stops reporting when the call settles', async () => {
    const reports: CallProgress[] = [];
    await runInWorker(sleep(50), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter: new Semaphore(1),
      onProgress: (p) => reports.push(p),
      progressIntervalMs: 5,
    });
    const settled = reports.length;
    // Many intervals later, still the same count: the timer is gone.
    await new Promise((r) => setTimeout(r, 100));
    expect(reports).toHaveLength(settled);
  });

  it('reads where the worker is while it runs, from the word the timeout reads', async () => {
    const reports: CallProgress[] = [];
    const result = await handleSimulate(
      {
        raw: STALLING_RAW,
        sourcetype: 'evil',
        index: 'main',
        host: 'localhost',
        source: '/var/log/x',
        props_conf: stallingStanza(),
        transforms_conf: '',
        per_event_pipeline: false,
        capture_offsets: false,
        include_snapshots: false,
        max_events: 20,
        timeout_ms: 1_000,
      },
      {
        workerPath: WORKER_PATH,
        limiter: new Semaphore(1),
        onProgress: (p) => reports.push(p),
        progressIntervalMs: 20,
      },
    );
    expect(JSON.parse(resultText(result)).error).toBe('timeout');
    // The stalling stanza holds the run in EXTRACT for its whole budget, so
    // the ticks inside it see the stage and the one event it was given.
    expect(reports).toContainEqual({ phase: 'running', stage: 'EXTRACT', events: 1 });
    const phases = reports.map((p) => p.phase);
    expect(phases.indexOf('starting')).toBeLessThan(phases.indexOf('running'));
  });
});

describe('describeProgress', () => {
  it('says how full the queue is, and that the budget has not started', () => {
    expect(describeProgress({ phase: 'queued', running: 4, queued: 1 })).toBe(
      'Waiting for a sandbox slot: 4 runs in progress, 1 call queued, this one included. ' +
        'The timeout_ms budget has not started.',
    );
    expect(describeProgress({ phase: 'queued', running: 1, queued: 3 })).toMatch(/1 run in progress, 3 calls queued/);
  });

  it('names each phase of a run', () => {
    expect(describeProgress({ phase: 'starting' })).toMatch(/budget starts when it is ready/);
    expect(describeProgress({ phase: 'parsing' })).toBe('Parsing the conf.');
    expect(describeProgress({ phase: 'running' })).toBe('Running the engine on the conf.');
    expect(describeProgress({ phase: 'running', stage: 'LINE_BREAKER', events: 0 })).toBe(
      'Running LINE_BREAKER: breaking the sample into events.',
    );
    expect(describeProgress({ phase: 'running', stage: 'EXTRACT', events: 1 })).toBe('Running EXTRACT over 1 event.');
    expect(describeProgress({ phase: 'running', stage: 'EVAL', events: 250 })).toBe('Running EVAL over 250 events.');
    expect(describeProgress({ phase: 'finishing' })).toMatch(/shaping the response/);
  });
});

describe('progressNotifier', () => {
  const fakeExtra = (progressToken: string | number | undefined, send: ToolExtra['sendNotification']) =>
    ({
      ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
      sendNotification: send,
    }) as Pick<ToolExtra, '_meta' | 'sendNotification'>;

  it('asks for no reports when the client sent no progressToken', () => {
    const send = vi.fn(() => Promise.resolve());
    expect(progressNotifier(fakeExtra(undefined, send))).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends notifications/progress with the token, a rising count and the state', () => {
    const send = vi.fn((_: unknown) => Promise.resolve());
    const notify = progressNotifier(fakeExtra('tok-1', send));
    notify?.({ phase: 'queued', running: 1, queued: 1 });
    notify?.({ phase: 'parsing' });
    expect(send.mock.calls.map(([n]) => n)).toEqual([
      {
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 1, message: expect.stringMatching(/^Waiting for a sandbox slot/) },
      },
      {
        method: 'notifications/progress',
        params: { progressToken: 'tok-1', progress: 2, message: 'Parsing the conf.' },
      },
    ]);
  });

  it('drops a notification the transport cannot send', async () => {
    const send = vi.fn(() => Promise.reject(new Error('Not connected')));
    const notify = progressNotifier(fakeExtra(0, send));
    // A token of 0 is a token: only its absence means no progress.
    expect(notify).toBeDefined();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      notify?.({ phase: 'starting' });
      await new Promise((r) => setImmediate(r));
      expect(send).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
