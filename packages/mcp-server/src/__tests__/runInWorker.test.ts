import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readlinkSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MAX_CONCURRENT_WORKERS,
  DEFAULT_MAX_QUEUED_CALLS,
  runInWorker,
  Semaphore,
  WorkerBusyError,
  WorkerCancelledError,
  WorkerOutOfMemoryError,
} from '../runInWorker';
import type { WorkerRequest } from '../protocol';
import { handleSimulate } from '../tools';
import { stripHeapSizeFlags, stripHeapSizeFlagsFromNodeOptions } from '../heapFlags';
import { REGEXP_FALLBACK_FLAGS } from '../v8Flags';
import { permissionFlags } from '../permissionFlags';
import { resultText } from './resultText';

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
const LOG_WORKER = fixture('logWorker.cjs');
const LAUNCHER = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
// Outside every directory the permission tests allow.
const PACKAGE_JSON = fileURLToPath(new URL('../../package.json', import.meta.url));

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
    const out = JSON.parse(resultText(result));
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

  // Every queued call holds its input in the server's own heap, so the
  // queue is bounded and a call past the bound is refused rather than parked.
  it('bounds the default queue at four calls per slot', () => {
    expect(DEFAULT_MAX_QUEUED_CALLS).toBe(4 * DEFAULT_MAX_CONCURRENT_WORKERS);
  });

  it('refuses a call once the queue is full, without disturbing the queue', async () => {
    const limiter = new Semaphore(1, 2);
    const release = await limiter.acquire();
    const queued = [limiter.acquire(), limiter.acquire()] as const;
    expect(limiter.queued).toBe(2);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(WorkerBusyError);
    expect(limiter.queued).toBe(2);
    // The refused call took no place in line: both queued calls still get
    // their slot, in order, and room reopens as the queue drains.
    release();
    (await queued[0])();
    (await queued[1])();
    expect(limiter.active).toBe(0);
    const again = await limiter.acquire();
    again();
  });

  it('reports a full queue as a structured busy error, not an engine failure', async () => {
    const limiter = new Semaphore(1, 0);
    const release = await limiter.acquire();
    try {
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
        { workerPath: SLEEP_WORKER, limiter },
      );
      expect(result.isError).toBe(true);
      const out = JSON.parse(resultText(result));
      expect(out.error).toBe('busy');
      expect(out.max_concurrent).toBe(1);
      expect(out.max_queued).toBe(0);
    } finally {
      release();
    }
  });
});

describe('cancellation', () => {
  // A worker that fails the moment it is spawned. Pointed at by calls the
  // test cancels before they start: had one started anyway, it would reject
  // with a load error instead of WorkerCancelledError.
  const NEVER_SPAWN = fixture('does-not-exist.cjs');

  it('takes a queued call out of the queue without ever starting its worker', async () => {
    const limiter = new Semaphore(1);
    const first = runInWorker<SleepResult>(sleep(600), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter,
    });
    const controller = new AbortController();
    const cancelled = runInWorker(sleep(0), 10_000, {
      workerPath: NEVER_SPAWN,
      limiter,
      signal: controller.signal,
    });
    const third = runInWorker<SleepResult>(sleep(0), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter,
    });
    await vi.waitFor(() => expect(limiter.queued).toBe(2));

    controller.abort();
    await expect(cancelled).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(cancelled).rejects.toMatchObject({ started: false });
    // Its queue position is gone, and the slot the first run holds is untouched.
    expect(limiter.queued).toBe(1);
    expect(limiter.active).toBe(1);

    // The third call is next in line now, and gets the slot when the first frees it.
    const [a, c] = await Promise.all([first, third]);
    expect(c.startedAt).toBeGreaterThanOrEqual(a.endedAt);
    await vi.waitFor(() => expect(limiter.active).toBe(0));
    expect(limiter.queued).toBe(0);
  }, 20_000);

  it('terminates a running call promptly and frees its slot on exit', async () => {
    const limiter = new Semaphore(1);
    const controller = new AbortController();
    const running = runInWorker(sleep(15_000), 20_000, {
      workerPath: SLEEP_WORKER,
      limiter,
      signal: controller.signal,
    });
    const next = runInWorker<SleepResult>(sleep(0), 10_000, {
      workerPath: SLEEP_WORKER,
      limiter,
    });
    // Let the worker actually start before cancelling it.
    await new Promise((r) => setTimeout(r, 300));

    const abortedAt = Date.now();
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(running).rejects.toMatchObject({ started: true });
    // Without cancellation this call would hold its slot for 15s; the queued
    // one getting to run at all within a few seconds shows it did not.
    const afterNext = await next;
    expect(afterNext.startedAt - abortedAt).toBeLessThan(3_000);
    await vi.waitFor(() => expect(limiter.active).toBe(0));
  }, 20_000);

  it('gives back a slot handed over in the same tick the call is cancelled', async () => {
    const limiter = new Semaphore(1);
    const release = await limiter.acquire();
    const controller = new AbortController();
    const run = runInWorker(sleep(0), 10_000, {
      workerPath: NEVER_SPAWN,
      limiter,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(limiter.queued).toBe(1));
    // The hand-off dequeues the waiter first, so the abort finds it already
    // holding the slot; runInWorker must return it rather than spawn.
    release();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'WorkerCancelledError', started: false });
    expect(limiter.active).toBe(0);
  });

  it('short-circuits an already-aborted signal without taking a free slot', async () => {
    const limiter = new Semaphore(1);
    const run = runInWorker(sleep(0), 10_000, {
      workerPath: NEVER_SPAWN,
      limiter,
      signal: AbortSignal.abort(),
    });
    await expect(run).rejects.toBeInstanceOf(WorkerCancelledError);
    await expect(run).rejects.toMatchObject({ started: false });
    expect(limiter.active).toBe(0);
    expect(limiter.queued).toBe(0);
  });

  it('reports a cancelled call as a structured tool error, not an engine failure', async () => {
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
      { workerPath: NEVER_SPAWN, limiter: new Semaphore(1), signal: AbortSignal.abort() },
    );
    expect(result.isError).toBe(true);
    const out = JSON.parse(resultText(result));
    expect(out.error).toBe('cancelled');
    expect(out.started).toBe(false);
  });
});

describe('worker stdout', () => {
  it("goes to the server's stderr, never to stdout, which is the protocol channel", async () => {
    const written = (spy: { mock: { calls: unknown[][] } }) =>
      spy.mock.calls.map((c) => String(c[0])).join('');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        runInWorker(sleep(0), 10_000, { workerPath: LOG_WORKER, limiter: new Semaphore(1) }),
      ).resolves.toBe('done');
      await vi.waitFor(() => expect(written(stderr)).toContain('more stray output'));
      expect(written(stderr)).toContain('stray worker output');
      expect(written(stdout)).not.toContain('stray');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
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

describe('permission model', () => {
  // Run from the allowed directory, as the launcher runs the server: a worker
  // can read below its process's cwd regardless of the flags.
  it('lets the process and its workers read the bundle directory and nothing else', () => {
    const fixtures = path.dirname(LOG_WORKER);
    const out = execFileSync(
      process.execPath,
      [...permissionFlags(fixtures), path.join(fixtures, 'permissionProbe.cjs'), PACKAGE_JSON],
      { encoding: 'utf8', cwd: fixtures },
    );
    const denied = { inside: 'ok', outside: 'ERR_ACCESS_DENIED' };
    expect(JSON.parse(out)).toEqual({ main: denied, worker: denied });
  });

  it('is not what makes the probe fail: without the flags, both reads succeed', () => {
    const fixtures = path.dirname(LOG_WORKER);
    const out = execFileSync(
      process.execPath,
      [path.join(fixtures, 'permissionProbe.cjs'), PACKAGE_JSON],
      { encoding: 'utf8' },
    );
    const allowed = { inside: 'ok', outside: 'ok' };
    expect(JSON.parse(out)).toEqual({ main: allowed, worker: allowed });
  });
});

// The launcher re-execs node, so a client holds the pid of a shim, not of the
// server. pgrep finds the server behind it; Linux-only, which is what CI runs.
describe.skipIf(process.platform !== 'linux')('launcher', () => {
  const startLauncher = (extraEnv: Record<string, string> = {}, nodeArgs: string[] = []) =>
    new Promise<{ launcher: ReturnType<typeof spawn>; serverPid: number }>((resolve, reject) => {
      const env = { ...process.env, ...extraEnv };
      delete env.PROPSLAB_MCP_NO_REEXEC;
      const launcher = spawn(process.execPath, [...nodeArgs, LAUNCHER], {
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

  it('strips heap-size flags even when the regex flags are already on the command line', async () => {
    // Before, the launcher skipped its re-exec whenever the regex flags were
    // present, so the heap flags stayed in effect.
    const { launcher, serverPid } = await startLauncher(
      { NODE_OPTIONS: '--max-old-space-size=8192' },
      [REGEXP_FALLBACK_FLAGS[0], '--max-semi-space-size=64'],
    );
    try {
      const environ = readFileSync(`/proc/${serverPid}/environ`, 'utf8').split('\0');
      const nodeOptions = environ.find((e) => e.startsWith('NODE_OPTIONS='));
      expect(nodeOptions ?? '').not.toMatch(/max-old-space-size/);
      const cmdline = readFileSync(`/proc/${serverPid}/cmdline`, 'utf8').split('\0');
      expect(cmdline).not.toContain('--max-semi-space-size=64');
      // Not passed twice.
      expect(cmdline.filter((a) => a === REGEXP_FALLBACK_FLAGS[0])).toHaveLength(1);
    } finally {
      launcher.kill('SIGTERM');
      await exitOf(launcher);
    }
  }, 20_000);

  it('starts the server under the permission model, reading only its bundle', async () => {
    const { launcher, serverPid } = await startLauncher();
    try {
      const cmdline = readFileSync(`/proc/${serverPid}/cmdline`, 'utf8').split('\0');
      expect(cmdline).toEqual(expect.arrayContaining(permissionFlags(path.dirname(LAUNCHER))));
      expect(cmdline.filter((a) => a.startsWith('--allow-'))).toEqual([
        '--allow-worker',
        `--allow-fs-read=${path.dirname(LAUNCHER)}`,
      ]);
      // Workers can read below the cwd whatever the flags say (see index.ts).
      expect(readlinkSync(`/proc/${serverPid}/cwd`)).toBe(path.dirname(LAUNCHER));
    } finally {
      launcher.kill('SIGTERM');
      await exitOf(launcher);
    }
  }, 20_000);

  it('answers a simulate call under the permission model', async () => {
    const { launcher } = await startLauncher();
    const exited = exitOf(launcher);
    let stdout = '';
    launcher.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const send = (msg: unknown) => launcher.stdin?.write(`${JSON.stringify(msg)}\n`);
    send({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'propslab-permission-test', version: '0.0.0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'simulate',
        arguments: { raw: 'a=1\n', sourcetype: 'st', props_conf: '[st]\nEXTRACT-x = a=(?<n>\\d+)' },
      },
    });
    try {
      // The worker reads its bundle and the regex engine from dist/, so a
      // field extracted by a PCRE2 pattern shows both were allowed.
      await vi.waitFor(() => expect(stdout).toContain('"id":1'), { timeout: 15_000 });
      const response = stdout.split('\n').find((l) => l.includes('"id":1')) ?? '';
      const out = JSON.parse(resultText(JSON.parse(response).result));
      expect(out.events[0].fields.n).toBe('1');
    } finally {
      launcher.stdin?.end();
      await exited;
    }
  }, 20_000);

  it('warns when PROPSLAB_MCP_NO_REEXEC=1 keeps heap-size flags', async () => {
    const server = spawn(process.execPath, [LAUNCHER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PROPSLAB_MCP_NO_REEXEC: '1',
        NODE_OPTIONS: '--max-old-space-size=8192',
      },
    });
    let stderr = '';
    server.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const exited = exitOf(server);
    await vi.waitFor(() => expect(stderr).toContain('listening on stdio'), { timeout: 15_000 });
    server.stdin.end();
    await exited;
    expect(stderr).toMatch(/heap-size flags .*override the sandbox heap limit/);
  }, 20_000);
});
