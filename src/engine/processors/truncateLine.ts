// TRUNCATE's byte cap: the limit a stanza sets, and one line cut to it.
// truncator.ts applies it to each event's segments; lineBreaker.ts reads it
// too, because the merge rules see each line as TRUNCATE leaves it (#561).

import type { ConfDirective } from '../types';
import { effectiveDirective } from '../utils/directiveValues';

// The engine type-checks against ES2022 alone (tsconfig.engine.json), so that
// reaching for a browser-only global fails the build instead of failing in a
// worker or under Node at run time. The UTF-8 codecs are not ES but are
// safe to use: they are globals in browsers, Web Workers and every supported
// Node. Declared here, narrowed to what this file calls, rather than by pulling
// in a whole lib that would also admit DOMParser and friends.
declare const TextEncoder: new () => { encode(input: string): Uint8Array };
declare const TextDecoder: new (label: string, options: { fatal: boolean }) => { decode(input: Uint8Array): string };

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * Return how many bytes of `bytes[0..maxBytes)` form a run of whole UTF-8
 * characters — i.e. `maxBytes` rounded down so it never lands in the middle of
 * a multi-byte sequence. Splunk rounds line-length truncation down to a
 * character boundary; a naive `slice(0, maxBytes)` + lenient decode would emit
 * a U+FFFD replacement character for the trailing partial sequence instead.
 */
function utf8BoundaryLength(bytes: Uint8Array, maxBytes: number): number {
  if (maxBytes >= bytes.length) return bytes.length;
  // Walk back over trailing continuation bytes (0b10xxxxxx) to the lead byte of
  // the character that straddles the cut.
  let i = maxBytes - 1;
  while (i >= 0 && ((bytes[i] ?? 0) & 0b1100_0000) === 0b1000_0000) i--;
  if (i < 0) return maxBytes; // all continuation bytes (malformed) — cut as-is
  const lead = bytes[i];
  if (lead === undefined) return maxBytes;
  let charLen: number;
  if ((lead & 0b1000_0000) === 0) charLen = 1;
  else if ((lead & 0b1110_0000) === 0b1100_0000) charLen = 2;
  else if ((lead & 0b1111_0000) === 0b1110_0000) charLen = 3;
  else if ((lead & 0b1111_1000) === 0b1111_0000) charLen = 4;
  else return maxBytes; // invalid lead byte — cut as-is
  // Keep the straddling character only if it fits entirely within the limit.
  return i + charLen <= maxBytes ? maxBytes : i;
}

/** Truncate one line to at most `maxBytes` bytes, on a UTF-8 char boundary. */
export function truncateLine(line: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = encoder.encode(line);
  if (bytes.length <= maxBytes) return { text: line, truncated: false };
  const end = utf8BoundaryLength(bytes, maxBytes);
  return { text: decoder.decode(bytes.slice(0, end)), truncated: true };
}

/**
 * The cap TRUNCATE sets, in bytes; 0 means none. TRUNCATE must be a clean
 * non-negative integer (byte count). parseInt is far too lenient ("0x10" reads
 * as 0, "1e3" as 1, "100abc" as 100), so anything else takes the default, as an
 * empty assignment and a negative do in Splunk. The directive linter reports a
 * malformed value; this only decides the cap.
 */
export function truncateLimit(directives: ConfDirective[]): { maxBytes: number; isDefault: boolean } {
  const rawValue = effectiveDirective(directives, 'TRUNCATE')?.value.trim() ?? '';
  const valid = /^\d+$/.test(rawValue);
  return { maxBytes: valid ? parseInt(rawValue, 10) : 10000, isDefault: !valid };
}
