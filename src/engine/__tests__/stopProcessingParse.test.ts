// ---------------------------------------------------------------------------
// stopProcessingParse.test.ts
// STOP_PROCESSING_IF is parsed once per run, not once per event (#561).
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../pipeline';

const parses = vi.hoisted(() => ({ count: 0 }));
vi.mock('../processors/eval/parser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../processors/eval/parser')>();
  return {
    ...actual,
    parseExpression: (expr: string) => {
      parses.count++;
      return actual.parseExpression(expr);
    },
  };
});

describe('STOP_PROCESSING_IF', () => {
  it('parses its expression once for a run, however many events reach it', () => {
    const raw = Array.from({ length: 50 }, (_, i) => `event ${i}`).join('\n');
    const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-a = stop\nKV_MODE = none';
    const transforms = '[stop]\nINGEST_EVAL = n=1\nSTOP_PROCESSING_IF = like(_raw, "event 4%")';
    parses.count = 0;
    const { result } = runPipeline(
      raw,
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      props,
      transforms,
      {
        perEventPipeline: false,
      },
    );
    expect(result.events).toHaveLength(50);
    // One parse for STOP_PROCESSING_IF and one for INGEST_EVAL's assignment.
    expect(parses.count).toBe(2);
  });
});
