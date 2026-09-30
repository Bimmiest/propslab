// The comparison behind scripts/check-wasm-checksum.mjs, apart from finding the
// package: reading a `sha256sum` file and checking a binary against it.

import { createHash } from 'node:crypto';

/**
 * The hash a checksum file lists for `name`. Lines are `<64 hex>  <name>`, as
 * sha256sum writes them; `*` in place of the second space marks binary mode.
 * @param {string} sums
 * @param {string} name
 * @returns {string | undefined}
 */
export function expectedChecksum(sums, name) {
  const entries = [...sums.matchAll(/^([0-9a-f]{64}) [ *](.+)$/gm)];
  return entries.find(([, , entryName]) => entryName === name)?.[1];
}

/**
 * @param {Uint8Array} bytes
 * @param {string} sums the checksum file's text
 * @param {string} name the file's name as the checksum file lists it
 * @returns {{ status: 'ok' | 'no-entry' | 'mismatch', expected?: string, actual: string }}
 */
export function verifyChecksum(bytes, sums, name) {
  const actual = createHash('sha256').update(bytes).digest('hex');
  const expected = expectedChecksum(sums, name);
  if (expected === undefined) return { status: 'no-entry', actual };
  return { status: actual === expected ? 'ok' : 'mismatch', expected, actual };
}
