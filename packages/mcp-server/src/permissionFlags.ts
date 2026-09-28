/**
 * Node's permission model for the re-exec'd server (#455). The engine does no
 * I/O: the server reads its own bundle, the worker bundle and pcre2.wasm, all
 * of which the build puts in one directory, and talks to the client over
 * stdio. So reads are limited to that directory, and everything else the model
 * gates — writes, child processes, native addons, WASI, the inspector — stays
 * off. Workers are allowed because the sandbox is a worker; they run under the
 * same restrictions as the thread that started them.
 *
 * Kept apart from `index.ts` so it can be tested without importing the
 * launcher, whose module body re-execs node.
 */

export const PERMISSION_FLAG = '--permission';

export function permissionEnabled(): boolean {
  return process.execArgv.includes(PERMISSION_FLAG);
}

/** The flags that run a bundle in `bundleDir` under the permission model. */
export function permissionFlags(bundleDir: string): string[] {
  return [
    PERMISSION_FLAG,
    '--allow-worker',
    `--allow-fs-read=${bundleDir}`,
    // Node prints a SecurityWarning for --allow-worker on the main thread and
    // again for every worker it starts, so each tool call would add two lines
    // to the client's server log about a flag chosen on purpose.
    '--disable-warning=SecurityWarning',
  ];
}
