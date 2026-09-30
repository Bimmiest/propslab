/**
 * Launcher. docs/engine.md requires the V8 regex-fallback flags to be set
 * before the first regex they protect is compiled, and the only guaranteed
 * way to do that is on the node command line — so this process re-execs
 * itself with the flags and only then loads the server (and with it the
 * engine). Worker threads inherit process-wide V8 flags, so the sandbox
 * worker is covered by the same re-exec.
 *
 * It re-execs whenever heap-size flags need stripping (heapFlags.ts), even if
 * the regex flags are already on the command line: only a fresh process sheds
 * a heap flag already in effect. Likewise when the permission model is off:
 * the server runs under it, reading nothing but its own bundle
 * (permissionFlags.ts).
 *
 * `PROPSLAB_MCP_NO_REEXEC=1` opts out; `v8Flags.ts`'s setFlagsFromString
 * fallback still applies, best-effort — but heap-size flags are then not
 * stripped, so an inherited `--max-old-space-size` overrides the sandbox's
 * per-worker heap limit, and the launcher says so on stderr. Nor is the
 * permission model applied.
 *
 * Node started under `--permission` already (on its command line or in
 * NODE_OPTIONS) keeps the grants it was given: the launcher adds none of its
 * own. It still moves to the bundle directory before starting the server,
 * and says on stderr which grants go beyond its own, so a broader
 * `--allow-fs-read` does not quietly apply (#490). Without
 * `--allow-child-process` it cannot re-exec at all, and says that instead.
 *
 * Because the client holds the pid of this shim rather than of the server,
 * the shim forwards termination signals to the child and exits the way the
 * child did.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { stripHeapSizeFlags, stripHeapSizeFlagsFromNodeOptions } from './heapFlags';
import { adoptPresetPermission, canSpawn, permissionEnabled, permissionFlags } from './permissionFlags';
import { flagsAlreadySet, REGEXP_FALLBACK_FLAGS } from './v8Flags';

async function main(): Promise<void> {
  // Heap-size flags would override the sandbox's per-worker heap limit;
  // see heapFlags.ts.
  const execArgv = stripHeapSizeFlags(process.execArgv);
  const env = { ...process.env };
  if (env['NODE_OPTIONS'] !== undefined) {
    env['NODE_OPTIONS'] = stripHeapSizeFlagsFromNodeOptions(env['NODE_OPTIONS']);
  }
  const heapFlagsSet =
    execArgv.length !== process.execArgv.length || env['NODE_OPTIONS'] !== process.env['NODE_OPTIONS'];

  const reexecWanted = !flagsAlreadySet() || heapFlagsSet || !permissionEnabled();
  if (process.env['PROPSLAB_MCP_NO_REEXEC'] === '1') {
    if (heapFlagsSet) {
      // stderr: stdout belongs to the protocol.
      console.error(
        'propslab MCP server: V8 heap-size flags are set and PROPSLAB_MCP_NO_REEXEC=1 keeps ' +
          'them, so they override the sandbox heap limit',
      );
    }
  } else if (reexecWanted && !canSpawn()) {
    // Started under --permission without --allow-child-process: a re-exec
    // would be refused, so start here with what there is, and say what that
    // leaves in place.
    console.error(
      'propslab MCP server: running under --permission without --allow-child-process, so it ' +
        'cannot re-exec itself' +
        (heapFlagsSet ? '; V8 heap-size flags stay in effect and override the sandbox heap limit' : ''),
    );
  } else if (reexecWanted) {
    if (heapFlagsSet) {
      console.error('propslab MCP server: ignoring V8 heap-size flags so the sandbox heap limit applies');
    }
    const child = spawn(
      process.execPath,
      [
        ...(flagsAlreadySet() ? [] : REGEXP_FALLBACK_FLAGS),
        ...(permissionEnabled() ? [] : permissionFlags(__dirname)),
        ...execArgv,
        __filename,
        ...process.argv.slice(2),
      ],
      // cwd is the bundle directory because, under the permission model, a
      // worker thread can read anything below the process's working directory
      // whatever --allow-fs-read says (measured on Node 22 and 24; the main
      // thread is not affected). A client that starts the server from `/` or
      // a home directory would otherwise hand the sandbox all of it.
      { stdio: 'inherit', env, cwd: __dirname },
    );
    // This process is only a shim: whatever the MCP client does to it has to
    // reach the real server, and whatever the server does has to come back.
    //
    // Inbound: a client stopping the server signals the pid it spawned, which
    // is this one. Without forwarding, the default action killed the shim and
    // left the server orphaned, still holding the client's stdio. (A terminal
    // Ctrl-C reaches both through the process group; the second SIGINT is
    // harmless.) Installing a handler also means the shim does not die
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
        process.exitCode = 128 + os.constants.signals[signal];
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 1);
    });
    return;
  }

  // Under a permission model the launcher did not set (or its own, in the
  // re-exec'd child, where this finds nothing to warn about): move to the
  // bundle directory and say if the grants are wider than the launcher's.
  if (permissionEnabled()) {
    for (const warning of adoptPresetPermission(__dirname)) console.error(warning);
  }

  const { start } = await import('./server');
  await start();
}

main().catch((err: unknown) => {
  console.error('propslab MCP server failed to start:', err);
  process.exit(1);
});
