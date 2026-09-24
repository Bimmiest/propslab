/**
 * Timing and failure rules shared by the worker hooks and the views that must
 * agree with them. One copy, so a view that waits "as long as the pipeline
 * does" cannot drift from the pipeline (#335).
 */

/** How long input must be still before the pipeline re-runs in auto mode. */
export const PIPELINE_DEBOUNCE_MS = 300;

/**
 * How many workers may fail to *load* in a row before a hook stops building
 * them and runs on the calling thread (#309). Crashes do not count: an input
 * that crashes its worker must never be handed to the tab's own thread (#326).
 */
export const MAX_WORKER_LOAD_FAILURES = 2;

/**
 * Whether a worker `error` event reports a script that never loaded, as opposed
 * to code that ran and threw. Per the HTML spec a failed fetch or parse of the
 * worker script fires a plain `Event`; an uncaught exception fires an
 * `ErrorEvent` carrying a message. A worker that has already answered has
 * loaded by definition.
 */
export function isWorkerLoadFailure(e: Event, answered: boolean): boolean {
  return !answered && !(e as Partial<ErrorEvent>).message;
}
