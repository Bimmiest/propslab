// ---------------------------------------------------------------------------
// check-wasm-checksum.mjs
//
// Verifies the installed pcre2-wasm-utf16's pcre2.wasm against the
// pcre2.wasm.sha256 the package ships. It is a git dependency: the lockfile
// pins its commit but records no integrity hash, and `npm audit` cannot see it,
// so a binary that does not match the checksum its build produced is not the
// one upstream built and published (#504).
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

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';

const from = resolve(process.argv[2] ?? '.');

let wasmPath;
try {
  wasmPath = createRequire(join(from, 'noop.js')).resolve('pcre2-wasm-utf16/pcre2.wasm');
} catch {
  console.error(`pcre2-wasm-utf16 is not installed for ${from} — run \`npm ci\` first.`);
  process.exit(1);
}

const sumPath = join(dirname(wasmPath), 'pcre2.wasm.sha256');
let sums;
try {
  sums = readFileSync(sumPath, 'utf8');
} catch {
  console.error(`${sumPath} is missing: the package ships its checksum, and this one does not.`);
  process.exit(1);
}

// `<64 hex>  <name>` lines, as sha256sum writes them; `*` marks binary mode.
const entries = [...sums.matchAll(/^([0-9a-f]{64}) [ *](.+)$/gm)];
const expected = entries.find(([, , name]) => name === basename(wasmPath))?.[1];
if (!expected) {
  console.error(`${sumPath} has no valid entry for ${basename(wasmPath)}.`);
  process.exit(1);
}

const actual = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
if (actual !== expected) {
  console.error(`${wasmPath}: FAILED\n  expected ${expected}\n  actual   ${actual}`);
  process.exit(1);
}
console.log(`${wasmPath}: OK (${actual})`);
