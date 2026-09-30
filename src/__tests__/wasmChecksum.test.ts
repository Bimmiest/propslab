import { describe, it, expect } from 'vitest';
import { expectedChecksum, verifyChecksum } from '../../scripts/lib/wasmChecksum.mjs';

// The comparison behind scripts/check-wasm-checksum.mjs (#504); locating the
// installed package is the script's own.
const BYTES = new TextEncoder().encode('not really wasm');
const OTHER = 'b'.repeat(64);

describe('expectedChecksum', () => {
  it('reads the text-mode line sha256sum writes', () => {
    expect(expectedChecksum(`${OTHER}  pcre2.wasm\n`, 'pcre2.wasm')).toBe(OTHER);
  });

  it('reads the binary-mode line, where a star replaces the second space', () => {
    expect(expectedChecksum(`${OTHER} *pcre2.wasm\n`, 'pcre2.wasm')).toBe(OTHER);
  });

  it('finds the entry for the named file among several', () => {
    const sums = `${'a'.repeat(64)}  other.bin\n${OTHER}  pcre2.wasm\n`;
    expect(expectedChecksum(sums, 'pcre2.wasm')).toBe(OTHER);
  });

  it('finds nothing for a name that is not listed, or for a name that only ends the same', () => {
    expect(expectedChecksum(`${OTHER}  pcre2.wasm\n`, 'other.wasm')).toBeUndefined();
    expect(expectedChecksum(`${OTHER}  dir/pcre2.wasm\n`, 'pcre2.wasm')).toBeUndefined();
  });

  it('rejects a line that is not 64 lowercase hex characters', () => {
    expect(expectedChecksum(`${'a'.repeat(63)}  pcre2.wasm\n`, 'pcre2.wasm')).toBeUndefined();
    expect(expectedChecksum(`${'A'.repeat(64)}  pcre2.wasm\n`, 'pcre2.wasm')).toBeUndefined();
    expect(expectedChecksum('', 'pcre2.wasm')).toBeUndefined();
  });
});

describe('verifyChecksum', () => {
  it('accepts a binary that matches the listed hash', () => {
    // The hash is computed, not written down, so this proves the two agree
    // rather than that one constant matches another.
    const actual = verifyChecksum(BYTES, `${OTHER}  pcre2.wasm\n`, 'pcre2.wasm').actual;
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyChecksum(BYTES, `${actual}  pcre2.wasm\n`, 'pcre2.wasm')).toEqual({
      status: 'ok',
      expected: actual,
      actual,
    });
  });

  it('reports a mismatch with both hashes', () => {
    const result = verifyChecksum(BYTES, `${OTHER}  pcre2.wasm\n`, 'pcre2.wasm');
    expect(result.status).toBe('mismatch');
    expect(result.expected).toBe(OTHER);
    expect(result.actual).not.toBe(OTHER);
  });

  it('reports a checksum file with no entry, which is not a pass', () => {
    const result = verifyChecksum(BYTES, `${OTHER}  something-else.wasm\n`, 'pcre2.wasm');
    expect(result.status).toBe('no-entry');
    expect(result).not.toHaveProperty('expected');
  });

  it('hashes SHA-256 (a well-known vector)', () => {
    const abc = new TextEncoder().encode('abc');
    expect(verifyChecksum(abc, '', 'x').actual).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});
