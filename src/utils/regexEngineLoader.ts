/// <reference types="vite/client" />
/**
 * Loading the PCRE2 module in the browser. The page and each worker load it
 * for themselves, from the one same-origin asset URL fixed at build time:
 * compiling takes a few milliseconds, and taking a compiled module from a
 * message would let message data decide what code a worker runs.
 *
 * `main.tsx` awaits {@link loadRegexEngine} before the first render, so the
 * main thread (the editor's diagnostics, the inline pipeline fallback) can
 * assume the engine is there. Worker entries use {@link serveWithRegexEngine}.
 */

import wasmUrl from '../../packages/pcre2-wasm/pcre2.wasm?url';
import { initRegexEngine } from './splunkRegex';
import { WORKER_READY } from '../engine/workerProtocol';

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

/** The part of a worker's global scope a worker entry serves requests through. */
export interface WorkerScope<Req> {
  onmessage: ((e: MessageEvent<Req>) => void) | null;
  postMessage(message: unknown): void;
}

/**
 * A worker entry's message loop: load the engine, then post `WORKER_READY`,
 * then handle requests — in arrival order, including any posted while the
 * engine was loading, which wait for it.
 *
 * Both outcomes of the load are acted on in a task of their own rather than in
 * the promise callback, so a throw is an uncaught worker error the page sees:
 * an engine that will not load fails before ready, which the page counts as a
 * failure to load (#339), and a handler that throws after ready is a crash, as
 * it was before.
 */
export function serveWithRegexEngine<Req>(scope: WorkerScope<Req>, handle: (request: Req) => void): void {
  let up = false;
  const waiting: Req[] = [];
  scope.onmessage = (e) => {
    if (up) handle(e.data);
    else waiting.push(e.data);
  };
  loadRegexEngine().then(
    () =>
      setTimeout(() => {
        up = true;
        scope.postMessage(WORKER_READY);
        for (const request of waiting.splice(0)) handle(request);
      }),
    (err: unknown) =>
      setTimeout(() => {
        throw err;
      }),
  );
}
