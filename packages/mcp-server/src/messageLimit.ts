/**
 * A per-message size bound on the stdio transport's input, enforced before
 * anything is parsed (#349).
 *
 * The SDK's `StdioServerTransport` reads newline-delimited JSON: it buffers
 * stdin until a `\n`, then `JSON.parse`s the whole line and validates it —
 * all on the server's main thread, outside every worker's heap limit. The
 * zod bounds in tools.ts and `confTooLarge` only see a message after that, so
 * on their own they bound what reaches a worker, not what the server itself
 * holds. (Recent SDK releases also cap their read buffer, at 10 MB — but by
 * closing the transport, which takes the whole server down with one oversized
 * line; older ones in this package's semver range have no cap at all.)
 *
 * `MessageSizeLimiter` sits between stdin and the transport. It passes a line
 * through once its `\n` arrives, and a line that grows past the limit is
 * dropped: what was held of it is released at once, the rest is skipped up to
 * the next `\n` without being kept, and the server answers with a JSON-RPC
 * error. Lines after it are processed as normal.
 */
import { Transform, type Readable, type TransformCallback, type Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

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

/**
 * Transform stream that forwards complete `\n`-terminated lines of at most
 * `maxBytes` and drops longer ones, calling `onOversize` once per dropped line
 * as soon as it crosses the limit.
 *
 * Memory is bounded by `maxBytes` plus one input chunk: a line is held only
 * until it is complete or too long, and a dropped line's remainder is counted
 * past, never stored. A trailing line with no `\n` when input ends is
 * discarded — the SDK would never parse it either.
 */
export class MessageSizeLimiter extends Transform {
  /** The current line so far, while it is within the limit. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  /** True from the moment the current line crosses the limit until its `\n`. */
  private discarding = false;

  constructor(
    private readonly maxBytes: number,
    private readonly onOversize: (maxBytes: number) => void,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(NEWLINE, start);
      const end = newline === -1 ? chunk.length : newline;
      if (!this.discarding) {
        if (this.pendingBytes + (end - start) > this.maxBytes) {
          this.pending = [];
          this.pendingBytes = 0;
          this.discarding = true;
          this.onOversize(this.maxBytes);
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
      }
      if (newline === -1) break;
      this.discarding = false;
      start = newline + 1;
    }
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.pending = [];
    this.pendingBytes = 0;
    callback();
  }
}

/**
 * The response to a dropped message. JSON-RPC 2.0 says a response whose
 * request id could not be determined carries `"id": null`; the SDK's message
 * schema models that as an absent id instead (and rejects `null`), so it is
 * left out — which also lets an SDK-based client parse the error and report
 * it rather than fail on it. Finding the real id would mean parsing the very
 * message being refused for its size.
 */
export function oversizeMessageError(maxBytes: number): JSONRPCMessage {
  return {
    jsonrpc: '2.0',
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
  const limiter = new MessageSizeLimiter(maxBytes, (limit) => {
    transport.send(oversizeMessageError(limit)).catch(() => {});
  });
  // pipe() forwards data and end, not errors; the transport listens for
  // errors on the stream it reads, which is now the limiter.
  stdin.on('error', (err) => limiter.destroy(err));
  stdin.pipe(limiter);
  const transport = new StdioServerTransport(limiter, stdout);
  return transport;
}
