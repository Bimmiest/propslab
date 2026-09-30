/**
 * How far a sandbox run got, readable by the server while the worker is still
 * busy — which is exactly when it matters: a run that has to be stopped. A
 * worker stuck in a pattern cannot answer a message, so the worker writes its
 * progress into a SharedArrayBuffer as it goes, and the server reads it when
 * the budget runs out and says where the run was (tools.ts).
 *
 * The whole state is one 32-bit word written with a single atomic store, so
 * the server never reads a stage from one write beside an event count from
 * another: phase in bits 28–29, stage in bits 23–27 (its index in
 * `RUN_STAGES` plus one, zero for none), events in bits 0–22.
 * See docs/adr/0015-mcp-timeouts-start-on-ready-and-report-progress.md.
 */
import { RUN_STAGES, type RunStage } from '../../../src/engine/runStages';

/**
 * - `starting`: loading, before the worker posted `ready`.
 * - `parsing`: reading the conf (for simulate, also listing its regex
 *   directives), before any directive runs.
 * - `running`: the pipeline (simulate, with `stage`), the lint (validate), or
 *   stanza resolution (explain).
 * - `finishing`: the run is done and the response is being shaped.
 */
export const RUN_PHASES = ['starting', 'parsing', 'running', 'finishing'] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export interface RunProgress {
  phase: RunPhase;
  /** The pipeline stage in progress; simulate only. */
  stage?: RunStage;
  /** Events that stage was given (none for LINE_BREAKER, which makes them). */
  events?: number;
}

const PHASE_SHIFT = 28;
const STAGE_SHIFT = 23;
const STAGE_MASK = 0x1f;
/** Counts above this read as this: some eight million, far more events than a run holds. */
export const MAX_REPORTED_EVENTS = (1 << STAGE_SHIFT) - 1;

const RUNNING = RUN_PHASES.indexOf('running');

export function createProgressBuffer(): SharedArrayBuffer {
  return new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
}

export interface ProgressWriter {
  phase: (phase: RunPhase) => void;
  /** A pipeline stage has started; implies the `running` phase. Fits `PipelineOptions.onStage`. */
  stage: (stage: RunStage, events: number) => void;
}

export function progressWriter(buffer: SharedArrayBuffer): ProgressWriter {
  const word = new Int32Array(buffer);
  const write = (phase: number, stage: number, events: number) => {
    Atomics.store(
      word,
      0,
      (phase << PHASE_SHIFT) | (stage << STAGE_SHIFT) | Math.min(events, MAX_REPORTED_EVENTS),
    );
  };
  return {
    phase: (phase) => {
      write(RUN_PHASES.indexOf(phase), 0, 0);
    },
    stage: (stage, events) => {
      write(RUNNING, RUN_STAGES.indexOf(stage) + 1, events);
    },
  };
}

export function readProgress(buffer: SharedArrayBuffer): RunProgress {
  const value = Atomics.load(new Int32Array(buffer), 0);
  const phase = RUN_PHASES[value >>> PHASE_SHIFT] ?? 'starting';
  const stage = RUN_STAGES[((value >>> STAGE_SHIFT) & STAGE_MASK) - 1];
  return stage === undefined
    ? { phase }
    : { phase, stage, events: value & MAX_REPORTED_EVENTS };
}
