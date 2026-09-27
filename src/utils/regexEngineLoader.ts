/**
 * Loading the PCRE2 module in the browser: compiled once per page, streaming,
 * and handed to every worker as the compiled `WebAssembly.Module`, so no worker
 * compiles its own and no request's watchdog is charged for compilation.
 *
 * `main.tsx` awaits {@link loadRegexEngine} before the first render, so the
 * main thread (the editor's diagnostics, the inline pipeline fallback) and
 * every worker built afterwards can assume the engine is there.
 */

import wasmUrl from '../../packages/pcre2-wasm/pcre2.wasm?url';
import { initRegexEngine, regexEngineModule } from './splunkRegex';
import type { WorkerInitMessage } from '../engine/workerProtocol';

let loading: Promise<void> | null = null;

async function compile(): Promise<WebAssembly.Module> {
  try {
    return await WebAssembly.compileStreaming(fetch(wasmUrl));
  } catch (e) {
    // compileStreaming insists on the application/wasm MIME type; a host that
    // serves the file as something else still serves the right bytes.
    if (!(e instanceof TypeError)) throw e;
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Could not load the regex engine (${response.status} ${response.url})`, { cause: e });
    }
    return WebAssembly.compile(await response.arrayBuffer());
  }
}

/**
 * The performance-timeline entry spanning fetch, compile and instantiate. The
 * end-to-end suite reads it to hold cold-start cost to a budget.
 */
export const REGEX_ENGINE_MEASURE = 'propslab:regex-engine';

/** Fetch, compile and instantiate the engine on this thread, once. */
export function loadRegexEngine(): Promise<void> {
  loading ??= (async () => {
    const start = performance.now();
    await initRegexEngine(await compile());
    performance.measure(REGEX_ENGINE_MEASURE, { start, end: performance.now() });
  })();
  return loading;
}

/**
 * Post the compiled engine to a freshly built worker. First, before any
 * request: the worker instantiates it and only then signals ready, so a
 * request can never reach a worker without an engine.
 */
export function withRegexEngine(worker: Worker): Worker {
  const message: WorkerInitMessage = { type: 'init', regexEngine: regexEngineModule() };
  worker.postMessage(message);
  return worker;
}
