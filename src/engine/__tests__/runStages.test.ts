import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { RUN_STAGES, type RunStage } from '../runStages';
import type { EventMetadata } from '../types';

// Not a Splunk behaviour: `onStage` is the engine's own progress hook, so
// these pin its contract (names, order, event counts) rather than any
// documented Splunk output.

const META: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
const RAW = 'a=1 secret\nb=2 secret\nc=3 secret\n';
// A SEDCMD makes the final attribution stage replay extraction, which must not
// report stages of its own.
const PROPS = '[st]\nSHOULD_LINEMERGE = false\nSEDCMD-mask = s/secret/xxx/g\nEXTRACT-a = (?<k>\\w)=';

function stagesOf(perEventPipeline: boolean): [RunStage, number][] {
  const seen: [RunStage, number][] = [];
  runPipeline(RAW, META, PROPS, '', {
    perEventPipeline,
    onStage: (stage, events) => seen.push([stage, events]),
  });
  return seen;
}

describe('PipelineOptions.onStage', () => {
  it('reports every batch stage once, in RUN_STAGES order, with the events it is given', () => {
    const seen = stagesOf(false);
    expect(seen.map(([stage]) => stage)).toEqual(RUN_STAGES.filter((s) => s !== 'search time per event'));
    // Line breaking is given no events — it makes them.
    expect(seen[0]).toEqual(['LINE_BREAKER', 0]);
    expect(seen.slice(1).every(([, events]) => events === 3)).toBe(true);
  });

  it('reports per-event search time as one stage over every event', () => {
    const seen = stagesOf(true);
    const indexTime = RUN_STAGES.slice(0, RUN_STAGES.indexOf('EXTRACT'));
    expect(seen.map(([stage]) => stage)).toEqual([...indexTime, 'search time per event']);
    expect(seen.at(-1)).toEqual(['search time per event', 3]);
  });

  it('is optional', () => {
    const { result } = runPipeline(RAW, META, PROPS, '', { perEventPipeline: false });
    expect(result.events.map((e) => e.fields['k'])).toEqual(['a', 'b', 'c']);
  });

  it('reports nothing for an empty sample, which runs no stage', () => {
    const seen: string[] = [];
    runPipeline('  \n', META, PROPS, '', { perEventPipeline: false, onStage: (s) => seen.push(s) });
    expect(seen).toEqual([]);
  });
});
