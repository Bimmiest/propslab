// ---------------------------------------------------------------------------
// runStages.ts
// The names `runPipeline` reports its stages under (`PipelineOptions.onStage`),
// in the order a batch run reaches them. These are the pipeline's own stage
// names, as its "Processor … failed" diagnostics give them — not the help
// drawer's descriptive stages, which are pipelineStages.ts. Kept apart from
// pipeline.ts so a consumer can read the list without loading the pipeline.
// ---------------------------------------------------------------------------

export const RUN_STAGES = [
  // Index time.
  'LINE_BREAKER',
  'TRUNCATE',
  'Timestamp',
  'ROUTE_EVENTS_OLDER_THAN',
  'INDEXED_EXTRACTIONS',
  'SEDCMD',
  'TRANSFORMS',
  'CLONE_SOURCETYPE',
  'ANNOTATE_PUNCT',
  // Search time, run once over the whole batch...
  'EXTRACT',
  'REPORT',
  'KV_MODE',
  'FIELDALIAS',
  'EVAL',
  'SEDCMD attribution',
  // ...or, with `perEventPipeline`, all of the above once per event, reported
  // as this one stage over every event.
  'search time per event',
] as const;

export type RunStage = (typeof RUN_STAGES)[number];
