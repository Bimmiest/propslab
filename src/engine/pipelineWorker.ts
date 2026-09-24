/**
 * Web Worker entry point for the Splunk processing pipeline.
 *
 * Runs runPipeline() off the main thread so the UI stays responsive
 * even for large inputs or expensive regex transforms.
 *
 * Message protocol:
 *   in  → PipelineWorkerRequest
 *   out → WORKER_READY once, when the module has loaded (#339); then PipelineWorkerResponse
 */

import { runPipeline } from './pipeline';
import type { ConfInput, EventMetadata, PipelineOptions } from './types';
import { WORKER_READY } from './workerProtocol';

export interface PipelineWorkerRequest {
  id: number;
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
  result: ReturnType<typeof runPipeline> | null;
  error?: string;
  /**
   * The stack of the error that `error` describes, when it was an `Error` that
   * had one. A separate optional field so every existing reader of `error`
   * keeps getting the bare message: this is for diagnosing a throw that escaped
   * runPipeline, which the message alone rarely locates (#322).
   */
  stack?: string;
}

self.onmessage = (e: MessageEvent<PipelineWorkerRequest>) => {
  const { id, rawData, metadata, propsConfText, transformsConfText, options } = e.data;
  try {
    const output = runPipeline(rawData, metadata, propsConfText, transformsConfText, options);
    const response: PipelineWorkerResponse = { id, result: output };
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
};

// Last, so it is only sent once every import above has evaluated and the
// handler is installed. Anything the worker throws before this point is a
// failure to load, not something a request did to it (#339).
self.postMessage(WORKER_READY);
