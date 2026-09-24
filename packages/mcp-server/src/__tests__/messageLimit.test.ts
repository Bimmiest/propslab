import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import {
  createStdioTransport,
  MAX_MESSAGE_BYTES,
  MessageSizeLimiter,
  oversizeMessageError,
} from '../messageLimit';

/**
 * The per-message bound on stdin (#349): oversized lines are dropped before
 * the SDK buffers or parses them, the server answers with an error, and the
 * lines after keep working.
 */
const LAUNCHER = fileURLToPath(new URL('../../dist/index.js', import.meta.url));

/** Feeds `chunks` through a limiter; resolves to the lines it let through. */
async function limit(maxBytes: number, chunks: (string | Buffer)[]) {
  const oversize: number[] = [];
  const limiter = new MessageSizeLimiter(maxBytes, (n) => oversize.push(n));
  const out: Buffer[] = [];
  limiter.on('data', (b: Buffer) => out.push(b));
  const done = new Promise((r) => limiter.on('end', r));
  for (const c of chunks) limiter.write(c);
  limiter.end();
  await done;
  return { passed: out.map((b) => b.toString('utf8')), oversize: oversize.length };
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
    }
    limiter.destroy();
  });
});

describe('size-limited stdio transport', () => {
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
    expect(written.join('')).toBe(`${JSON.stringify(oversizeMessageError(64))}\n`);
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

      expect(responses[1]).toEqual(oversizeMessageError(MAX_MESSAGE_BYTES));
      expect(responses[2]).toMatchObject({ id: 3, result: { tools: expect.any(Array) } });
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  }, 30_000);
});
