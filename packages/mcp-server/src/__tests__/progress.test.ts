import { describe, expect, it } from 'vitest';
import { RUN_STAGES } from '../../../../src/engine/runStages';
import {
  createProgressBuffer,
  MAX_REPORTED_EVENTS,
  progressWriter,
  readProgress,
  RUN_PHASES,
} from '../progress';

describe('run progress (#488)', () => {
  it('reads as starting until the worker writes', () => {
    expect(readProgress(createProgressBuffer())).toEqual({ phase: 'starting' });
  });

  it('round-trips every phase, and every stage with its event count', () => {
    const buffer = createProgressBuffer();
    const writer = progressWriter(buffer);
    for (const phase of RUN_PHASES) {
      writer.phase(phase);
      expect(readProgress(buffer)).toEqual({ phase });
    }
    for (const [i, stage] of RUN_STAGES.entries()) {
      writer.stage(stage, i * 1_000);
      expect(readProgress(buffer)).toEqual({ phase: 'running', stage, events: i * 1_000 });
    }
    // A phase after a stage clears the stage.
    writer.phase('finishing');
    expect(readProgress(buffer)).toEqual({ phase: 'finishing' });
  });

  it('caps the event count rather than overflowing into the stage', () => {
    const buffer = createProgressBuffer();
    progressWriter(buffer).stage('EVAL', MAX_REPORTED_EVENTS + 5);
    expect(readProgress(buffer)).toEqual({ phase: 'running', stage: 'EVAL', events: MAX_REPORTED_EVENTS });
  });

  it('has room for every stage', () => {
    // Five bits hold the stage index plus one.
    expect(RUN_STAGES.length).toBeLessThan(32);
  });
});
