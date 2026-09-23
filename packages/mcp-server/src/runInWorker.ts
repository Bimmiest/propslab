/**
 * Runs one engine operation in a worker thread under a wall-clock budget.
 *
 * This is the primary defence docs/engine.md requires of a consumer executing
 * conf-derived regexes it did not write: a thread the parent can TERMINATE.
 * The V8 linear-time-fallback flags (see `v8Flags.ts`) are the second layer —
 * they lower how often this watchdog fires, but a lookahead or backreference
 * declines the fallback, so termination is the mechanism, never the flags.
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
 * - **Concurrency.** A burst of calls used to spawn a worker each, all at once;
 *   each can hold its full heap limit and a core for its full budget. Calls now
 *   pass through a small semaphore and queue beyond it.
 *
 * The wall-clock budget starts when the call's worker is spawned, NOT when the
 * call is queued. A timeout is reported as "your regex backtracked — repair it"
 * (see `workerFailure` in tools.ts), and time spent waiting behind other calls
 * says nothing about this call's patterns; counting it would send an agent to
 * rewrite a correct regex because a neighbour was slow. The cost is that a
 * queued call's end-to-end latency is its wait plus its budget. That wait is
 * itself bounded — every call ahead of it holds a slot for at most its own
 * budget (≤30s) — and the MCP client's request timeout remains the outer limit.
 */
import { Worker, type ResourceLimits } from 'node:worker_threads';
import os from 'node:os';
import path from 'node:path';
import type { WorkerRequest, WorkerResponse } from './protocol';

export class WorkerTimeoutError extends Error {
  readonly budgetMs: number;
  constructor(budgetMs: number) {
    super(`Worker exceeded its ${budgetMs}ms wall-clock budget and was terminated`);
    this.name = 'WorkerTimeoutError';
    this.budgetMs = budgetMs;
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
 * Per-worker V8 heap limits, sized from the worst input the schemas admit
 * rather than a typical one. That is a 1MB sample of very short lines: about
 * 125,000 events, each carrying its own trace, and measured it runs out of
 * heap at 256MB and completes at 512MB. A limit below that would turn a valid
 * (if silly) request into an error, so 512MB it is — hitting it means the run
 * is runaway, not merely big. Young generation is capped too because V8
 * otherwise sizes it off the machine's memory, not the old-generation limit.
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
 * one queued.
 */
export class Semaphore {
  readonly max: number;
  private held = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError(`Semaphore max must be a positive integer, got ${max}`);
    }
    this.max = max;
  }

  /** Slots currently held. */
  get active(): number {
    return this.held;
  }

  /** Callers waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  /** Resolves once a slot is held; call the returned function exactly once to free it. */
  async acquire(): Promise<() => void> {
    if (this.held < this.max) {
      this.held++;
    } else {
      // The releasing caller hands its slot straight to us (see release), so
      // `held` is never decremented and re-incremented in between — nothing
      // arriving meanwhile can jump the queue.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
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

const defaultLimiter = new Semaphore(DEFAULT_MAX_CONCURRENT_WORKERS);

export interface RunInWorkerOptions {
  /** Worker script. Defaults to the sibling `simulateWorker.js` bundle. */
  workerPath?: string;
  /** Overrides `DEFAULT_RESOURCE_LIMITS` (tests use a tiny heap to force OOM). */
  resourceLimits?: ResourceLimits;
  /** Overrides the process-wide concurrency cap (tests use their own). */
  limiter?: Semaphore;
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
  const release = await (options.limiter ?? defaultLimiter).acquire();
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

  const worker = new Worker(resolvedPath, { workerData: request, resourceLimits });
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));

  const result = new Promise<T>((resolve, reject) => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      reject(new WorkerTimeoutError(timeoutMs));
    }, timeoutMs);

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };

    worker.once('message', (response: WorkerResponse) => {
      settle(() => {
        if (response.ok) resolve(response.data as T);
        else reject(new Error(response.error));
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
      reject(new Error(`Worker exited with code ${code} before responding`));
    });
  });

  return { result, exited };
}
