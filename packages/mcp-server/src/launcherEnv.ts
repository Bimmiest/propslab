/**
 * What the launcher hands the server it re-execs, and how that server notices
 * the launcher is gone. Kept apart from `index.ts` so it can be tested without
 * importing the launcher, whose module body re-execs node.
 */

/** Set by the launcher to its own pid, so the server it starts can watch it. */
export const SHIM_PID_VAR = 'PROPSLAB_MCP_SHIM_PID';

// Matched without case: Windows keeps `Path` and `SystemRoot` in mixed case.
const KEPT = new Set(['PATH', 'NODE_OPTIONS', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'TZ', 'LANG']);

/**
 * The environment of the re-exec'd server: only what node itself reads (#568).
 * MCP clients often start servers with API keys in the environment. The server
 * reads none of it, and its sandbox workers already get none (runInWorker.ts),
 * so nothing else is passed on. SystemRoot is there because node on Windows
 * needs it to start; LANG and LC_* set the process's locale for number
 * formatting in messages.
 */
export function launcherEnv(env: NodeJS.ProcessEnv, shimPid: number): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (KEPT.has(upper) || upper.startsWith('LC_')) kept[key] = value;
  }
  kept[SHIM_PID_VAR] = String(shimPid);
  return kept;
}

/**
 * Whether `pid` is still this process's parent. On POSIX an orphan is
 * re-parented, so `ppid` changes; on Windows it does not, so the pid is also
 * probed. A signal of 0 tests for the process and sends nothing.
 */
export function parentAlive(pid: number, ppid = process.ppid, kill = process.kill.bind(process)): boolean {
  if (ppid !== pid) return false;
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exit once the launcher is gone. A client that stops the server on Windows
 * terminates the launcher outright (TerminateProcess), so no handler runs and
 * nothing is forwarded; nor is a SIGKILL anywhere. Without this the server
 * outlived it, holding the client's stdio (#568). The timer is unref'd, so it
 * never keeps the process up by itself.
 */
export function exitWhenParentGone(
  pid: number,
  alive: (pid: number) => boolean = parentAlive,
  exit: () => void = () => {
    // stderr: stdout belongs to the protocol.
    console.error('propslab MCP server: its launcher is gone; exiting');
    process.exit(0);
  },
  intervalMs = 1000,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (!alive(pid)) {
      clearInterval(timer);
      exit();
    }
  }, intervalMs);
  timer.unref();
  return timer;
}
