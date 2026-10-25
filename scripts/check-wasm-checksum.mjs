// ---------------------------------------------------------------------------
// check-wasm-checksum.mjs
//
// Verifies the installed pcre2-wasm-utf16's pcre2.wasm against the
// pcre2.wasm.sha256 the package ships. It is a git dependency: the lockfile
// pins its commit but records no integrity hash, and `npm audit` cannot see it,
// so a binary that does not match the checksum its build produced is not the
// one upstream built and published (#504).
//
// The package's checksum comes from the same commit as the binary, so it
// catches corruption but not a pin moved to a different build. The binary is
// also checked against the pcre2.wasm.sha256 at this repository's root, which
// a pin bump has to change in the same diff (#567).
//
// The same check as `sha256sum --check --strict pcre2.wasm.sha256`, in Node so
// it runs on every OS the MCP server's CI does, and from the package's own
// build script.
//
// Resolves the package the way the code that imports it does — from the
// current directory's node_modules — so run it from the package whose copy is
// being checked, or pass that directory:
//
//   node scripts/check-wasm-checksum.mjs [dir]      (default: the cwd)
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyChecksum } from './lib/wasmChecksum.mjs';

const from = resolve(process.argv[2] ?? '.');

let wasmPath;
try {
  wasmPath = createRequire(join(from, 'noop.js')).resolve('pcre2-wasm-utf16/pcre2.wasm');
} catch {
  console.error(`pcre2-wasm-utf16 is not installed for ${from} — run \`npm ci\` first.`);
  process.exit(1);
}

const bytes = readFileSync(wasmPath);
const checks = [
  [join(dirname(wasmPath), 'pcre2.wasm.sha256'), 'the package ships its checksum, and this one does not'],
  [fileURLToPath(new URL('../pcre2.wasm.sha256', import.meta.url)), 'this repository records the hash it expects'],
];
for (const [sumPath, missing] of checks) {
  let sums;
  try {
    sums = readFileSync(sumPath, 'utf8');
  } catch {
    console.error(`${sumPath} is missing: ${missing}.`);
    process.exit(1);
  }
  const { status, expected, actual } = verifyChecksum(bytes, sums, basename(wasmPath));
  if (status === 'no-entry') {
    console.error(`${sumPath} has no valid entry for ${basename(wasmPath)}.`);
    process.exit(1);
  }
  if (status === 'mismatch') {
    console.error(`${wasmPath}: FAILED against ${sumPath}\n  expected ${expected}\n  actual   ${actual}`);
    process.exit(1);
  }
  console.log(`${wasmPath}: OK against ${sumPath} (${actual})`);
}
