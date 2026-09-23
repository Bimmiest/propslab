import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  runInWorker,
  Semaphore,
  WorkerOutOfMemoryError,
} from '../runInWorker';
import type { WorkerRequest } from '../protocol';
import { handleSimulate } from '../tools';
import { stripHeapSizeFlags, stripHeapSizeFlagsFromNodeOptions } from '../heapFlags';

/**
 * The sandbox's non-timeout bounds — heap limit, concurrency cap — and the
 * launcher's signal handling. Fixture workers stand in for the engine where
 * the property under test is about the worker plumbing, not about what any
 * particular conf costs to run.
 */
const fixture = (name: string) =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const OOM_WORKER = fixture('oomWorker.cjs');
const SLEEP_WORKER = fixture('sleepWorker.cjs');
const LAUNCHER = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

// The fixtures read only what they need out of workerData, so the request is
// a stand-in rather than a real engine op.
const sleep = (ms: number) => ({ ms }) as unknown as WorkerRequest;

// Small enough that the fixture hits it in milliseconds.
const TINY_HEAP = { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 4 };

interface SleepResult {
  startedAt: number;
  endedAt: number;
}

// A heap-size flag on THIS process (e.g. NODE_OPTIONS=--max-old-space-size=…)
// overrides every worker's resourceLimits, which is exactly why the launcher
// strips them — but vitest is not started through the launcher, so here the
// limit cannot be observed. Skipped rather than failed: the launcher test
// below covers the stripping itself.
const heapFlagsInEffect =
  stripHeapSizeFlags(process.execArgv).length !== process.execArgv.length ||
  stripHeapSizeFlagsFromNodeOptions(process.env.NODE_OPTIONS ?? '') !==
    (process.env.NODE_OPTIONS ?? '');

describe.skipIf(heapFlagsInEffect)('worker heap limit', () => {
  it('maps ERR_WORKER_OUT_OF_MEMORY to WorkerOutOfMemoryError', async () => {
    const run = runInWorker(sleep(0), 10_000, {
      workerPath: OOM_WORKER,
      resourceLimits: TINY_HEAP,
      limiter: new Semaphore(1),
    });
    await expect(run).rejects.toBeInstanceOf(WorkerOutOfMemoryError);
    await expect(run).rejects.toMatchObject({ limits: TINY_HEAP });
  }, 20_000);

  it('reports an out-of-memory run as a structured tool error', async () => {
    const result = await handleSimulate(
      {
        raw: 'x\n',
        sourcetype: 'st',
        index: 'main',
        host: 'localhost',
        source: '/var/log/x',
        props_conf: '',
        transforms_conf: '',
        per_event_pipeline: false,
        capture_offsets: false,
        include_snapshots: false,
        max_events: 20,
        timeout_ms: 10_000,
      },
      { workerPath: OOM_WORKER, resourceLimits: TINY_HEAP, limiter: new Semaphore(1) },
    );
    expect(result.isError).toBe(true);
    const out = JSON.parse(result.content[0].text);
    expect(out.error).toBe('out_of_memory');
    expect(out.heap_limit_mb).toBe(16);
    expect(out.guidance).toMatch(/smaller raw sample/);
  }, 20_000);
});

describe('concurrency cap', () => {
  it('defaults to between one and four workers', () => {
    expect(DEFAULT_MAX_CONCURRENT_WORKERS).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_MAX_CONCURRENT_WORKERS).toBeLessThanOrEqual(4);
  });

  it('never runs more workers than the cap, and queues the rest', async () => {
    const limiter = new Semaphore(2);
    let peakActive = 0;
    let peakQueued = 0;
    const sample = setInterval(() => {
      peakActive = Math.max(peakActive, limiter.active);
      peakQueued = Math.max(peakQueued, limiter.queued);
    }, 5);
    try {
      const runs = await Promise.all(
        Array.from({ length: 5 }, () =>
          runInWorker<SleepResult>(sleep(150), 10_000, { workerPath: SLEEP_WORKER, limiter }),
        ),
      );
      // Overlap measured from inside the workers, independently of the
      // limiter's own bookkeeping.
      const overlapAt = (t: number) =>
        runs.filter((r) => r.startedAt <= t && t < r.endedAt).length;
      expect(Math.max(...runs.map((r) => overlapAt(r.startedAt)))).toBeLessThanOrEqual(2);
      expect(peakActive).toBe(2);
      expect(peakQueued).toBeGreaterThanOrEqual(1);
    } finally {
      clearInterval(sample);
    }
    // Slots free on the worker's exit, which trails its answer slightly.
    await vi.waitFor(() => expect(limiter.active).toBe(0));
    expect(limiter.queued).toBe(0);
  }, 20_000);

  it('does not count queued time against the wall-clock budget', async () => {
    const limiter = new Semaphore(1);
    const first = runInWorker(sleep(1_500), 10_000, { workerPath: SLEEP_WORKER, limiter });
    // Queued behind ~1.5s of the first run, with a 1s budget of its own:
    // it only passes if the budget starts when its worker does.
    const second = runInWorker(sleep(50), 1_000, { workerPath: SLEEP_WORKER, limiter });
    await expect(first).resolves.toBeDefined();
    await expect(second).resolves.toBeDefined();
  }, 20_000);

  it('hands slots out first come, first served', async () => {
    const limiter = new Semaphore(1);
    const order: number[] = [];
    const release = await limiter.acquire();
    const waiters = [1, 2, 3].map(async (n) => {
      const done = await limiter.acquire();
      order.push(n);
      done();
    });
    release();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
    expect(limiter.active).toBe(0);
  });
});

describe('heap-size flag stripping', () => {
  it('drops heap-size flags from execArgv in every spelling node accepts', () => {
    expect(
      stripHeapSizeFlags([
        '--max-old-space-size=8192',
        '--max_semi_space_size',
        '64',
        '--max-heap-size=100',
        '--enable-source-maps',
      ]),
    ).toEqual(['--enable-source-maps']);
  });

  it('edits NODE_OPTIONS in place, leaving everything else byte for byte', () => {
    expect(
      stripHeapSizeFlagsFromNodeOptions(
        '--require "/a path/x.js" --max-old-space-size=8192 --max-semi-space-size 32',
      ).trim(),
    ).toBe('--require "/a path/x.js"');
    const untouched = '--require  "/a  path/x.js"   --enable-source-maps';
    expect(stripHeapSizeFlagsFromNodeOptions(untouched)).toBe(untouched);
  });
});

// The launcher re-execs node, so a client holds the pid of a shim, not of the
// server. pgrep finds the server behind it; Linux-only, which is what CI runs.
describe.skipIf(process.platform !== 'linux')('launcher', () => {
  const startLauncher = (extraEnv: Record<string, string> = {}) =>
    new Promise<{ launcher: ReturnType<typeof spawn>; serverPid: number }>((resolve, reject) => {
      const env = { ...process.env, ...extraEnv };
      delete env.PROPSLAB_MCP_NO_REEXEC;
      const launcher = spawn(process.execPath, [LAUNCHER], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      let stderr = '';
      launcher.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
        if (stderr.includes('listening on stdio')) {
          const serverPid = Number(
            execFileSync('pgrep', ['-P', String(launcher.pid)]).toString().trim(),
          );
          resolve({ launcher, serverPid });
        }
      });
      launcher.once('exit', () => reject(new Error(`launcher exited early: ${stderr}`)));
    });

  const exitOf = (proc: ReturnType<typeof spawn>) =>
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      proc.once('exit', (code, signal) => resolve({ code, signal })),
    );

  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('forwards SIGTERM to the server rather than orphaning it', async () => {
    const { launcher, serverPid } = await startLauncher();
    const exited = exitOf(launcher);
    try {
      launcher.kill('SIGTERM');
      expect(await exited).toEqual({ code: null, signal: 'SIGTERM' });
      expect(isAlive(serverPid)).toBe(false);
    } finally {
      if (isAlive(serverPid)) process.kill(serverPid, 'SIGKILL');
    }
  }, 20_000);

  it('dies by the same signal the server did', async () => {
    const { launcher, serverPid } = await startLauncher();
    const exited = exitOf(launcher);
    // Before, a signalled child was reported as a plain exit code 1.
    process.kill(serverPid, 'SIGTERM');
    expect(await exited).toEqual({ code: null, signal: 'SIGTERM' });
  }, 20_000);

  it("passes the server's exit code through", async () => {
    const { launcher } = await startLauncher();
    const exited = exitOf(launcher);
    // stdin EOF is the transport closing; the server exits cleanly.
    launcher.stdin?.end();
    expect(await exited).toEqual({ code: 0, signal: null });
  }, 20_000);

  it('starts the server without heap-size flags that would lift the sandbox limit', async () => {
    const { launcher, serverPid } = await startLauncher({
      NODE_OPTIONS: '--max-old-space-size=8192',
    });
    try {
      const environ = readFileSync(`/proc/${serverPid}/environ`, 'utf8').split('\0');
      const nodeOptions = environ.find((e) => e.startsWith('NODE_OPTIONS='));
      expect(nodeOptions ?? '').not.toMatch(/max-old-space-size/);
    } finally {
      launcher.kill('SIGTERM');
      await exitOf(launcher);
    }
  }, 20_000);
});
