// ---------------------------------------------------------------------------
// workerRequestQueue.test.ts
// The live testers' worker side (#496): inputs arrive once and requests name
// them, and a request superseded by a newer one already waiting is skipped
// rather than run, so a slow pattern's answer does not wait on every pattern
// typed past.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import {
  createRequestQueue,
  isWorkerInputsMessage,
  isWorkerReadyMessage,
  isWorkerSkippedResponse,
  type QueuedRequest,
  type WorkerInputsMessage,
} from '../workerProtocol';

interface Req extends QueuedRequest {
  pattern: string;
  inputs?: string[];
}

function setup() {
  const runs: { id: number; inputs: string[] | undefined }[] = [];
  const skipped: number[] = [];
  const deferred: (() => void)[] = [];
  const rethrown: unknown[] = [];
  let failOn: string | null = null;
  const serve = createRequestQueue<string[], Req>({
    run: (request, inputs) => {
      if (request.pattern === failOn) throw new Error('boom');
      runs.push({ id: request.id, inputs: request.inputs ?? inputs });
    },
    skip: (request) => skipped.push(request.id),
    defer: (drain) => deferred.push(drain),
    rethrow: (err) => rethrown.push(err),
  });
  const flush = () => {
    while (deferred.length > 0) deferred.shift()!();
  };
  return { serve, runs, skipped, deferred, rethrown, flush, failOn: (p: string) => { failOn = p; } };
}

const inputs = (inputsId: number, values: string[]): WorkerInputsMessage<string[]> => ({ type: 'inputs', inputsId, inputs: values });

describe('createRequestQueue', () => {
  it('runs a plain request at once, with its own inputs', () => {
    const { serve, runs, deferred } = setup();
    serve({ id: 1, pattern: 'a', inputs: ['x'] });
    expect(runs).toEqual([{ id: 1, inputs: ['x'] }]);
    expect(deferred).toHaveLength(0);
  });

  it('runs a request against the inputs it names', () => {
    const { serve, runs } = setup();
    serve(inputs(1, ['a', 'b']));
    serve({ id: 1, pattern: 'p', inputsId: 1 });
    serve(inputs(2, ['c']));
    serve({ id: 2, pattern: 'p', inputsId: 2 });
    expect(runs).toEqual([{ id: 1, inputs: ['a', 'b'] }, { id: 2, inputs: ['c'] }]);
  });

  it('gives a request naming inputs it does not have none', () => {
    const { serve, runs } = setup();
    serve(inputs(2, ['c']));
    serve({ id: 1, pattern: 'p', inputsId: 1 });
    expect(runs).toEqual([{ id: 1, inputs: undefined }]);
  });

  it('skips a latest-only request when a newer one is already waiting', () => {
    const { serve, runs, skipped, flush } = setup();
    serve(inputs(1, ['a']));
    serve({ id: 1, pattern: 'p1', inputsId: 1, latestOnly: true });
    serve({ id: 2, pattern: 'p2', inputsId: 1, latestOnly: true });
    serve(inputs(2, ['b']));
    serve({ id: 3, pattern: 'p3', inputsId: 2, latestOnly: true });
    // Nothing runs until the messages already delivered have all arrived.
    expect(runs).toEqual([]);
    flush();
    expect(skipped).toEqual([1, 2]);
    expect(runs).toEqual([{ id: 3, inputs: ['b'] }]);
  });

  it('runs the newest latest-only request even alone', () => {
    const { serve, runs, skipped, flush } = setup();
    serve({ id: 1, pattern: 'p', inputs: ['a'], latestOnly: true });
    flush();
    expect(skipped).toEqual([]);
    expect(runs).toEqual([{ id: 1, inputs: ['a'] }]);
  });

  it('never skips a request that is not latest-only, and keeps arrival order behind a wait', () => {
    const { serve, runs, skipped, flush } = setup();
    serve({ id: 1, pattern: 'p1', inputs: ['a'], latestOnly: true });
    // Queued behind the waiting one, not run ahead of it.
    serve({ id: 2, pattern: 'hover', inputs: ['h'] });
    serve({ id: 3, pattern: 'p3', inputs: ['c'], latestOnly: true });
    expect(runs).toEqual([]);
    flush();
    expect(skipped).toEqual([1]);
    expect(runs.map((r) => r.id)).toEqual([2, 3]);
  });

  it('keeps serving the requests behind one that throws, and reports the throw', () => {
    const { serve, runs, rethrown, flush, failOn } = setup();
    failOn('bad');
    serve({ id: 1, pattern: 'bad', inputs: ['a'] });
    expect(rethrown).toHaveLength(1);
    serve({ id: 2, pattern: 'bad', inputs: ['a'], latestOnly: true });
    flush();
    serve({ id: 3, pattern: 'good', inputs: ['a'] });
    expect(rethrown).toHaveLength(2);
    expect(runs.map((r) => r.id)).toEqual([3]);
  });

  it('gives a request naming inputs when none were ever sent none', () => {
    const { serve, runs } = setup();
    serve({ id: 1, pattern: 'p', inputsId: 1 });
    expect(runs).toEqual([{ id: 1, inputs: undefined }]);
  });

  it('is superseded only by a newer latest-only request, not by anything else queued behind it', () => {
    const { serve, runs, skipped, flush } = setup();
    serve({ id: 1, pattern: 'p1', inputs: ['a'], latestOnly: true });
    serve({ id: 2, pattern: 'hover', inputs: ['h'] });
    serve(inputs(1, ['b']));
    flush();
    expect(skipped).toEqual([]);
    expect(runs.map((r) => r.id)).toEqual([1, 2]);
  });

  it('schedules again for the next burst once a drain has run', () => {
    const { serve, runs, deferred, flush } = setup();
    serve({ id: 1, pattern: 'p1', inputs: ['a'], latestOnly: true });
    flush();
    serve({ id: 2, pattern: 'p2', inputs: ['a'], latestOnly: true });
    expect(deferred).toHaveLength(1);
    flush();
    expect(runs.map((r) => r.id)).toEqual([1, 2]);
  });

  it('schedules one drain for a burst', () => {
    const { serve, deferred } = setup();
    for (let id = 1; id <= 5; id++) serve({ id, pattern: 'p', inputs: [], latestOnly: true });
    expect(deferred).toHaveLength(1);
  });
});

describe('the inputs and skipped messages are told apart from everything else', () => {
  it.each([
    [{ type: 'inputs', inputsId: 1, inputs: [] }, true, false],
    [{ id: 1, skipped: true }, false, true],
    [{ type: 'ready' }, false, false],
    [{ id: 1, results: null }, false, false],
    [null, false, false],
    [undefined, false, false],
    ['inputs', false, false],
  ])('%j', (message, isInputs, isSkipped) => {
    expect(isWorkerInputsMessage(message)).toBe(isInputs);
    expect(isWorkerSkippedResponse(message)).toBe(isSkipped);
    expect(isWorkerReadyMessage(message)).toBe(JSON.stringify(message) === '{"type":"ready"}');
  });
});

describe('the regex worker entry serves inputs sent ahead and skips superseded patterns', () => {
  it('answers each request once, skipping the ones a newer pattern replaced', async () => {
    const { stubWasmFetch } = await import('../../test/wasmFetch');
    const posted: unknown[] = [];
    const fakeSelf: { onmessage: ((e: MessageEvent) => void) | null; postMessage: (m: unknown) => void } = {
      onmessage: null,
      postMessage: (m) => posted.push(m),
    };
    vi.stubGlobal('self', fakeSelf);
    stubWasmFetch();
    vi.resetModules();
    await import('../regexMatchWorker');
    const send = (data: unknown) => fakeSelf.onmessage!({ data } as MessageEvent);

    send(inputs(1, ['a1', 'b']));
    send({ id: 1, pattern: '\\d', inputsId: 1, latestOnly: true });
    send({ id: 2, pattern: '[a-z]\\d', inputsId: 1, latestOnly: true });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[0]).toEqual({ type: 'ready' });
    expect(posted[1]).toEqual({ id: 1, skipped: true });
    expect(posted[2]).toMatchObject({ id: 2 });
    expect((posted[2] as { results: unknown[] }).results).toHaveLength(2);

    // A request with no inputs to its name is answered, as an error.
    send({ id: 3, pattern: 'x', inputsId: 9 });
    expect(posted[3]).toEqual({ id: 3, results: null, error: 'No inputs to match against' });
    vi.unstubAllGlobals();
  });
});
