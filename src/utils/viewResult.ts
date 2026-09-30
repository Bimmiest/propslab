import type { ProcessingResult, ProcessingStep, SplunkEvent } from '../engine/types';
import { computeFieldStats, type FieldStats } from './fieldStats';

/**
 * What the preview receives from a pipeline run, as opposed to what
 * `runPipeline` returns.
 *
 * The full result crosses the worker boundary by structured clone, and at 20k
 * events the per-event traces were most of that cost: 120k step objects,
 * each carrying prose and before/after snapshots that no view reads per
 * event. So the worker sends each event's trace without them, interned: events
 * whose steps match share one array, which structured clone sends once. The
 * one view that needs the prose, the Pipeline tab, gets it summarised in the
 * worker (`stepSummaries`), across every event. So does what several views
 * need about the fields as a whole (`fieldStats`): the distinct names, how
 * many events have each, and which hold JSON containers.
 */

/** A trace step without its prose and snapshots. */
export type TraceStep = Omit<ProcessingStep, 'description' | 'inputSnapshot' | 'outputSnapshot'>;

/** An event as the preview holds it. A `SplunkEvent` is one too. */
export interface ViewEvent extends Omit<SplunkEvent, 'processingTrace'> {
  /** Shared between events with the same steps: never mutate it. */
  processingTrace: readonly TraceStep[];
}

/** One row of the Pipeline tab: a processor, summarised across every event it ran on. */
export interface StepSummary {
  processor: string;
  phase: 'index-time' | 'search-time';
  /** Distinct per-event descriptions, in first-seen order. */
  descriptions: string[];
  /** The one line shown for the step. */
  summaryText: string;
  eventsAffected: number;
  totalEvents: number;
  fieldsAdded: string[];
  /** Fields this step left extractable but devalued (e.g. a mask rule). */
  fieldsModified: string[];
  /** Fields this step made unextractable by deleting the text they anchor on. */
  fieldsRemoved: string[];
}

export interface ViewResult extends Omit<ProcessingResult, 'events' | 'processingSteps'> {
  events: ViewEvent[];
  /** The Pipeline tab's rows, in first-seen order. */
  stepSummaries: StepSummary[];
  /** The fields across every event, counted once here rather than by each view. */
  fieldStats: FieldStats;
}

// Strip a trailing "(…)" detail (e.g. "(lines 1-1)") so per-event variants of an
// index-time step collapse to one representative summary line.
const stripDetail = (d: string) => d.replace(/\s*\([^)]*\)\s*$/, '');

interface StepAccumulator {
  processor: string;
  phase: StepSummary['phase'];
  /** The first description seen, which heads the summary when the rest differ in more than detail. */
  firstDescription: string;
  descriptions: Set<string>;
  fieldsAdded: Set<string>;
  fieldsModified: Set<string>;
  fieldsRemoved: Set<string>;
  eventsAffected: number;
}

/**
 * Group every event's steps by processor (not processor + description), so
 * index-time steps with per-event descriptions collapse into one row, as the
 * search-time ones do. Sets keep first-seen order and avoid the quadratic
 * `includes` a distinct description per event would cost.
 */
export function summarizeSteps(events: readonly SplunkEvent[]): StepSummary[] {
  const byProcessor = new Map<string, StepAccumulator>();
  for (const event of events) {
    const seen = new Set<StepAccumulator>();
    for (const step of event.processingTrace) {
      let entry = byProcessor.get(step.processor);
      if (!entry) {
        entry = {
          processor: step.processor,
          phase: step.phase,
          firstDescription: step.description,
          descriptions: new Set(),
          fieldsAdded: new Set(),
          fieldsModified: new Set(),
          fieldsRemoved: new Set(),
          eventsAffected: 0,
        };
        byProcessor.set(step.processor, entry);
      }
      if (!seen.has(entry)) {
        seen.add(entry);
        entry.eventsAffected++;
      }
      entry.descriptions.add(step.description);
      for (const f of step.fieldsAdded ?? []) entry.fieldsAdded.add(f);
      for (const f of step.fieldsModified ?? []) entry.fieldsModified.add(f);
      for (const f of step.fieldsRemoved ?? []) entry.fieldsRemoved.add(f);
    }
  }
  return Array.from(byProcessor.values(), (entry) => {
    const descriptions = [...entry.descriptions];
    const reps = new Set(descriptions.map(stripDetail));
    return {
      processor: entry.processor,
      phase: entry.phase,
      descriptions,
      summaryText: reps.size === 1 ? stripDetail(entry.firstDescription) : entry.firstDescription,
      eventsAffected: entry.eventsAffected,
      totalEvents: events.length,
      fieldsAdded: [...entry.fieldsAdded],
      fieldsModified: [...entry.fieldsModified],
      fieldsRemoved: [...entry.fieldsRemoved],
    };
  });
}

const SEP = '\u0000';
const list = (values: readonly string[] | undefined) => (values ? values.join('\u0001') : '');
const json = (value: unknown) => (value === undefined ? '' : JSON.stringify(value));

/** Identifies a step by everything `TraceStep` keeps. */
function stepKey(step: ProcessingStep): string {
  return [
    step.processor,
    step.phase,
    step.timeSource ?? '',
    list(step.fieldsAdded),
    list(step.fieldsModified),
    list(step.fieldsRemoved),
    json(step.fieldAliases),
    json(step.evalExpressions),
    json(step.metadataChanges),
    json(step.truncation),
  ].join(SEP);
}

function toTraceStep(step: ProcessingStep): TraceStep {
  const { description: _description, inputSnapshot: _input, outputSnapshot: _output, ...rest } = step;
  return rest;
}

/**
 * The result the preview holds: each event's trace reduced to `TraceStep`s
 * and interned, its metadata interned, `timestampText` dropped where it is
 * `_raw` (which is what readers fall back to), and the flat
 * `processingSteps` replaced by the Pipeline tab's summary, and the field
 * statistics added.
 */
export function toViewResult(result: ProcessingResult): ViewResult {
  const traces = new Map<string, readonly TraceStep[]>();
  const metadata = new Map<string, SplunkEvent['metadata']>();
  const events = result.events.map((event): ViewEvent => {
    const traceKey = event.processingTrace.map(stepKey).join('\u0002');
    let trace = traces.get(traceKey);
    if (!trace) {
      trace = event.processingTrace.map(toTraceStep);
      traces.set(traceKey, trace);
    }
    const m = event.metadata;
    const metaKey = [m.index, m.host, m.source, m.sourcetype].join(SEP);
    let meta = metadata.get(metaKey);
    if (!meta) {
      meta = m;
      metadata.set(metaKey, meta);
    }
    const { timestampText, ...rest } = event;
    return {
      ...rest,
      ...(timestampText !== undefined && timestampText !== event._raw ? { timestampText } : {}),
      metadata: meta,
      processingTrace: trace,
    };
  });
  return {
    originalRaw: result.originalRaw,
    eventCount: result.eventCount,
    inputMetadata: result.inputMetadata,
    events,
    stepSummaries: summarizeSteps(result.events),
    fieldStats: computeFieldStats(result.events),
  };
}
