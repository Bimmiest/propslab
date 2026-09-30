/**
 * Runs one engine operation in a worker thread under a wall-clock budget.
 *
 * This is the primary defence docs/engine.md requires of a consumer executing
 * conf-derived regexes it did not write: a thread the parent can TERMINATE.
 * Those regexes run on PCRE2, whose match limits bound each match; this
 * watchdog bounds the whole run. (The V8 flags in `v8Flags.ts` cover only the
 * engine's own JavaScript regexes.)
 *
 * A fresh worker per call costs a few tens of milliseconds and buys two
 * properties worth far more here: `terminate()` cannot leave a half-poisoned
 * reusable worker behind, and no state crosses from one tool call to the next.
 *
 * The watchdog bounds TIME, and time is not the only thing an agent-written
 * input can exhaust. Two more bounds sit alongside it:
 *
 * - **Memory.** Every worker gets V8 `resourceLimits`. Without them a worker's
 *   heap is sized like the main thread's, so one run that builds an enormous
 *   result (a million-line sample, a capture group that matches everything)
 *   can grow until the whole server process dies — and with it every other
 *   in-flight call. With them, V8 kills only that worker, which surfaces as
 *   `ERR_WORKER_OUT_OF_MEMORY` and is reported as a `WorkerOutOfMemoryError`.
 * - **Concurrency.** A worker can hold its full heap limit and a core for its
 *   full budget, so calls pass through a small semaphore and queue beyond it
 *   — and the queue is bounded too. Every queued call holds its whole input
 *   (up to a megabyte of sample plus two million characters of conf) in the
 *   server's own heap, outside any worker's limit, so an unbounded queue
 *   would only move a burst from the workers to the main thread. Past the bound a call is
 *   refused at once with `WorkerBusyError`, which the tools report as a
 *   structured `busy` error.
 * - **Cancellation.** A slot is scarce, so a call whose MCP request has been
 *   cancelled gives it up: aborting `options.signal` takes a queued call out
 *   of the queue before it ever holds a slot, and terminates a running call's
 *   worker instead of letting it run to its budget.
 *
 * The wall-clock budget starts when the call's worker reports itself ready —
 * loaded, with the regex engine instantiated — NOT when the call is queued
 * nor when its worker is spawned. The timeout error says where the run had
 * got to and advises from that (see `workerFailure` in tools.ts); time spent
 * waiting behind other calls, or starting a thread and evaluating the engine
 * bundle (tens of milliseconds warm, over a hundred cold, against a 100ms
 * minimum budget), says nothing about this call's input, and counting it
 * failed correct confs on a small budget. Start-up has a cap of its own
 * (`DEFAULT_STARTUP_LIMIT_MS`), so a worker that never gets going still ends.
 * The cost is that a queued call's end-to-end latency is its wait plus its
 * start-up plus its budget. That wait is itself bounded — every call ahead of
 * it holds a slot for at most its own start-up cap and budget (≤30s), and with
 * the queue bounded at four calls per slot no call waits behind more than four
 * of those — and the MCP client's request timeout remains the outer limit.
 */
import { Worker, type ResourceLimits } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import type { WorkerData, WorkerMessage, WorkerRequest } from './protocol';
import type { SuspectList } from './suspects';
import { createProgressBuffer, readProgress, type RunProgress } from './progress';
import { regexEngineModule } from './regexEngine';

export class WorkerTimeoutError extends Error {
  readonly budgetMs: number;
  /**
   * The regex-suspect list the worker posted before its run, if it got that
   * far (only simulate posts one). The server never builds this itself: that
   * would mean parsing the caller's conf on its own thread.
   */
  readonly suspects: SuspectList | undefined;
  /** Where the run was when its budget ran out, as the worker last recorded it. */
  readonly progress: RunProgress | undefined;
  constructor(budgetMs: number, suspects?: SuspectList, progress?: RunProgress) {
    super(`Worker exceeded its ${budgetMs}ms wall-clock budget and was terminated`);
    this.name = 'WorkerTimeoutError';
    this.budgetMs = budgetMs;
    this.suspects = suspects;
    this.progress = progress;
  }
}

/**
 * The worker did not report itself ready within the start-up cap, so it never
 * began on the request. Nothing about the input is implicated: start-up does
 * the same work for every call. Its own type so it is not reported as a
 * timeout of the caller's run.
 */
export class WorkerStartTimeoutError extends Error {
  readonly limitMs: number;
  constructor(limitMs: number) {
    super(`Worker did not start within ${limitMs}ms and was terminated`);
    this.name = 'WorkerStartTimeoutError';
    this.limitMs = limitMs;
  }
}

/**
 * The concurrency queue was full, so the call was refused without queuing.
 * Its own type so the tool reports "try again shortly" rather than an
 * engine failure; nothing about the input is wrong.
 */
export class WorkerBusyError extends Error {
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  constructor(maxConcurrent: number, maxQueued: number) {
    super(
      `Server is busy: ${maxConcurrent} run(s) in progress and ${maxQueued} queued, the most it will hold`,
    );
    this.name = 'WorkerBusyError';
    this.maxConcurrent = maxConcurrent;
    this.maxQueued = maxQueued;
  }
}

export class WorkerOutOfMemoryError extends Error {
  readonly limits: ResourceLimits;
  constructor(limits: ResourceLimits) {
    super(
      `Worker exceeded its ${limits.maxOldGenerationSizeMb ?? '?'}MB heap limit and was terminated`,
    );
    this.name = 'WorkerOutOfMemoryError';
    this.limits = limits;
  }
}

/**
 * The MCP request behind a call was cancelled, or its transport closed (the
 * SDK aborts every in-flight handler's signal then too). `started` says
 * whether that happened while the call was still queued — no worker ever ran
 * — or mid-run, when its worker was terminated. Its own type so the tool
 * reports it as neither a timeout, which would blame the conf's regexes, nor
 * an engine failure.
 */
export class WorkerCancelledError extends Error {
  readonly started: boolean;
  readonly reason: unknown;
  constructor(started: boolean, reason?: unknown) {
    super(
      started
        ? 'Request was cancelled; its worker was terminated'
        : 'Request was cancelled before its worker started',
    );
    this.name = 'WorkerCancelledError';
    this.started = started;
    this.reason = reason;
  }
}

/**
 * Per-worker V8 heap limits, sized from the worst input the schemas admit
 * rather than a typical one. The sample dominates: a 1MB sample of
 * one-character lines is 500,000 events, each carrying its own trace. The
 * conf side is bounded too — at most two million characters across every
 * layer of both files (`MAX_TOTAL_CONF_CHARS` in tools.ts), where the
 * per-field limits alone would admit forty million. Measured with both near
 * their maximum — 500,000 events beside 1.9 million characters of conf, with
 * an EXTRACT, SEDCMD, FIELDALIAS and EVAL applying to every event — the run
 * completes at 512MB in about 12s; the sample alone completes even at 256MB.
 * That holds only because the worker trims the result before posting it
 * (serialize.ts): posted whole, it fails between 400,000 and 500,000
 * events. 512MB leaves room for shapes not measured, so hitting it means the
 * run is runaway, not merely big. Young generation is
 * capped too because V8 otherwise sizes it off the machine's memory, not the
 * old-generation limit.
 * `stackSizeMb` stays at Node's default: the engine does not recurse deeply,
 * and a stack overflow already surfaces as an ordinary RangeError inside the
 * worker.
 *
 * A process-wide heap flag (`--max-old-space-size`, including via
 * NODE_OPTIONS) overrides these; the launcher strips them — see heapFlags.ts.
 */
export const DEFAULT_RESOURCE_LIMITS: Readonly<ResourceLimits> = Object.freeze({
  maxOldGenerationSizeMb: 512,
  maxYoungGenerationSizeMb: 64,
});

/**
 * A counting semaphore: at most `max` holders, the rest wait FIFO. FIFO
 * matters — a stack would let a steady stream of new calls starve the first
 * one queued. At most `maxQueued` may wait; beyond that `acquire` rejects
 * with `WorkerBusyError` rather than queuing. Unbounded unless given.
 */
export class Semaphore {
  readonly max: number;
  readonly maxQueued: number;
  private held = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number, maxQueued = Infinity) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
    }
    if (maxQueued !== Infinity && (!Number.isInteger(maxQueued) || maxQueued < 0)) {
      throw new RangeError(`Semaphore maxQueued must be a non-negative integer, got ${maxQueued}`);
    }
    this.max = max;
    this.maxQueued = maxQueued;
  }

  /** Slots currently held. */
  get active(): number {
    return this.held;
  }

  /** Callers waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /**
   * Resolves once a slot is held; call the returned function exactly once to
   * free it. If `signal` aborts first, the caller leaves the queue without
   * ever holding a slot and this rejects with `WorkerCancelledError` — a
   * cancelled request must not keep its place in line, or everything queued
   * behind it waits on a run nobody will read. If no slot is free and the
   * queue already holds `maxQueued` callers, this rejects with
   * `WorkerBusyError` at once.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw new WorkerCancelledError(false, signal.reason);
    if (this.held < this.max) {
      this.held++;
    } else {
      if (this.waiters.length >= this.maxQueued) {
        throw new WorkerBusyError(this.max, this.maxQueued);
      }
      // The releasing caller hands its slot straight to us (see release), so
      // `held` is never decremented and re-incremented in between — nothing
      // arriving meanwhile can jump the queue.
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          // Only reachable while still queued: the hand-off below removes
          // this listener in the same synchronous step that dequeues us, so
          // an abort can never strand a slot that was already handed over.
          const i = this.waiters.indexOf(waiter);
          if (i !== -1) this.waiters.splice(i, 1);
          reject(new WorkerCancelledError(false, signal?.reason));
        };
        const waiter = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        this.waiters.push(waiter);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) next();
      else this.held--;
    };
  }
}

/**
 * At most four workers at once, fewer on a smaller machine. Each is CPU-bound
 * for up to its budget, so running more than there are cores only stretches
 * every call's wall clock towards its timeout; four is the ceiling because
 * this is one agent's local tool server, not a shared service, and four
 * workers at the heap limit is already two gigabytes.
 */
export const DEFAULT_MAX_CONCURRENT_WORKERS = Math.max(1, Math.min(4, os.availableParallelism()));

/**
 * Four waiting calls per slot. Enough that an agent fanning out a
 * handful of calls never sees `busy`, few enough that no queued call waits
 * behind more than four budgets (two minutes at the 30s maximum), and that
 * the inputs parked in the server's own heap stay bounded: sixteen calls at
 * the schema maximum is on the order of a hundred megabytes.
 */
export const DEFAULT_MAX_QUEUED_CALLS = 4 * DEFAULT_MAX_CONCURRENT_WORKERS;

/**
 * Longest a worker may take to report itself ready before it is terminated.
 * Start-up measures about 60ms warm and 120ms cold on an idle machine; this
 * leaves two orders of magnitude for a loaded one, and exists so a start that
 * hangs still ends rather than holding its slot for ever.
 */
export const DEFAULT_STARTUP_LIMIT_MS = 10_000;

const defaultLimiter = new Semaphore(DEFAULT_MAX_CONCURRENT_WORKERS, DEFAULT_MAX_QUEUED_CALLS);

export interface RunInWorkerOptions {
  /** Worker script. Defaults to the sibling `simulateWorker.js` bundle. */
  workerPath?: string;
  /** Overrides `DEFAULT_RESOURCE_LIMITS` (tests use a tiny heap to force OOM). */
  resourceLimits?: ResourceLimits;
  /** Overrides the process-wide concurrency cap (tests use their own). */
  limiter?: Semaphore;
  /** Overrides `DEFAULT_STARTUP_LIMIT_MS` (tests use a short one). */
  startupLimitMs?: number;
  /**
   * The MCP request's cancellation signal (`extra.signal` in a tool handler).
   * Aborting it dequeues a waiting call, or terminates a running call's
   * worker; either way the call rejects with `WorkerCancelledError`.
   */
  signal?: AbortSignal;
}

export async function runInWorker<T>(
  request: WorkerRequest,
  timeoutMs: number,
  workerPathOrOptions?: string | RunInWorkerOptions,
): Promise<T> {
  const options: RunInWorkerOptions =
    typeof workerPathOrOptions === 'string'
      ? { workerPath: workerPathOrOptions }
      : (workerPathOrOptions ?? {});
  const { signal } = options;
  const release = await (options.limiter ?? defaultLimiter).acquire(signal);
  // The slot can be handed over in the same tick the request is cancelled
  // (the hand-off wins that race inside acquire). Spawning then would run a
  // worker for nobody, so give the slot straight back instead.
  if (signal?.aborted) {
    release();
    throw new WorkerCancelledError(false, signal.reason);
  }
  let run: { result: Promise<T>; exited: Promise<void> };
  try {
    run = spawnAndWait<T>(request, timeoutMs, options);
  } catch (err) {
    release();
    throw err;
  }
  // The slot frees when the thread has actually exited, not when the call
  // settles. terminate() is asynchronous, and a timed-out worker is by
  // definition one that was busy — releasing on settle would let the cap
  // count it as gone while it is still burning a core.
  void run.exited.then(release);
  return run.result;
}

function spawnAndWait<T>(
  request: WorkerRequest,
  timeoutMs: number,
  options: RunInWorkerOptions,
): { result: Promise<T>; exited: Promise<void> } {
  // Resolved lazily: in the esbuild CJS bundle `__dirname` is the dist
  // directory and the worker is the sibling bundle; tests running from source
  // pass the built worker's path explicitly.
  const resolvedPath = options.workerPath ?? path.join(__dirname, 'simulateWorker.js');
  const resourceLimits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
  const { signal } = options;

  // Compiled (once per process) before the worker exists and before its
  // budget starts, so no request pays for it.
  const progress = createProgressBuffer();
  const workerData: WorkerData = { ...request, regexEngine: regexEngineModule(), progress };
  // `stdout: true` because by default a worker's console.log lands on the
  // server's stdout, which is the JSON-RPC channel: one stray line corrupts
  // the stream. `end: false` so the worker exiting does not end stderr.
  const worker = new Worker(resolvedPath, { workerData, resourceLimits, stdout: true });
  worker.stdout.pipe(process.stderr, { end: false });
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));

  const result = new Promise<T>((resolve, reject) => {
    let settled = false;
    let suspects: SuspectList | undefined;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
      void worker.terminate();
    };

    // Start-up first, under its own cap; the budget replaces it on `ready`.
    // Progress is read before terminate() is asked for, while the word still
    // holds the worker's last write.
    const startupLimitMs = options.startupLimitMs ?? DEFAULT_STARTUP_LIMIT_MS;
    let timer = setTimeout(() => {
      settle(() => reject(new WorkerStartTimeoutError(startupLimitMs)));
    }, startupLimitMs);
    const startBudget = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const at = readProgress(progress);
        settle(() => reject(new WorkerTimeoutError(timeoutMs, suspects, at)));
      }, timeoutMs);
    };

    // A cancelled call's answer will never be read (the SDK drops responses
    // to cancelled requests), so letting it run on to its budget only keeps a
    // slot and a core from calls whose answers will be. As with a timeout,
    // the slot frees on the worker's actual exit (see runInWorker), not here.
    const onAbort = () => settle(() => reject(new WorkerCancelledError(true, signal?.reason)));
    signal?.addEventListener('abort', onAbort, { once: true });

    worker.on('message', (message: WorkerMessage) => {
      if ('kind' in message) {
        if (settled) return;
        if (message.kind === 'ready') startBudget();
        else suspects = message.list;
        return;
      }
      settle(() => {
        if (message.ok) resolve(message.data as T);
        else reject(new Error(message.error));
      });
    });
    worker.once('error', (err) =>
      settle(() => {
        // V8 hit a resourceLimits ceiling and Node stopped the worker. Mapped
        // to its own type so the tool reports it as "too big", not as a crash.
        if ((err as NodeJS.ErrnoException | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY') {
          reject(new WorkerOutOfMemoryError(resourceLimits));
        } else {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }),
    );
    worker.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Worker exited with code ${code} before responding`));
    });
  });

  return { result, exited };
}
