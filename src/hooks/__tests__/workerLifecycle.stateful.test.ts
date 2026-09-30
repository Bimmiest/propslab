// ---------------------------------------------------------------------------
// workerLifecycle.stateful.test.ts
// A model-based (fast-check `commands`) test of the worker lifecycle (#513).
//
// The lifecycle is a state machine (post, ready, forget, watchdog, crash,
// restart, load-failure cap) whose bugs kept turning up one sequence at a time
// (#420, #421, #436, #491). The example tests in workerLifecycle.test.ts pin
// each sequence after the fact; this generates sequences of
//
//   post, postWhenReady, forget, worker ready, worker result, worker error,
//   timer expiry, an event from a worker already replaced, dispose
//
// and checks, after every step and at the end of every sequence:
//
//   - a superseded (forgotten) request is never reported as answered, crashed
//     or timed out, and never handed to a callback at all;
//   - every request that is not superseded gets exactly one outcome, and is
//     never lost while it is in flight;
//   - a crash or a timeout is blamed on exactly the request the worker was
//     running, and never on one queued behind it (#491);
//   - a request that crashed a worker never reaches the caller's inline
//     fallback;
//   - a worker is never built while MAX_WORKER_LOAD_FAILURES loads in a row
//     have failed, and `post` refuses only then: crashes never spend the cap;
//   - no timer outlives its request, and a worker that has been replaced is
//     deaf: its late events change nothing;
//   - a load timer that fires when every request that waited on the loading
//     worker has been forgotten changes nothing: no failure is counted and
//     the worker, which may only be slow, is kept (#523).
//
// The "model" is the bookkeeping in `Sim`: the requests posted, which are
// superseded, what each was told, and what the fake workers were sent. The
// fake worker answers strictly in posting order, as a real one does.
//
// GAP. The lifecycle does not run anything inline; that is each caller's
// policy. "A crashed request never runs inline" is therefore checked against
// the reference caller policy in `Sim.fallback` (the pipeline's), and what the
// lifecycle can be held to is what that policy relies on: it hands the crashed
// request over, blamed and only once, and never lets a crash spend the load
// cap. A caller that runs inline anyway is not something this file can catch.
// Not modelled: a `create` that throws (covered by workerLifecycle.test.ts).
//
// The seed comes from FC_SEED when set, and is fixed otherwise.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createManagedWorker, MAX_WORKER_LOAD_FAILURES, type ManagedWorker } from '../workerLifecycle';
import { WORKER_READY } from '../../engine/workerProtocol';

interface Req { id: number }
interface Res { id: number }

const TIMEOUT_MS = 1000;
const DEFAULT_SEED = 513;

/** The app's tsconfig has no Node types, so `process` is reached through globalThis. */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

function parseSeed(raw: string | undefined): number {
  const parsed = raw === undefined || raw === '' ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_SEED;
}

function invariant(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`invariant violated: ${message}`);
}

class FakeWorker {
  /** Posted to this worker and not yet answered, in the order it will run them. */
  queue: number[] = [];
  everPosted: number[] = [];
  ready = false;
  terminated = false;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;

  postMessage(message: Req) {
    this.queue.push(message.id);
    this.everPosted.push(message.id);
  }
  terminate() {
    this.terminated = true;
  }
}

/** What the step now running is allowed to make the lifecycle call back. */
type Expected =
  | { kind: 'none' }
  | { kind: 'result'; id: number }
  | { kind: 'crash'; headLive: boolean; live: number[] }
  | { kind: 'timeout'; head: number; headLive: boolean; tail: number[] }
  | { kind: 'loadFailure'; live: number[] };

interface Calls {
  responses: number[];
  timeouts: number[];
  crashes: number[][];
  loadFailures: number[][];
}

const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const ids = (requests: readonly Req[]) => requests.map((r) => r.id);

class Sim {
  readonly workers: FakeWorker[] = [];
  readonly managed: ManagedWorker<Req>;
  /** Every id ever posted. */
  readonly posted = new Set<number>();
  /** Forgotten or disposed while unanswered: nothing may ever be said about them. */
  readonly superseded = new Set<number>();
  readonly outcomes = new Map<number, string>();
  readonly crashed = new Set<number>();
  private readonly retried = new Set<number>();
  /** Requests handed to postWhenReady that wait for the current worker's ready. */
  deferred: number[] = [];
  /** Consecutive load failures, as the cap counts them. */
  loadFailures = 0;
  private nextId = 1;
  private expected: Expected = { kind: 'none' };
  calls: Calls = { responses: [], timeouts: [], crashes: [], loadFailures: [] };

  constructor() {
    this.managed = createManagedWorker<Req, Res>({
      create: () => {
        invariant(this.loadFailures < MAX_WORKER_LOAD_FAILURES, 'a worker was built with the load-failure cap spent');
        const w = new FakeWorker();
        this.workers.push(w);
        return w as unknown as Worker;
      },
      timeoutMs: TIMEOUT_MS,
      onResponse: (response, request) => {
        invariant(response.id === request.id, 'a response was delivered with a different request');
        invariant(this.expected.kind === 'result' && this.expected.id === request.id, `unexpected response for ${request.id}`);
        this.calls.responses.push(request.id);
        this.outcome(request.id, 'response');
      },
      onTimeout: (request, others, loaded) => {
        const e = this.expected;
        invariant(e.kind === 'timeout', `unexpected timeout for ${request.id}`);
        invariant(loaded, 'a watchdog fired on a worker that never loaded');
        invariant(e.headLive && e.head === request.id, `timeout blamed ${request.id}, the worker was running ${e.head}${e.headLive ? '' : ' (superseded)'}`);
        invariant(same(ids(others), e.tail), `timeout handed back ${JSON.stringify(ids(others))}, expected ${JSON.stringify(e.tail)}`);
        this.calls.timeouts.push(request.id);
        this.outcome(request.id, 'timeout');
        for (const r of others) this.place(r);
      },
      onCrash: (inFlight, message) => {
        const e = this.expected;
        invariant(e.kind === 'crash', `unexpected crash report (${message})`);
        invariant(
          e.headLive ? same(ids(inFlight), e.live) : inFlight.length === 0 && e.live.length === 0,
          `crash handed back ${JSON.stringify(ids(inFlight))}; the running request was ${e.headLive ? 'live' : 'superseded'}, live in flight were ${JSON.stringify(e.live)}`,
        );
        this.calls.crashes.push(ids(inFlight));
        const [blamed, ...rest] = inFlight;
        if (blamed) {
          this.crashed.add(blamed.id);
          // The pipeline's policy: one replay, then give up.
          if (this.retried.has(blamed.id)) this.outcome(blamed.id, 'crash');
          else {
            this.retried.add(blamed.id);
            this.place(blamed);
          }
        }
        for (const r of rest) this.place(r);
      },
      onLoadFailure: (inFlight, capped) => {
        const e = this.expected;
        invariant(e.kind === 'loadFailure', `unexpected load failure for ${JSON.stringify(ids(inFlight))}`);
        invariant(same(ids(inFlight), e.live), `load failure handed back ${JSON.stringify(ids(inFlight))}, expected ${JSON.stringify(e.live)}`);
        invariant(capped === this.loadFailures >= MAX_WORKER_LOAD_FAILURES, `capped=${String(capped)} with ${this.loadFailures} load failures`);
        this.calls.loadFailures.push(ids(inFlight));
        for (const r of inFlight) this.place(r);
      },
    });
  }

  current(): FakeWorker | null {
    const w = this.workers[this.workers.length - 1];
    return w && !w.terminated ? w : null;
  }

  private live = (id: number) => !this.superseded.has(id);
  private liveIds = (list: readonly number[]) => list.filter(this.live);
  private outstanding = () => [...this.posted].filter((id) => !this.outcomes.has(id) && !this.superseded.has(id));

  private begin(expected: Expected) {
    this.expected = expected;
    this.calls = { responses: [], timeouts: [], crashes: [], loadFailures: [] };
  }

  private outcome(id: number, kind: string) {
    invariant(!this.superseded.has(id), `superseded request ${id} was reported (${kind})`);
    invariant(!this.outcomes.has(id), `request ${id} got a second outcome (${kind}) after ${this.outcomes.get(id)}`);
    this.outcomes.set(id, kind);
  }

  /** What a caller does with a request it must run again: post it, or fall back. */
  private place(request: Req) {
    if (this.managed.post(request)) return;
    invariant(this.loadFailures >= MAX_WORKER_LOAD_FAILURES, `post refused ${request.id} with only ${this.loadFailures} load failures`);
    this.fallback(request);
  }

  /** The reference caller policy: inline, except for a request that crashed a worker. */
  private fallback(request: Req) {
    this.outcome(request.id, this.crashed.has(request.id) ? 'gaveUp' : 'inline');
  }

  // -- commands ------------------------------------------------------------

  post(whenReady: boolean) {
    const request = { id: this.nextId++ };
    this.posted.add(request.id);
    this.begin({ kind: 'none' });
    const ok = whenReady ? this.managed.postWhenReady(request) : this.managed.post(request);
    if (!ok) {
      invariant(this.loadFailures >= MAX_WORKER_LOAD_FAILURES, `post refused ${request.id} with only ${this.loadFailures} load failures`);
      this.fallback(request);
    } else if (whenReady && !this.current()?.ready) {
      this.deferred.push(request.id);
    }
    this.settle();
  }

  forget() {
    this.begin({ kind: 'none' });
    for (const id of this.outstanding()) this.superseded.add(id);
    this.deferred = [];
    this.managed.forget();
    this.settle();
  }

  ready() {
    const w = this.current();
    invariant(w !== null && !w.ready, 'ready with no loading worker');
    this.begin({ kind: 'none' });
    w.ready = true;
    this.loadFailures = 0;
    this.deferred = [];
    w.onmessage?.({ data: WORKER_READY } as MessageEvent);
    this.settle();
  }

  result() {
    const w = this.current();
    invariant(w !== null && w.ready, 'result with no loaded worker');
    const id = w.queue.shift();
    invariant(id !== undefined, 'result with nothing queued');
    const live = this.live(id);
    this.begin({ kind: 'result', id: live ? id : -1 });
    w.onmessage?.({ data: { id } } as MessageEvent);
    invariant(same(this.calls.responses, live ? [id] : []), `response for ${id} (live: ${String(live)}) produced ${JSON.stringify(this.calls.responses)}`);
    this.settle();
  }

  /** The current worker raises an error: a load failure before ready, a crash after. */
  error() {
    const w = this.current();
    invariant(w !== null, 'error with no worker');
    if (!w.ready) this.failLoad(() => w.onerror?.(new Event('error')));
    else this.crash(w);
    this.settle();
  }

  /** The next timer fires: the load timer before ready, the head's watchdog after. */
  expire() {
    const w = this.current();
    invariant(w !== null, 'a timer is pending with no worker');
    if (!w.ready) {
      if (this.waitingOn(w).length > 0) this.failLoad(() => vi.advanceTimersToNextTimer());
      else this.idleLoadTimer(w);
    } else {
      const [head, ...queued] = w.queue;
      invariant(head !== undefined, 'a watchdog is pending with nothing running');
      const headLive = this.live(head);
      const tail = this.liveIds(queued);
      this.begin({ kind: 'timeout', head, headLive, tail });
      const before = this.workers.length;
      vi.advanceTimersToNextTimer();
      invariant(w.terminated, 'a hung worker was not terminated');
      invariant(this.workers.length === before + 1, 'a hung worker was not replaced exactly once');
      invariant(same(this.calls.timeouts, headLive ? [head] : []), `timeout of ${head} (live: ${String(headLive)}) produced ${JSON.stringify(this.calls.timeouts)}`);
      invariant(same(this.current()?.queue ?? [], tail), 'the requests behind a hung one were not re-posted, in order, on the replacement');
    }
    this.settle();
  }

  /** The live requests waiting on a loading worker: posted to it, or deferred until it loads. */
  private waitingOn(w: FakeWorker): number[] {
    return [...this.liveIds(w.queue), ...this.liveIds(this.deferred)];
  }

  /** The load timer fires with nothing live waiting on the worker (#523). */
  private idleLoadTimer(w: FakeWorker) {
    this.begin({ kind: 'none' });
    const before = this.workers.length;
    vi.advanceTimersToNextTimer();
    invariant(!w.terminated, 'a load timer nobody was waiting on terminated a loading worker');
    invariant(this.workers.length === before, 'a load timer nobody was waiting on built a worker');
    invariant(vi.getTimerCount() === 0, 'a load timer nobody was waiting on left a timer behind');
  }

  private failLoad(trigger: () => void) {
    const w = this.current();
    invariant(w !== null, 'load failure with no worker');
    const live = this.waitingOn(w);
    this.loadFailures += 1;
    this.deferred = [];
    this.begin({ kind: 'loadFailure', live });
    const before = this.workers.length;
    trigger();
    invariant(w.terminated, 'a worker that failed to load was not terminated');
    const capped = this.loadFailures >= MAX_WORKER_LOAD_FAILURES;
    invariant(this.workers.length === before + (capped ? 0 : 1), `a load failure built ${this.workers.length - before} workers (capped: ${String(capped)})`);
    invariant(this.calls.loadFailures.length === 1, 'a load failure was not reported exactly once');
  }

  private crash(w: FakeWorker) {
    const [head, ...queued] = w.queue;
    const headLive = head !== undefined && this.live(head);
    const live = headLive ? [head, ...this.liveIds(queued)] : this.liveIds(queued);
    this.begin({ kind: 'crash', headLive, live });
    const before = this.workers.length;
    w.onerror?.({ message: 'boom' } as ErrorEvent);
    invariant(w.terminated, 'a crashed worker was not terminated');
    // Replaced when something wanted was in flight, and not otherwise: a worker
    // that dies idle is replaced by the next post, not in a loop.
    invariant(this.workers.length === before + (live.length > 0 ? 1 : 0), `a crash with ${live.length} live requests built ${this.workers.length - before} workers`);
    if (headLive) {
      invariant(this.calls.crashes.length === 1, 'a crash of a live request was not reported exactly once');
    } else if (live.length === 0) {
      invariant(this.calls.crashes.length === 1, 'a crash with nothing live was not reported');
    } else {
      // #491: the request that died is superseded; those behind it never
      // started, so nothing is blamed and they run on the replacement.
      invariant(this.calls.crashes.length === 0, 'a crash of a superseded request was reported against a newer one');
      invariant(same(this.current()?.queue ?? [], live), 'requests behind a crashed superseded one were not re-posted');
    }
  }

  /** An event from a worker that has been terminated: heard by nobody. */
  stale(kind: 'ready' | 'result' | 'error', pick: number) {
    const dead = this.workers.filter((w) => w.terminated);
    const w = dead[pick % dead.length];
    invariant(w !== undefined, 'stale event with no dead worker');
    this.begin({ kind: 'none' });
    const workers = this.workers.length;
    const timers = vi.getTimerCount();
    const snapshot = JSON.stringify([...this.outcomes]);
    if (kind === 'ready') w.onmessage?.({ data: WORKER_READY } as MessageEvent);
    else if (kind === 'result') w.onmessage?.({ data: { id: w.everPosted[pick % Math.max(1, w.everPosted.length)] ?? 1 } } as MessageEvent);
    else w.onerror?.({ message: 'late' } as ErrorEvent);
    invariant(this.workers.length === workers && vi.getTimerCount() === timers, `a late ${kind} from a replaced worker changed the lifecycle`);
    invariant(snapshot === JSON.stringify([...this.outcomes]), `a late ${kind} from a replaced worker produced an outcome`);
    this.settle();
  }

  dispose() {
    this.begin({ kind: 'none' });
    for (const id of this.outstanding()) this.superseded.add(id);
    this.deferred = [];
    this.loadFailures = 0;
    this.managed.dispose();
    invariant(this.current() === null && vi.getTimerCount() === 0, 'dispose left a worker or a timer behind');
    this.settle();
  }

  // -- invariants ----------------------------------------------------------

  /** Everything that must hold between any two steps. */
  private settle() {
    invariant(this.calls.responses.length + this.calls.timeouts.length <= 1, 'more than one request was answered by a single event');
    this.begin({ kind: 'none' });

    const live = this.workers.filter((w) => !w.terminated);
    invariant(live.length <= 1, 'more than one live worker');
    const cur = this.current();
    invariant(cur === null || live[0] === cur, 'the live worker is not the newest');
    invariant(cur === null || this.loadFailures < MAX_WORKER_LOAD_FAILURES, 'a worker exists with the load-failure cap spent');

    // Every request still wanted is somewhere it will be answered from.
    for (const id of this.outstanding()) {
      invariant(cur !== null && (cur.queue.includes(id) || this.deferred.includes(id)), `request ${id} is neither on the worker nor waiting for it`);
    }

    // No timer without a request: none with no worker; one watchdog (the
    // head's) on a loaded worker that has something to run; at most the load
    // timer on one that is loading, and always that when a live request is
    // waiting for it. A load timer armed for requests since forgotten may
    // still be pending; `expire` holds its firing to changing nothing.
    const timers = vi.getTimerCount();
    if (cur === null) invariant(timers === 0, `${timers} timers with no worker`);
    else if (cur.ready) invariant(timers === (cur.queue.length > 0 ? 1 : 0), `${timers} timers on a loaded worker with ${cur.queue.length} queued`);
    else {
      invariant(timers <= 1, `${timers} timers on a loading worker`);
      if (this.waitingOn(cur).length > 0) invariant(timers === 1, 'a loading worker has live requests waiting and no load timer');
    }
  }

  /** Bring the run to rest and check what only holds at rest. */
  finish(drain: 'answer' | 'hang') {
    if (drain === 'answer') {
      const w = this.current();
      if (w && !w.ready) this.ready();
      while ((this.current()?.queue.length ?? 0) > 0) this.result();
    } else {
      for (let guard = 0; vi.getTimerCount() > 0; guard++) {
        invariant(guard < 100, 'timers never ran out');
        this.expire();
      }
    }
    invariant(vi.getTimerCount() === 0, 'a timer outlived every request');
    for (const id of this.posted) {
      const outcome = this.outcomes.get(id);
      if (this.superseded.has(id)) invariant(outcome === undefined, `superseded request ${id} got outcome ${String(outcome)}`);
      else invariant(outcome !== undefined, `request ${id} never got an outcome`);
      if (this.crashed.has(id)) invariant(outcome !== 'inline', `request ${id} crashed a worker and then ran inline`);
    }
    this.managed.dispose();
    invariant(vi.getTimerCount() === 0 && this.workers.every((w) => w.terminated), 'dispose left a timer or a worker behind');
  }
}

// -- commands ---------------------------------------------------------------

type Cmd = fc.Command<Sim, undefined>;

const cmd = (name: string, check: (s: Sim) => boolean, run: (s: Sim) => void): Cmd => ({
  check,
  run: (s) => run(s),
  toString: () => name,
});

const loading = (s: Sim) => {
  const w = s.current();
  return w !== null && !w.ready;
};
const loaded = (s: Sim) => s.current()?.ready === true;

const commands: fc.Arbitrary<Cmd>[] = [
  ...[false, false, false, true].map((whenReady) => fc.constant(cmd(whenReady ? 'postWhenReady' : 'post', () => true, (s) => s.post(whenReady)))),
  ...[0, 1].map(() => fc.constant(cmd('forget', () => true, (s) => s.forget()))),
  ...[0, 1, 2].map(() => fc.constant(cmd('worker ready', loading, (s) => s.ready()))),
  ...[0, 1, 2, 3].map(() => fc.constant(cmd('worker result', (s) => loaded(s) && (s.current()?.queue.length ?? 0) > 0, (s) => s.result()))),
  ...[0, 1].map(() => fc.constant(cmd('worker error', (s) => s.current() !== null, (s) => s.error()))),
  ...[0, 1].map(() => fc.constant(cmd('timer expires', () => vi.getTimerCount() > 0, (s) => s.expire()))),
  fc.tuple(fc.constantFrom('ready', 'result', 'error'), fc.nat(50)).map(([kind, pick]) =>
    cmd(`late ${kind} from a replaced worker (${pick})`, (s) => s.workers.some((w) => w.terminated), (s) => s.stale(kind, pick)),
  ),
  fc.constant(cmd('dispose', () => true, (s) => s.dispose())),
];

describe('workerLifecycle as a state machine (#513)', () => {
  // Stubbed per test, not once: vitest's `unstubGlobals` resets stubs before
  // each test, which would undo a beforeAll stub.
  beforeEach(() => {
    vi.stubGlobal('Worker', FakeWorker);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('upholds its invariants over arbitrary sequences of posts, forgets, worker events and timers', () => {
    fc.assert(
      fc.property(fc.commands(commands, { maxCommands: 60 }), fc.constantFrom('answer', 'hang'), (cmds, drain) => {
        vi.clearAllTimers();
        const sim = new Sim();
        fc.modelRun(() => ({ model: sim, real: undefined }), cmds);
        sim.finish(drain);
      }),
      { seed: parseSeed(env?.['FC_SEED']), numRuns: 500 },
    );
  });

  it('takes its seed from FC_SEED, and falls back to a fixed one', () => {
    expect(parseSeed('1234')).toBe(1234);
    expect(parseSeed('not a number')).toBe(DEFAULT_SEED);
    expect(parseSeed('')).toBe(DEFAULT_SEED);
    expect(parseSeed(undefined)).toBe(DEFAULT_SEED);
  });
});
