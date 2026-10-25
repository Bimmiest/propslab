// ---------------------------------------------------------------------------
// pipelineWorker.test.ts
// The pipeline worker skips a request a newer one has superseded (#562), as
// the regex and timestamp workers do.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PipelineWorkerRequest, PipelineWorkerResponse } from '../pipelineWorker';
import { stubWasmFetch } from '../../test/wasmFetch';

const request = (id: number, rawData: string): PipelineWorkerRequest => ({
  id,
  rawData,
  metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
  propsConfText: '',
  transformsConfText: '',
  latestOnly: true,
});

describe('pipelineWorker', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('runs only the newest of the latest-only requests queued together, and times the run', async () => {
    const posted: unknown[] = [];
    const fakeSelf: {
      onmessage: ((e: MessageEvent<PipelineWorkerRequest>) => void) | null;
      postMessage: (m: unknown) => void;
    } = { onmessage: null, postMessage: (m) => posted.push(m) };
    vi.stubGlobal('self', fakeSelf);
    stubWasmFetch();
    vi.resetModules();
    await import('../pipelineWorker');
    const send = (r: PipelineWorkerRequest) => fakeSelf.onmessage!({ data: r } as MessageEvent<PipelineWorkerRequest>);

    // All three arrive before the engine has loaded, so they drain together.
    send(request(1, 'first'));
    send(request(2, 'second'));
    send(request(3, 'third'));
    await vi.waitFor(() => expect(posted).toHaveLength(4));

    expect(posted.slice(0, 3)).toEqual([{ type: 'ready' }, { id: 1, skipped: true }, { id: 2, skipped: true }]);
    const answer = posted[3] as PipelineWorkerResponse;
    expect(answer.id).toBe(3);
    expect(answer.result?.result.events.map((e) => e._raw)).toEqual(['third']);
    expect(answer.runMs).toBeGreaterThanOrEqual(0);
  });
});
