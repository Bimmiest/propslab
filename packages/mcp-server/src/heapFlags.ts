/**
 * V8's heap-size flags are process-wide, and when one is set it takes
 * precedence over the per-worker `resourceLimits` in runInWorker.ts. So a
 * `NODE_OPTIONS=--max-old-space-size=8192` in the user's shell (a common
 * enough fix for unrelated tools) silently raised every sandbox worker's heap
 * ceiling to 8GB. The server's own thread holds little, because the engine
 * runs in the workers, so the launcher drops these flags when it re-execs
 * rather than let them defeat the sandbox.
 *
 * Kept apart from `index.ts` so it can be tested without importing the
 * launcher, whose module body re-execs node.
 */

// `--flag=N` and `--flag N`, `-` or `_` separated: the forms node accepts.
const HEAP_SIZE_FLAG = /^--max[-_](?:old[-_]space|semi[-_]space|heap)[-_]size(?:=|$)/;
const HEAP_SIZE_FLAG_IN_OPTIONS =
  /(^|\s)--max[-_](?:old[-_]space|semi[-_]space|heap)[-_]size(?:=\S*|\s+\d+)?(?=\s|$)/g;

/** `process.execArgv` minus any heap-size flag (and a separate numeric value). */
export function stripHeapSizeFlags(execArgv: readonly string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < execArgv.length; i++) {
    if (!HEAP_SIZE_FLAG.test(execArgv[i])) kept.push(execArgv[i]);
    else if (!execArgv[i].includes('=') && /^\d+$/.test(execArgv[i + 1] ?? '')) i++;
  }
  return kept;
}

/**
 * `NODE_OPTIONS` minus any heap-size flag. Edited in place rather than
 * re-tokenised, so quoting elsewhere in the string (a `--require` path with
 * spaces, say) survives byte for byte; a string with no such flag comes back
 * identical.
 */
export function stripHeapSizeFlagsFromNodeOptions(nodeOptions: string): string {
  return nodeOptions.replace(HEAP_SIZE_FLAG_IN_OPTIONS, '$1');
}
