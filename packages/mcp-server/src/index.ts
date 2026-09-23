/**
 * Launcher. docs/engine.md requires the V8 regex-fallback flags to be set
 * before the first regex they protect is compiled, and the only guaranteed
 * way to do that is on the node command line — so this process re-execs
 * itself with the flags and only then loads the server (and with it the
 * engine). Worker threads inherit process-wide V8 flags, so the sandbox
 * worker is covered by the same re-exec.
 *
 * `PROPSLAB_MCP_NO_REEXEC=1` opts out; `v8Flags.ts`'s setFlagsFromString
 * fallback still applies, best-effort — but heap-size flags are then not
 * stripped (heapFlags.ts), so an inherited `--max-old-space-size` overrides the
 * sandbox's per-worker heap limit.
 *
 * Because the client holds the pid of this shim rather than of the server,
 * the shim forwards termination signals to the child and exits the way the
 * child did.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { stripHeapSizeFlags, stripHeapSizeFlagsFromNodeOptions } from './heapFlags';
import { flagsAlreadySet, REGEXP_FALLBACK_FLAGS } from './v8Flags';

async function main(): Promise<void> {
  if (!flagsAlreadySet() && process.env.PROPSLAB_MCP_NO_REEXEC !== '1') {
    // Heap-size flags would override the sandbox's per-worker heap limit;
    // see heapFlags.ts.
    const execArgv = stripHeapSizeFlags(process.execArgv);
    const env = { ...process.env };
    if (env.NODE_OPTIONS !== undefined) {
      env.NODE_OPTIONS = stripHeapSizeFlagsFromNodeOptions(env.NODE_OPTIONS);
    }
    if (
      execArgv.length !== process.execArgv.length ||
      env.NODE_OPTIONS !== process.env.NODE_OPTIONS
    ) {
      // stderr: stdout belongs to the protocol.
      console.error(
        'propslab MCP server: ignoring V8 heap-size flags so the sandbox heap limit applies',
      );
    }
    const child = spawn(
      process.execPath,
      [...REGEXP_FALLBACK_FLAGS, ...execArgv, __filename, ...process.argv.slice(2)],
      { stdio: 'inherit', env },
    );
    // This process is only a shim: whatever the MCP client does to it has to
    // reach the real server, and whatever the server does has to come back.
    //
    // Inbound: a client stopping the server signals the pid it spawned, which
    // is this one. Without forwarding, the default action killed the shim and
    // left the server orphaned, still holding the client's stdio. (A terminal
    // Ctrl-C reaches both through the process group; the second SIGINT is
    // harmless.) Installing a handler also means the shim no longer dies
    // before the child does, so the exit below is always observed.
    const forwarded: NodeJS.Signals[] = ['SIGTERM', 'SIGINT', 'SIGHUP'];
    const forward = (signal: NodeJS.Signals) => {
      child.kill(signal);
    };
    for (const signal of forwarded) process.on(signal, forward);

    child.on('error', (err) => {
      console.error('propslab MCP server failed to start:', err);
      process.exit(1);
    });

    // Outbound: exit the way the child did. A code passes straight through. A
    // signal is re-raised on this process with our handlers removed, so the
    // client sees "killed by SIGTERM" rather than an invented exit code 1 —
    // the two mean different things to a supervisor deciding whether to
    // restart. The shell-convention exitCode set first is what's reported if
    // the re-raised signal does not end us (Windows only emulates signals).
    child.on('exit', (code, signal) => {
      for (const s of forwarded) process.off(s, forward);
      if (signal) {
        process.exitCode = 128 + (os.constants.signals[signal] ?? 0);
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
    return;
  }

  const { start } = await import('./server');
  await start();
}

main().catch((err: unknown) => {
  console.error('propslab MCP server failed to start:', err);
  process.exit(1);
});
