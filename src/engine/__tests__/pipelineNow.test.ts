// ---------------------------------------------------------------------------
// pipelineNow.test.ts
// `PipelineOptions.now` stands in for the wall clock everywhere the simulation
// reads the current time (#293). Each case asserts one consumer, so a stage
// that quietly goes back to `Date.now()` fails here by name rather than as a
// fidelity fixture going red years from now.
//
// Doc-derived: the bounds are props.conf.spec's MAX_DAYS_AGO / MAX_DAYS_HENCE
// defaults, and now()/time() are the eval functions of the same names.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const opts = (now: number) => ({ perEventPipeline: false, now });

describe('PipelineOptions.now (#293)', () => {
  const EVENT_MS = Date.parse('2026-01-15T10:00:00Z');
  const PROPS = '[st]\nSHOULD_LINEMERGE = false\nTIME_FORMAT = %Y-%m-%dT%H:%M:%SZ\n';
  const RAW = '2026-01-15T10:00:00Z hello';

  it('measures MAX_DAYS_AGO from the injected now, not the wall clock', () => {
    // A day after the event: well inside the 2000-day default.
    const near = runPipeline(RAW, META, PROPS, '', opts(EVENT_MS + 86_400_000));
    expect(near.result.events[0]?._time?.getTime()).toBe(EVENT_MS);

    // 3000 days after: the timestamp is rejected and the event falls back to
    // index time — which is the injected now as well.
    const far = EVENT_MS + 3000 * 86_400_000;
    const late = runPipeline(RAW, META, PROPS, '', opts(far));
    expect(late.result.events[0]?._time?.getTime()).toBe(far);
  });

  it('measures MAX_DAYS_HENCE from the injected now', () => {
    const { result } = runPipeline(RAW, META, PROPS, '', opts(EVENT_MS - 10 * 86_400_000));
    expect(result.events[0]?._time?.getTime()).not.toBe(EVENT_MS);
  });

  it('gives a yearless TIME_FORMAT the year of the injected now', () => {
    const props = '[st]\nSHOULD_LINEMERGE = false\nTIME_FORMAT = %b %d %H:%M:%S\n';
    const now = Date.parse('2019-06-01T00:00:00Z');
    const { result } = runPipeline('Mar 03 04:05:06 host msg', META, props, '', opts(now));
    expect(result.events[0]?._time?.getUTCFullYear()).toBe(2019);
  });

  it('is what EVAL now() and time() return', () => {
    const props = '[st]\nSHOULD_LINEMERGE = false\nEVAL-a = now()\nEVAL-b = time()\n';
    const { result } = runPipeline('x', META, props, '', opts(1_700_000_000_500));
    expect(result.events[0]?.fields.a).toBe('1700000000');
    expect(result.events[0]?.fields.b).toBe('1700000000');
  });

  it('is what INGEST_EVAL now() returns', () => {
    const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-t = stamp\n';
    const transforms = '[stamp]\nINGEST_EVAL = stamped=now()\n';
    const { result } = runPipeline('x', META, props, transforms, opts(1_700_000_000_000));
    expect(result.events[0]?.fields.stamped).toBe('1700000000');
  });
});
