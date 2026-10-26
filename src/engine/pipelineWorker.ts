/**
 * Web Worker entry point for the Splunk processing pipeline.
 *
 * Runs runPipeline() off the main thread so the UI stays responsive
 * even for large inputs or expensive regex transforms, and reduces its result
 * to what the preview reads before it is cloned back (`toViewResult`).
 *
 * Message protocol:
 *   in  → PipelineWorkerRequest
 *   out → WORKER_READY once, when the worker has loaded its regex engine; then a
 *         PipelineWorkerResponse, or a WorkerSkippedResponse, per request
 */

import { runPipeline } from './pipeline';
import type { ConfInput, EventMetadata, PipelineOptions, ValidationDiagnostic } from './types';
import { serveWithRegexEngine } from '../workers/regexEngineLoader';
import { toViewResult, type ViewResult } from '../utils/viewResult';
import {
  createRequestQueue,
  type QueuedRequest,
  type WorkerInputsMessage,
  type WorkerSkippedResponse,
} from '../workers/workerProtocol';

export interface PipelineWorkerRequest extends QueuedRequest {
  rawData: string;
  metadata: EventMetadata;
  /**
   * Either the text of a single conf, or layers lowest-precedence-first (see
   * `ConfInput`). Layers are plain objects, so they structured-clone across the
   * worker boundary unchanged.
   */
  propsConfText: ConfInput;
  transformsConfText: ConfInput;
  options?: PipelineOptions;
}

export interface PipelineWorkerResponse {
  id: number;
  /** The run's result as the preview holds it (see `toViewResult`), not as `runPipeline` returns it. */
  result: { result: ViewResult; diagnostics: ValidationDiagnostic[] } | null;
  error?: string;
  /**
   * The stack of the error that `error` describes, when it was an `Error` that
   * had one. A separate optional field so every existing reader of `error`
   * keeps getting the bare message: this is for diagnosing a throw that escaped
   * runPipeline, which the message alone rarely locates.
   */
  stack?: string;
  /**
   * How long the run took in the worker, in ms, from when it started rather
   * than when it was posted: a request can wait behind another, and the
   * status bar reports the run.
   */
  runMs?: number;
}

// A request the page marks `latestOnly` is skipped when a newer one is already
// queued behind it, as the live testers' are: an edit made while a slow run is
// in progress supersedes every request typed past, and only the newest runs.
const serve = createRequestQueue<undefined, PipelineWorkerRequest>({
  run: (request) => {
    const { id, rawData, metadata, propsConfText, transformsConfText, options } = request;
    const started = Date.now();
    try {
      const output = runPipeline(rawData, metadata, propsConfText, transformsConfText, options);
      const response: PipelineWorkerResponse = {
        id,
        result: { result: toViewResult(output.result), diagnostics: output.diagnostics },
        runMs: Date.now() - started,
      };
      self.postMessage(response);
    } catch (err) {
      const response: PipelineWorkerResponse = {
        id,
        result: null,
        error: err instanceof Error ? err.message : String(err),
        ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
      };
      self.postMessage(response);
    }
  },
  skip: ({ id }) => self.postMessage({ id, skipped: true } satisfies WorkerSkippedResponse),
  defer: (drain) => setTimeout(drain),
  rethrow: (err) =>
    setTimeout(() => {
      throw err;
    }),
});

// Loads the regex engine from its fixed asset URL, then signals ready and
// serves requests in order; see serveWithRegexEngine.
serveWithRegexEngine<PipelineWorkerRequest | WorkerInputsMessage<undefined>>(self, serve);
