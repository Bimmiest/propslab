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
import { tokenizeNodeOptions } from './heapFlags';

export const PERMISSION_FLAG = '--permission';

/**
 * Whether this process runs under the permission model, however it was
 * turned on: on the command line, or in `NODE_OPTIONS`, which `execArgv`
 * does not show. `process.permission` exists only when it is on.
 */
export function permissionEnabled(): boolean {
  return (process as { permission?: unknown }).permission !== undefined;
}

/** Whether this process may start another, which the re-exec needs. */
export function canSpawn(): boolean {
  return !permissionEnabled() || process.permission.has('child');
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

export interface PresetPermissionOptions {
  execArgv?: readonly string[];
  nodeOptions?: string;
  cwd?: () => string;
  chdir?: (dir: string) => void;
}

/**
 * For a server about to start in this process under a permission model it
 * did not set itself — node was started with `--permission`, so the launcher
 * added none of its own flags. Moves to `bundleDir`, as the launcher's
 * re-exec does (a worker can read anything below the working directory,
 * whatever `--allow-fs-read` says), and returns a warning for each thing that
 * is still wider than the launcher would have made it: grants beyond its own,
 * or a working directory it could not leave. The server runs either way; the
 * warnings go to stderr so whoever configured the grants can see they apply.
 */
export function adoptPresetPermission(
  bundleDir: string,
  {
    execArgv = process.execArgv,
    nodeOptions = process.env.NODE_OPTIONS ?? '',
    cwd = () => process.cwd(),
    chdir = (dir) => {
      process.chdir(dir);
    },
  }: PresetPermissionOptions = {},
): string[] {
  const warnings: string[] = [];
  const own = new Set(permissionFlags(bundleDir));
  const grants = [...execArgv, ...tokenizeNodeOptions(nodeOptions).map((o) => o.value)].filter(
    (arg) => arg.startsWith('--allow-') && !own.has(arg),
  );
  if (grants.length > 0) {
    warnings.push(
      `propslab MCP server: node was started under --permission with ${grants.join(' ')}; ` +
        `those grants apply to the sandbox instead of the launcher's, which allow reading ` +
        `${bundleDir} and nothing else`,
    );
  }
  if (cwd() !== bundleDir) {
    try {
      chdir(bundleDir);
    } catch (err) {
      warnings.push(
        `propslab MCP server: cannot change to ${bundleDir} (${(err as NodeJS.ErrnoException).code ?? String(err)}); ` +
          `sandbox workers can read anything below ${cwd()}`,
      );
    }
  }
  return warnings;
}
