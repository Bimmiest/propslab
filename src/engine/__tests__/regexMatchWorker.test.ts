// ---------------------------------------------------------------------------
// regexMatchWorker.test.ts
// A throw inside matching must come back as a response, not kill the worker
// (#436), as in timestampMatchWorker.test.ts.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RegexMatchRequest, RegexMatchResponse } from '../regexMatchWorker';
import { stubWasmFetch } from '../../test/wasmFetch';

// A plain variable rather than a `vi.fn`: vitest fails a test whose mock
// throws, even when the code under test catches it.
let matchImpl: (pattern: string) => unknown = () => [];
vi.mock('../regexMatch', () => ({ matchInputs: (pattern: string): unknown => matchImpl(pattern) }));

describe('regexMatchWorker', () => {
  beforeEach(() => {
    matchImpl = () => [];
  });
  afterEach(() => vi.unstubAllGlobals());

  it('answers each request queued during load, even after one throws (#436)', async () => {
    matchImpl = (pattern) => {
      if (pattern === 'bad') throw new Error('matcher exploded');
      return [null];
    };
    const posted: unknown[] = [];
    const fakeSelf: { onmessage: ((e: MessageEvent<RegexMatchRequest>) => void) | null; postMessage: (m: unknown) => void } = {
      onmessage: null,
      postMessage: (m) => posted.push(m),
    };
    vi.stubGlobal('self', fakeSelf);
    stubWasmFetch();
    vi.resetModules();
    await import('../regexMatchWorker');
    const send = (request: RegexMatchRequest) => fakeSelf.onmessage!({ data: request } as MessageEvent<RegexMatchRequest>);

    // All three arrive before the engine has loaded, so they drain together.
    send({ id: 1, pattern: 'a', inputs: ['x'] });
    send({ id: 2, pattern: 'bad', inputs: ['x'] });
    send({ id: 3, pattern: 'c', inputs: ['x'] });
    await vi.waitFor(() => expect(posted).toHaveLength(4));
    const responses: RegexMatchResponse[] = [
      { id: 1, results: [null] },
      { id: 2, results: null, error: 'matcher exploded' },
      { id: 3, results: [null] },
    ];
    expect(posted).toEqual([{ type: 'ready' }, ...responses]);

    // And once up, a throw is answered the same way.
    expect(() => send({ id: 4, pattern: 'bad', inputs: [] })).not.toThrow();
    expect(posted.at(-1)).toEqual({ id: 4, results: null, error: 'matcher exploded' });
  });
});
