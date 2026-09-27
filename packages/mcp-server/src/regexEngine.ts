/**
 * The PCRE2 WebAssembly module every sandbox worker runs its patterns on,
 * compiled once in the server process and handed to each worker with its
 * request (a `WebAssembly.Module` clones across threads), so a worker only
 * instantiates it and no request's budget pays for compilation.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  initRegexEngineSync,
  isRegexEngineReady,
  regexEngineModule as compiledModule,
  type RegexEngineModule,
} from '../../../src/utils/splunkRegex';

/**
 * Where the module is: beside the bundle (the build copies it into dist/, so
 * dist/ still works when copied away from the package), or in the
 * pcre2-wasm package when running from source.
 */
function modulePath(): string {
  const candidates = [
    path.join(__dirname, 'pcre2.wasm'),
    path.join(__dirname, '..', '..', 'pcre2-wasm', 'pcre2.wasm'),
  ];
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new Error(`pcre2.wasm not found (looked in ${candidates.join(', ')})`);
  return found;
}

/** The compiled module, compiling (and instantiating) it on first use. */
export function regexEngineModule(): RegexEngineModule {
  if (!isRegexEngineReady()) initRegexEngineSync(readFileSync(modulePath()));
  return compiledModule();
}
