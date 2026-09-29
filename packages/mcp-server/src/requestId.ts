/**
 * Recovering the `id` of a JSON-RPC request that is too large to parse, so the
 * error refusing it can name it (#402). A client matches responses by id; an
 * error without one leaves its call pending until the client's own timeout.
 *
 * Only a bounded window at each end of the line is kept (`ID_SCAN_BYTES`), and
 * each is scanned, not parsed:
 * - the head, forward, for clients that write `id` before the payload
 *   (`{"jsonrpc":"2.0","id":7,"method":…,"params":…}`);
 * - the tail, backward, for those that write it last — the SDK's own client
 *   spreads the request first, so its lines end `…},"jsonrpc":"2.0","id":7}`.
 *
 * Either scan gives up (returns `undefined`) on anything it cannot read
 * conclusively within its window, rather than guess.
 */
import type { RequestId } from '@modelcontextprotocol/sdk/types.js';

/** Bytes kept from each end of an oversize line for the id scans. */
export const ID_SCAN_BYTES = 4096;

/** JSON's whitespace. Takes `undefined` so an index past the end reads as not-whitespace. */
function isWs(c: string | undefined): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}
const NUMBER_AT = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NUMBER_AT_END = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

// Both stop at either end of `s`, where `s[i]` is undefined.
function skipWs(s: string, i: number): number {
  while (isWs(s[i])) i++;
  return i;
}

function skipWsBack(s: string, i: number): number {
  while (isWs(s[i])) i--;
  return i;
}

/** Index just past the string starting at `s[i] === '"'`, or -1 if cut off. */
function stringEnd(s: string, i: number): number {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  return -1;
}

/** Index just past the JSON value starting at `i`, or -1 if cut off. */
function valueEnd(s: string, i: number): number {
  if (s[i] === '"') return stringEnd(s, i);
  if (s[i] !== '{' && s[i] !== '[') {
    let j = i;
    while (j < s.length && !isWs(s[j]) && s[j] !== ',' && s[j] !== '}' && s[j] !== ']') j++;
    return j < s.length ? j : -1;
  }
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '"') {
      j = stringEnd(s, j) - 1;
      if (j < 0) return -1;
    } else if (s[j] === '{' || s[j] === '[') depth++;
    else if ((s[j] === '}' || s[j] === ']') && --depth === 0) return j + 1;
  }
  return -1;
}

function parseString(literal: string): string | undefined {
  try {
    const v: unknown = JSON.parse(literal);
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

/** A number literal as a request id: the SDK accepts integers only. */
function integerId(literal: string): number | undefined {
  const n = Number(literal);
  return Number.isSafeInteger(n) ? n : undefined;
}

/** The id at `s[i]`, if it is complete: a string, or a number followed by a delimiter. */
function idValueAt(s: string, i: number): RequestId | undefined {
  if (s[i] === '"') {
    const end = stringEnd(s, i);
    return end === -1 ? undefined : parseString(s.slice(i, end));
  }
  NUMBER_AT.lastIndex = i;
  const m = NUMBER_AT.exec(s);
  const next = m ? s[i + m[0].length] : undefined;
  if (!m || next === undefined || !(isWs(next) || next === ',' || next === '}')) return undefined;
  return integerId(m[0]);
}

/** Top-level `id` of the object `head` begins, walking its members in order. */
export function idFromHead(head: string): RequestId | undefined {
  let i = skipWs(head, 0);
  if (head[i] !== '{') return undefined;
  i++;
  for (;;) {
    i = skipWs(head, i);
    if (head[i] !== '"') return undefined;
    const keyEnd = stringEnd(head, i);
    if (keyEnd === -1) return undefined;
    const key = parseString(head.slice(i, keyEnd));
    i = skipWs(head, keyEnd);
    if (head[i] !== ':') return undefined;
    i = skipWs(head, i + 1);
    if (key === 'id') return idValueAt(head, i);
    const end = valueEnd(head, i);
    if (end === -1) return undefined;
    i = skipWs(head, end);
    if (head[i] !== ',') return undefined;
    i++;
  }
}

/** True when the `"` at `s[i]` is not escaped. */
function unescapedQuote(s: string, i: number): boolean {
  let slashes = 0;
  while (s[i - 1 - slashes] === '\\') slashes++;
  return slashes % 2 === 0;
}

/**
 * Top-level `id` when it is the last member of the object `tail` ends. The
 * line's final `}` closes the top-level object, so a `"id": value` directly
 * before it (after a `,` or `{`) is that object's own member.
 */
export function idFromTail(tail: string): RequestId | undefined {
  let j = skipWsBack(tail, tail.length - 1);
  if (tail[j] !== '}') return undefined;
  j = skipWsBack(tail, j - 1);
  let id: RequestId | undefined;
  let start: number;
  if (tail[j] === '"') {
    start = j - 1;
    while (start >= 0 && !(tail[start] === '"' && unescapedQuote(tail, start))) start--;
    if (start < 0) return undefined;
    id = parseString(tail.slice(start, j + 1));
  } else {
    const m = NUMBER_AT_END.exec(tail.slice(0, j + 1));
    if (!m) return undefined;
    start = j + 1 - m[0].length;
    id = integerId(m[0]);
  }
  j = skipWsBack(tail, start - 1);
  if (tail[j] !== ':') return undefined;
  j = skipWsBack(tail, j - 1);
  if (tail.slice(j - 3, j + 1) !== '"id"') return undefined;
  const before = tail[skipWsBack(tail, j - 4)];
  return before === ',' || before === '{' ? id : undefined;
}

/** The request id from an oversize line's head and tail windows, if either shows it. */
export function findRequestId(head: Buffer, tail: Buffer): RequestId | undefined {
  return idFromHead(head.toString('utf8')) ?? idFromTail(tail.toString('utf8'));
}
