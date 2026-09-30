import { describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { createStdioTransport, MAX_MESSAGE_BYTES, MessageSizeLimiter, oversizeMessageError } from '../messageLimit';
import { ID_SCAN_BYTES } from '../requestId';

/**
 * The per-message bound on stdin: oversized lines are dropped before
 * the SDK buffers or parses them, the server answers with an error, and the
 * lines after keep working.
 */
const LAUNCHER = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** Feeds `chunks` through a limiter; resolves to the lines it let through. */
async function limit(maxBytes: number, chunks: (string | Buffer)[]) {
  const oversize: number[] = [];
  const ids: unknown[] = [];
  const limiter = new MessageSizeLimiter(maxBytes, (n, id) => {
    oversize.push(n);
    ids.push(id);
  });
  const out: Buffer[] = [];
  limiter.on('data', (b: Buffer) => out.push(b));
  const done = new Promise((r) => limiter.on('end', r));
  for (const c of chunks) limiter.write(c);
  limiter.end();
  await done;
  return { passed: out.map((b) => b.toString('utf8')), oversize: oversize.length, ids };
}

describe('MessageSizeLimiter', () => {
  it('passes lines within the limit through unchanged, one line per chunk', async () => {
    const { passed, oversize } = await limit(10, ['ab\ncd', 'ef\n\nghij\n']);
    expect(passed).toEqual(['ab\n', 'cdef\n', '\n', 'ghij\n']);
    expect(oversize).toBe(0);
  });

  it('drops an oversize line, reports it once, and keeps the lines after it', async () => {
    const { passed, oversize } = await limit(4, ['ok\n', 'x'.repeat(20), '\nnext\n']);
    expect(passed).toEqual(['ok\n', 'next\n']);
    expect(oversize).toBe(1);
  });

  it('counts a line across chunk boundaries', async () => {
    // Five bytes split three ways is over a limit of four; four is not.
    const over = await limit(4, ['ab', 'c', 'de\n', 'ok\n']);
    expect(over.passed).toEqual(['ok\n']);
    expect(over.oversize).toBe(1);
    const exact = await limit(4, ['ab', 'c', 'd\n']);
    expect(exact.passed).toEqual(['abcd\n']);
    expect(exact.oversize).toBe(0);
  });

  it('counts a line that starts mid-chunk from where it starts', async () => {
    // "bbbb" follows a newline at offset 2, then four more bytes: eight in
    // all, within ten.
    const { passed, oversize } = await limit(10, ['a\nbbbb', 'bbbb\n']);
    expect(passed).toEqual(['a\n', 'bbbbbbbb\n']);
    expect(oversize).toBe(0);
  });

  it('keeps discarding across chunks until the newline, then resumes mid-chunk', async () => {
    const { passed, oversize } = await limit(4, ['toolong', 'still', 'more\nfine\nx']);
    expect(passed).toEqual(['fine\n']);
    expect(oversize).toBe(1);
  });

  it('reports each oversize line separately, including two in one chunk', async () => {
    const { passed, oversize } = await limit(3, ['aaaaa\nbbbbb\nok\n']);
    expect(passed).toEqual(['ok\n']);
    expect(oversize).toBe(2);
  });

  it('passes CRLF lines through and counts the \\r toward the limit', async () => {
    const { passed, oversize } = await limit(4, ['abc\r\n', 'abcd\r', '\nok\r\n']);
    expect(passed).toEqual(['abc\r\n', 'ok\r\n']);
    expect(oversize).toBe(1);
  });

  it('counts bytes, not characters', async () => {
    // Two characters, six bytes of UTF-8.
    const { passed, oversize } = await limit(4, [Buffer.from('€€\n'), 'ok\n']);
    expect(passed).toEqual(['ok\n']);
    expect(oversize).toBe(1);
  });

  it('discards an unterminated trailing line at end of input', async () => {
    const { passed } = await limit(10, ['ok\npartial']);
    expect(passed).toEqual(['ok\n']);
  });

  it('reports the id from the head or tail of a dropped line', async () => {
    const pad = 'x'.repeat(20_000);
    const { ids } = await limit(100, [
      `{"id":"first","params":{"raw":"${pad}"}}\n`,
      // Split mid-line so the tail spans chunks, as the SDK client's lines end.
      `{"method":"tools/call","params":{"raw":"${pad}`,
      `"},"jsonrpc":"2.0","id":42}\r\n`,
      `{"params":{"raw":"${pad}"},"id":{"x":1}}\n`,
    ]);
    expect(ids).toEqual(['first', 42, undefined]);
  });

  it('still reports a dropped line cut off by the end of input', async () => {
    const { ids, oversize } = await limit(10, ['{"id":9,"pad":"xxxxxxxxxxxxxxx']);
    expect(oversize).toBe(1);
    expect(ids).toEqual([9]);
  });

  it('never holds more than the limit plus a chunk while discarding', () => {
    // A 64 MiB line in 64 KiB chunks against a 1 MiB limit: were the limiter
    // accumulating it, the pending buffer list would reach the full size.
    const limiter = new MessageSizeLimiter(1024 * 1024, () => {});
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    for (let i = 0; i < 1024; i++) {
      limiter.write(chunk);
      const { pending } = limiter as unknown as { pending: Buffer[] };
      const held = pending.reduce((n, b) => n + b.length, 0);
      expect(held).toBeLessThanOrEqual(1024 * 1024);
      const { head, tail } = limiter as unknown as { head: Buffer; tail: Buffer };
      expect(head.length + tail.length).toBeLessThanOrEqual(2 * ID_SCAN_BYTES);
    }
    limiter.destroy();
  });
});

describe('oversizeMessageError', () => {
  it('names the request when its id is known, and leaves `id` out entirely when not', () => {
    const error = {
      code: -32600,
      message: 'Message exceeds 64 bytes and was discarded unparsed; send smaller conf and sample text.',
      data: { error: 'message_too_large', max_message_bytes: 64 },
    };
    expect(oversizeMessageError(64, 'req-1')).toStrictEqual({ jsonrpc: '2.0', id: 'req-1', error });
    // Absent, not `id: undefined`: the SDK's schema rejects a present null id.
    expect(oversizeMessageError(64)).toStrictEqual({ jsonrpc: '2.0', error });
  });
});

describe('size-limited stdio transport', () => {
  it("passes a stdin error on to the transport's onerror", async () => {
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdin, new PassThrough(), 64);
    const errors: Error[] = [];
    transport.onerror = (e) => errors.push(e);
    await transport.start();
    const boom = new Error('stdin failed');
    stdin.emit('error', boom);
    await new Promise((r) => setImmediate(r));
    expect(errors).toEqual([boom]);
    await transport.close();
  });

  it('closes the transport when stdin fails (#490)', async () => {
    // A stdin error destroys the limiter, which emits `close` but never
    // `end`: listening for `end` alone left in-flight calls running and
    // queued ones starting for a client that could no longer read them.
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdin, new PassThrough(), 64);
    let closed = 0;
    transport.onclose = () => closed++;
    transport.onerror = () => {};
    await transport.start();
    stdin.emit('error', new Error('stdin failed'));
    await vi.waitFor(() => expect(closed).toBe(1));
  });

  it('closes the transport when stdin ends', async () => {
    const stdin = new PassThrough();
    const transport = createStdioTransport(stdin, new PassThrough(), 64);
    let closed = false;
    transport.onclose = () => (closed = true);
    await transport.start();
    stdin.end();
    await vi.waitFor(() => expect(closed).toBe(true));
  });

  it('answers an oversize message with an error and processes the next one', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = createStdioTransport(stdin, stdout, 64);
    const received: JSONRPCMessage[] = [];
    const errors: Error[] = [];
    transport.onmessage = (m) => received.push(m);
    transport.onerror = (e) => errors.push(e);
    await transport.start();

    const written: string[] = [];
    stdout.on('data', (b: Buffer) => written.push(b.toString('utf8')));

    const ping = (id: number) => `${JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })}\n`;
    stdin.write(ping(1));
    // Invalid JSON too: were any of it parsed, onerror would fire.
    stdin.write(`{"jsonrpc":"2.0","id":2,"method":"ping","params":{"pad":"${'x'.repeat(100)}`);
    stdin.write('"}}\n');
    stdin.write(ping(3));
    await new Promise((r) => setImmediate(r));

    expect(received).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 3, method: 'ping' },
    ]);
    expect(errors).toEqual([]);
    expect(written.join('')).toBe(`${JSON.stringify(oversizeMessageError(64, 2))}\n`);
    await transport.close();
  });

  it('runs through the built server: an oversize call is refused, the server survives', async () => {
    const child = spawn(process.execPath, [LAUNCHER], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      const responses: Record<string, unknown>[] = [];
      let buffered = '';
      let notify = () => {};
      child.stdout.on('data', (b: Buffer) => {
        buffered += b.toString('utf8');
        let nl: number;
        while ((nl = buffered.indexOf('\n')) !== -1) {
          responses.push(JSON.parse(buffered.slice(0, nl)));
          buffered = buffered.slice(nl + 1);
          notify();
        }
      });
      const waitFor = (n: number) =>
        new Promise<void>((resolve) => {
          notify = () => {
            if (responses.length >= n) resolve();
          };
          notify();
        });
      const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);

      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'propslab-limit-test', version: '0.0.0' },
        },
      });
      await waitFor(1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });

      // Past both this server's limit and the 10 MB at which the SDK's own
      // read buffer would close the transport: the server must answer and
      // stay up rather than go down with the line.
      const raw = 'x'.repeat(12 * 1024 * 1024);
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'simulate', arguments: { raw, sourcetype: 'st' } },
      });
      send({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
      await waitFor(3);

      expect(responses[1]).toEqual(oversizeMessageError(MAX_MESSAGE_BYTES, 2));
      expect(responses[2]).toMatchObject({ id: 3, result: { tools: expect.any(Array) } });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  }, 30_000);
});

describe('oversize call through the SDK client', () => {
  it('rejects callTool promptly with the error instead of waiting out a timeout', async () => {
    // The SDK client writes a request's id after its params (#402), so this
    // exercises the tail scan end to end.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCHER],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'propslab-limit-sdk', version: '0.0.0' });
    await client.connect(transport);
    try {
      const err: unknown = await client
        .callTool(
          { name: 'simulate', arguments: { raw: 'x'.repeat(MAX_MESSAGE_BYTES), sourcetype: 'st' } },
          undefined,
          { timeout: 120_000 },
        )
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(McpError);
      expect(err).toMatchObject({ code: -32600, data: { error: 'message_too_large' } });
      // "Promptly" is not a stopwatch (#507): the request's timeout (120 s) is
      // longer than this test's own (30 s), so a server that left the call to
      // time out would fail the test rather than get here.
      // The server is still up and answering.
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  }, 30_000);
});
