/**
 * The one message every worker entry sends unprompted.
 *
 * Each entry posts `WORKER_READY` once its imports have evaluated,
 * `self.onmessage` is in place and it has loaded its regex engine (see
 * `serveWithRegexEngine`). The page uses ready to
 * tell a worker that never started from one that started and then died: an
 * `error` before `ready` is a load failure — a chunk that 404s, a CSP block, a
 * module that throws while evaluating, an engine that will not instantiate —
 * and says nothing about the request in flight; an `error` after it is a
 * crash, and the request is the suspect. Whether the worker has answered
 * anything cannot tell the two apart: the first request is posted in the same
 * commit the worker is built, before its script has run.
 *
 * Kept in the engine, with no DOM or worker types, so the worker entries can
 * import it under the engine's ES2022-only type check.
 */

export interface WorkerReadyMessage {
  type: 'ready';
}

export const WORKER_READY: WorkerReadyMessage = { type: 'ready' };

/**
 * Whether a message from a worker is its ready signal rather than a response.
 * Responses carry an `id` and no `type`, so the two cannot be confused.
 */
export function isWorkerReadyMessage(data: unknown): data is WorkerReadyMessage {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'ready';
}

// ---------------------------------------------------------------------------
// Inputs sent once, and requests only the newest of which matters
//
// The live testers (the Regex and Timestamp tabs) match one changing pattern
// against the same events many times over. Cloning every event into each
// request cost about 10 MB per keystroke at 20k events, so the events travel
// once, in an inputs message, and each request names them by `inputsId`.
// The page's lifecycle re-sends the current inputs first to any replacement
// worker, so a request never reaches a worker without them.
//
// Each request from those tabs supersedes the ones before it, but a worker
// runs its messages one after another: with a slow pattern, the answer the
// user is waiting for came only after every superseded run. A request marked
// `latestOnly` is skipped, answered with `skipped` and not run, when another
// `latestOnly` request is already queued behind it.
// ---------------------------------------------------------------------------

/** The inputs later requests refer to by `inputsId`. Never answered. */
export interface WorkerInputsMessage<T> {
  type: 'inputs';
  inputsId: number;
  inputs: T;
}

export function isWorkerInputsMessage(data: unknown): data is WorkerInputsMessage<unknown> {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'inputs';
}

/** What a queued request may carry besides its own payload. */
export interface QueuedRequest {
  id: number;
  /** The inputs message this request runs over. */
  inputsId?: number;
  /** Skip this request if a newer `latestOnly` one is already waiting. */
  latestOnly?: boolean;
}

/** The answer to a request that was skipped because a newer one superseded it. */
export interface WorkerSkippedResponse {
  id: number;
  skipped: true;
}

export function isWorkerSkippedResponse(data: unknown): data is WorkerSkippedResponse {
  return typeof data === 'object' && data !== null && (data as { skipped?: unknown }).skipped === true;
}

export interface RequestQueueOptions<TInputs, TReq extends QueuedRequest> {
  /**
   * Run a request. `inputs` is the stored inputs when the request names the
   * current `inputsId`, else undefined (a request that carries its own).
   */
  run: (request: TReq, inputs: TInputs | undefined) => void;
  /** Answer a request that will not run. */
  skip: (request: TReq) => void;
  /** Run `drain` in a later task, after the messages already delivered. */
  defer: (drain: () => void) => void;
  /** Report a throw from `run` without abandoning the requests behind it. */
  rethrow: (err: unknown) => void;
}

/**
 * A worker's message handler for inputs messages and requests, in arrival
 * order. A `latestOnly` request waits one task, so that any newer request
 * already posted is delivered first and can supersede it; everything else is
 * handled at once unless something is already waiting.
 */
export function createRequestQueue<TInputs, TReq extends QueuedRequest>(
  options: RequestQueueOptions<TInputs, TReq>,
): (message: TReq | WorkerInputsMessage<TInputs>) => void {
  let current: { inputsId: number; inputs: TInputs } | null = null;
  const queue: (TReq | WorkerInputsMessage<TInputs>)[] = [];
  let scheduled = false;

  const handle = (message: TReq | WorkerInputsMessage<TInputs>, supersededBy: boolean) => {
    if (isWorkerInputsMessage(message)) {
      current = { inputsId: message.inputsId, inputs: message.inputs };
      return;
    }
    if (supersededBy) {
      options.skip(message);
      return;
    }
    const inputs =
      message.inputsId !== undefined && current?.inputsId === message.inputsId ? current.inputs : undefined;
    try {
      options.run(message, inputs);
    } catch (err) {
      options.rethrow(err);
    }
  };

  const drain = () => {
    scheduled = false;
    const batch = queue.splice(0);
    let newest = -1;
    batch.forEach((m, i) => {
      if (!isWorkerInputsMessage(m) && m.latestOnly === true) newest = i;
    });
    batch.forEach((m, i) => {
      handle(m, !isWorkerInputsMessage(m) && m.latestOnly === true && i < newest);
    });
  };

  return (message) => {
    const waits = !isWorkerInputsMessage(message) && message.latestOnly === true;
    if (!waits && queue.length === 0) {
      handle(message, false);
      return;
    }
    queue.push(message);
    if (!scheduled) {
      scheduled = true;
      options.defer(drain);
    }
  };
}
