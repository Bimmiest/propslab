/**
 * A per-message size bound on the stdio transport's input, enforced before
 * anything is parsed.
 *
 * The SDK's `StdioServerTransport` reads newline-delimited JSON: it buffers
 * stdin until a `\n`, then `JSON.parse`s the whole line and validates it —
 * all on the server's main thread, outside every worker's heap limit. The
 * zod bounds in tools.ts and `confTooLarge` only see a message after that, so
 * on their own they bound what reaches a worker, not what the server itself
 * holds. (The SDK also caps its read buffer, at 10 MB in every release this
 * package's range admits — but by closing the transport, which takes the whole
 * server down with one oversized line.)
 *
 * `MessageSizeLimiter` sits between stdin and the transport. It passes a line
 * through once its `\n` arrives, and a line that grows past the limit is
 * dropped: what was held of it is released at once, the rest is skipped up to
 * the next `\n` without being kept, and the server answers with a JSON-RPC
 * error naming the request's id when a bounded scan of the line's ends finds
 * it (requestId.ts). Lines after it are processed as normal.
 */
import { Transform, type Readable, type TransformCallback, type Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { findRequestId, ID_SCAN_BYTES } from './requestId';

/**
 * Largest single JSON-RPC message the server will parse, in bytes of UTF-8 on
 * the wire (the line's `\n` not counted; a CRLF line's `\r` is).
 *
 * Sized from the schemas' own bounds: the largest call they admit is
 * `simulate` with a 1M-character sample and 2M characters of conf
 * (`MAX_TOTAL_CONF_CHARS`) — 3M characters. JSON escaping at most doubles
 * ASCII (`\n`, `\t`, `"` and the backslashes every regex is full of each
 * become two bytes), so 6 MB plus framing carries any all-ASCII call the
 * schemas accept; 8 MiB leaves room for non-ASCII text on top (up to three
 * bytes per character in UTF-8). A call beyond it could only ever be one the
 * schemas refuse or one of a rare shape — megabytes of control characters,
 * of `\u`-escaped non-ASCII, or of CJK text at the character limit — and the
 * error says to send less.
 *
 * It also stays below the 10 MB at which the SDK's own read buffer (where it
 * has one) closes the transport, so a line under this limit never trips that.
 * What the main thread holds for one message is then this line, once in the
 * limiter and once in the SDK's buffer, plus its parse.
 */
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/** JSON-RPC "Invalid Request". */
const INVALID_REQUEST = -32600;

/** The first `n` bytes of `bufs`, copied so no input chunk is retained. */
function firstBytes(bufs: Buffer[], n: number): Buffer {
  // concat copies only up to the length it is given (and zero-fills past the
  // end of the input, which the min rules out).
  const total = bufs.reduce((sum, b) => sum + b.length, 0);
  return Buffer.concat(bufs, Math.min(n, total));
}

/** The last `n` bytes of `bufs`, copied likewise. */
function lastBytes(bufs: Buffer[], n: number): Buffer {
  const out: Buffer[] = [];
  let left = n;
  for (const buf of bufs.toReversed()) {
    if (left <= 0) break;
    const part = buf.subarray(Math.max(0, buf.length - left));
    out.unshift(part);
    left -= part.length;
  }
  return Buffer.concat(out);
}

/**
 * Transform stream that forwards complete `\n`-terminated lines of at most
 * `maxBytes` and drops longer ones, calling `onOversize` once per dropped line
 * when its `\n` arrives (or input ends), with the request id if a scan of the
 * line's first and last `ID_SCAN_BYTES` finds one.
 *
 * Memory is bounded by `maxBytes` plus one input chunk: a line is held only
 * until it is complete or too long, and of a dropped line only those two
 * windows are kept — the rest is counted past, never stored. A trailing line
 * with no `\n` when input ends is discarded — the SDK would never parse it
 * either.
 */
export class MessageSizeLimiter extends Transform {
  /** The current line so far, while it is within the limit. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** True from the moment the current line crosses the limit until its `\n`. */
  private discarding = false;
  /** A dropped line's first and last bytes, for `findRequestId`. */
  private head: Buffer = Buffer.alloc(0);
  private tail: Buffer = Buffer.alloc(0);
  private readonly maxBytes: number;
  private readonly onOversize: (maxBytes: number, id: RequestId | undefined) => void;

  constructor(
    maxBytes: number,
    onOversize: (maxBytes: number, id: RequestId | undefined) => void,
  ) {
    super();
    this.maxBytes = maxBytes;
    this.onOversize = onOversize;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.discarding) {
        if (this.pendingBytes + (end - start) > this.maxBytes) {
          const held = [...this.pending, chunk.subarray(start, end)];
          this.head = firstBytes(held, ID_SCAN_BYTES);
          this.tail = lastBytes(held, ID_SCAN_BYTES);
          this.pending = [];
          this.pendingBytes = 0;
          this.discarding = true;
        } else if (newline === -1) {
          this.pending.push(chunk.subarray(start));
          this.pendingBytes += end - start;
        } else {
          // One push per complete line, so the SDK's read buffer never holds
          // more than one message's worth at a time.
          this.push(Buffer.concat([...this.pending, chunk.subarray(start, newline + 1)]));
          this.pending = [];
          this.pendingBytes = 0;
        }
      } else {
        this.tail = lastBytes([this.tail, chunk.subarray(start, end)], ID_SCAN_BYTES);
      }
      if (newline === -1) break;
      this.endDiscard();
      start = newline + 1;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pending = [];
    this.pendingBytes = 0;
    this.endDiscard();
    callback();
  }

  /** Reports the line being dropped, if any, once its end is known. */
  private endDiscard(): void {
    if (!this.discarding) return;
    this.discarding = false;
    const id = findRequestId(this.head, this.tail);
    this.head = this.tail = Buffer.alloc(0);
    this.onOversize(this.maxBytes, id);
  }
}

/**
 * The response to a dropped message, carrying the request's `id` when the
 * limiter recovered it, so the client can settle that call at once. Without
 * one, JSON-RPC 2.0 says `"id": null`; the SDK's message schema models that
 * as an absent id instead (and rejects `null`), so it is left out — which
 * still lets an SDK-based client parse the error and report it.
 */
export function oversizeMessageError(maxBytes: number, id?: RequestId): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    error: {
      code: INVALID_REQUEST,
      message:
        `Message exceeds ${maxBytes} bytes and was discarded unparsed; ` +
        'send smaller conf and sample text.',
      data: { error: 'message_too_large', max_message_bytes: maxBytes },
    },
  };
}

/**
 * A `StdioServerTransport` whose input goes through `MessageSizeLimiter`. The
 * streams are parameters so tests can drive the real transport over pipes.
 */
export function createStdioTransport(
  stdin: Readable = process.stdin,
  stdout: Writable = process.stdout,
  maxBytes: number = MAX_MESSAGE_BYTES,
): StdioServerTransport {
  const limiter = new MessageSizeLimiter(maxBytes, (limit, id) => {
    transport.send(oversizeMessageError(limit, id)).catch(() => {});
  });
  // pipe() forwards data and end, not errors; the transport listens for
  // errors on the stream it reads, which is now the limiter.
  stdin.on('error', (err) => limiter.destroy(err));
  stdin.pipe(limiter);
  const transport = new StdioServerTransport(limiter, stdout);
  // The SDK transport never closes on stdin EOF by itself, and only a close
  // makes the server abort every in-flight handler's signal: without it a
  // client that disconnects leaves running workers to their budget and queued
  // calls to start theirs, keeping the process alive for nobody.
  limiter.once('end', () => void transport.close());
  return transport;
}
