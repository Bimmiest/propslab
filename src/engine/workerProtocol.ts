/**
 * The one message every worker entry sends unprompted (#339).
 *
 * Each entry posts `WORKER_READY` as the last statement of its module, so it
 * arrives only once every import has evaluated and `self.onmessage` is in
 * place. The page uses it to tell a worker that never started from one that
 * started and then died: an `error` before `ready` is a load failure — a chunk
 * that 404s, a CSP block, a module that throws while evaluating — and says
 * nothing about the request in flight; an `error` after it is a crash, and the
 * request is the suspect.
 *
 * Before this the page guessed from whether the worker had answered anything,
 * and a fresh worker had never answered by definition: the first request is
 * posted in the same commit the worker is built, so a script that threw at top
 * level was always charged to that request.
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
