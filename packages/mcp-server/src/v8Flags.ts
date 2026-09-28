/**
 * Lets V8 abandon a backtracking match and finish on its linear-time engine,
 * per docs/engine.md. User patterns run on PCRE2, not V8, so this covers only
 * the engine's own JavaScript regexes, built from fixed shapes; what bounds a
 * user pattern is PCRE2's match limits and the terminatable worker in
 * `runInWorker.ts`.
 *
 * The launcher (`index.ts`) re-execs node with these as real CLI flags, which
 * is the documented, guaranteed way to set them before anything compiles a
 * regex. `setFlagsFromString` here is the fallback for embedders that import
 * the server without the launcher (tests, programmatic use): it must run
 * before the engine modules load, which is why every entry point imports this
 * module FIRST — ESM evaluates imports in declaration order, so this module
 * body finishes before the engine's top-level regexes compile.
 */
import v8 from 'node:v8';

export const REGEXP_FALLBACK_FLAGS = [
  '--enable-experimental-regexp-engine-on-excessive-backtracks',
  '--regexp-backtracks-before-fallback=1000',
];

export function flagsAlreadySet(): boolean {
  return process.execArgv.includes(REGEXP_FALLBACK_FLAGS[0]);
}

if (!flagsAlreadySet()) {
  for (const flag of REGEXP_FALLBACK_FLAGS) {
    v8.setFlagsFromString(flag);
  }
}
