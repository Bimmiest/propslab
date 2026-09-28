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
