import type { ConfInput, EventMetadata, ParsedConf, PipelineOptions, ProcessingResult, ValidationDiagnostic, ConfDirective, SplunkEvent } from './types';
import { parseConf } from './parser/confParser';
import { matchStanzas, mergeDirectives, resolveStanzasForEvent, getRenamedSourcetype } from './parser/stanzaMatcher';
import { breakLines } from './processors/lineBreaker';
import { extractTimestamps } from './processors/timestampExtractor';
import { truncateEvents } from './processors/truncator';
import { routeEventsByAge } from './processors/routeByAge';
import { applyIndexedExtractions } from './processors/indexedExtractions';
import { annotatePunct } from './processors/punctAnnotator';
import { applySedCommands } from './processors/sedCmd';
import { applyTransforms } from './processors/transformsProcessor';
import { applyCloneIndexTime } from './processors/cloneSourcetype';
import { extractFields } from './processors/fieldExtractor';
import { applyKvMode } from './processors/kvMode';
import { applyFieldAliases } from './processors/fieldAlias';
import { applyEvalExpressions } from './processors/evalProcessor';
import { attributeRawMutations } from './processors/rawMutationAttribution';
import { lintConfigs, lintMatchedDirectives } from './configLint';
import { createRunContext, withDiagnostics, type RunContext, type RunLimits } from './runContext';

type Stage = (batch: SplunkEvent[], ctx: RunContext) => SplunkEvent[];

const errorText = (err: unknown) => (err instanceof Error ? err.message : 'Unknown error');

/**
 * Run one stage so that a throw degrades to a diagnostic rather than failing
 * the run.
 *
 * A `per-event` stage's output for an event depends on that event alone, so
 * when the batch throws it is re-run one event at a time and only the events
 * that still throw pass through unchanged. The retry reports through a view
 * that drops what the failed attempt already said, and the run's ledger is
 * shared, so it does not repeat a warning.
 *
 * A `batch` stage reads across events (line breaking, the previous event's
 * `_time`, a CSV header row), and a retry one event at a time would be a
 * different computation, so it falls back to `events` unchanged as a whole.
 * See docs/adr/0001-stage-failures-degrade-to-diagnostics.md.
 */
function safeProcessor(
  name: string,
  events: SplunkEvent[],
  fn: Stage,
  ctx: RunContext,
  file: ValidationDiagnostic['file'] = 'props.conf',
  shape: 'per-event' | 'batch' = 'per-event',
): SplunkEvent[] {
  const { diagnostics } = ctx;
  const start = diagnostics.list.length;
  try {
    return fn(events, ctx);
  } catch (err) {
    if (shape === 'batch' || events.length <= 1) {
      diagnostics.push({ level: 'error', message: `Processor "${name}" failed: ${errorText(err)}`, file });
      return events; // Return unmodified events on failure
    }
  }

  const retry = withDiagnostics(ctx, diagnostics.deduplicating(diagnostics.list.slice(start)));
  const failures: { line: number; error: string }[] = [];
  const out = events.flatMap((event) => {
    try {
      return fn([event], retry);
    } catch (err) {
      failures.push({ line: event.lineNumbers.start, error: errorText(err) });
      return [event];
    }
  });
  const first = failures[0];
  if (first !== undefined) {
    const n = failures.length;
    diagnostics.push({
      level: 'error',
      file: 'raw',
      line: first.line,
      message: `Processor "${name}" failed on ${n} event${n === 1 ? '' : 's'}, which ${n === 1 ? 'passes' : 'pass'} through it unchanged (${first.error}).`,
    });
  }
  return out;
}

/**
 * Guard against excessively large inputs (`RunLimits.maxRawChars`). Cut back
 * to the last line break inside the cap rather than at an arbitrary character:
 * slicing mid-line hands the pipeline a half-event, which then mis-breaks,
 * mis-timestamps, or extracts a truncated final field — a corrupt result
 * presented as a real one. Losing the partial trailing line is the honest
 * outcome, and the warning says so. A line whose newline falls just past the
 * cap is complete, and is kept.
 */
function capInput(rawData: string, limits: RunLimits, diagnostics: ValidationDiagnostic[]): string {
  const max = limits.maxRawChars;
  if (rawData.length <= max) return rawData;
  const capped = rawData.slice(0, max);
  const lastBreak = rawData[max] === '\n' ? max : capped.lastIndexOf('\n');
  const truncatedRaw = lastBreak > 0 ? capped.slice(0, lastBreak) : capped;
  diagnostics.push({
    level: 'warning',
    message:
      `Input truncated to ${truncatedRaw.length.toLocaleString()} characters for performance ` +
      `(original: ${rawData.length.toLocaleString()}). Truncation is aligned to the last complete ` +
      'line, so the final partial event is dropped rather than processed half-formed.',
    file: 'props.conf',
  });
  return truncatedRaw;
}

/** The run context, plus what its stages share once the conf files are parsed and matched. */
interface PipelineRun {
  propsConf: ParsedConf;
  transformsConf: ParsedConf;
  /** Index-time directives: the stanzas matching the (assigned) metadata, merged. */
  directives: ConfDirective[];
  /** Search-time directives: `directives`, unless `rename` points elsewhere. */
  searchTimeDirectives: ConfDirective[];
  /** The metadata the events were broken with: the caller's, after any input-time assignment. */
  effectiveMetadata: EventMetadata;
  ctx: RunContext;
}

/**
 * Match stanzas to metadata (by precedence) and merge directives (deduped by
 * key, first wins). `resolveStanzasForEvent` rather than `matchStanzas`
 * because a `[source::…]` or `[host::…]` stanza can assign the sourcetype,
 * which decides what else matches — so it has to be resolved before anything
 * reads the result.
 */
function resolveDirectives(
  propsConf: ParsedConf,
  metadata: EventMetadata,
  diagnostics: ValidationDiagnostic[],
): Pick<PipelineRun, 'directives' | 'searchTimeDirectives' | 'effectiveMetadata'> {
  const resolved = resolveStanzasForEvent(propsConf.stanzas, metadata);
  const matchedStanzas = resolved.stanzas;
  const effectiveMetadata = resolved.metadata;
  const directives = mergeDirectives(matchedStanzas);

  if (resolved.assignedSourcetype) {
    diagnostics.push({
      level: 'info',
      message:
        `sourcetype assigned at input: "${metadata.sourcetype}" → "${resolved.assignedSourcetype}". ` +
        'Stanzas were resolved against the assigned sourcetype, so props for it apply from here on.',
      file: 'props.conf',
      directiveKey: 'sourcetype',
    });
  }

  // `rename` is search-time only: the event stays indexed as its original
  // sourcetype, and search-time config comes from the target stanza alone.
  // See docs/adr/0002-input-time-sourcetype-and-rename.md.
  const renamedSourcetype = getRenamedSourcetype(matchedStanzas);
  if (!renamedSourcetype) return { directives, searchTimeDirectives: directives, effectiveMetadata };

  const searchTimeStanzas = matchStanzas(propsConf.stanzas, { ...effectiveMetadata, sourcetype: renamedSourcetype });
  diagnostics.push({
    level: 'info',
    message:
      `rename: search-time processing uses sourcetype "${renamedSourcetype}" instead of ` +
      `"${effectiveMetadata.sourcetype}". Events stay indexed as "${effectiveMetadata.sourcetype}", and ` +
      `search-time settings come from "${renamedSourcetype}" alone — EXTRACT, REPORT, FIELDALIAS and ` +
      'EVAL on the original stanza no longer apply.',
    file: 'props.conf',
    directiveKey: 'rename',
  });
  return { directives, searchTimeDirectives: mergeDirectives(searchTimeStanzas), effectiveMetadata };
}

/** The index-time stages, in Splunk's order. */
function runIndexTime(rawData: string, run: PipelineRun): SplunkEvent[] {
  const { directives, propsConf, transformsConf, ctx } = run;
  // Step 1-2: Line breaking and merging. breakLines alone decides the
  // SHOULD_LINEMERGE default INDEXED_EXTRACTIONS implies (see
  // docs/adr/0008-structured-formats-default-line-merging-off.md). With nothing
  // broken there are no events to carry forward, so the fallback is empty.
  let events = safeProcessor('LINE_BREAKER', [], (_, c) => breakLines(rawData, directives, run.effectiveMetadata, c), ctx, 'props.conf', 'batch');

  // Step 3: Truncation
  events = safeProcessor('TRUNCATE', events, (batch, c) => truncateEvents(batch, directives, c), ctx);

  // Step 4: Timestamp extraction. Batch-shaped: an event with no timestamp
  // inherits the previous event's.
  events = safeProcessor('Timestamp', events, (batch, c) => extractTimestamps(batch, directives, c), ctx, 'props.conf', 'batch');

  // Step 4b: ROUTE_EVENTS_OLDER_THAN — the spec runs the age test "after
  // timestamp extraction", so it reads the extracted _time, before any
  // index-time transform can rewrite it.
  events = safeProcessor('ROUTE_EVENTS_OLDER_THAN', events, (batch, c) => routeEventsByAge(batch, directives, c), ctx);

  // Step 5: Indexed extractions. Batch-shaped: CSV's header row names the
  // fields of every row after it. The XML modes catch per event themselves.
  events = safeProcessor('INDEXED_EXTRACTIONS', events, (batch, c) => applyIndexedExtractions(batch, directives, c), ctx, 'props.conf', 'batch');

  // Step 6: SEDCMD
  events = safeProcessor('SEDCMD', events, (batch, c) => applySedCommands(batch, directives, c), ctx);

  // Step 7: Index-time TRANSFORMS — regex transforms, DEST_KEY routing, and
  // INGEST_EVAL / STOP_PROCESSING_IF stanzas are all applied here, interleaved
  // in TRANSFORMS-<class> list order, then every RULESET-<class> after them
  // (only when a props.conf stanza references them).
  // This stage and the clone pass, which calls applyTransforms once per clone,
  // report against the run's one warning ledger.
  events = safeProcessor('TRANSFORMS', events, (batch, c) => applyTransforms(batch, directives, transformsConf, 'index-time', c), ctx, 'transforms.conf');

  // Step 7b: CLONE_SOURCETYPE copies get the SEDCMD and TRANSFORMS of the
  // sourcetype they were cloned to.
  events = safeProcessor('CLONE_SOURCETYPE', events, (batch, c) => applyCloneIndexTime(batch, propsConf, transformsConf, c), ctx, 'transforms.conf');

  // Step 8: ANNOTATE_PUNCT — the annotation processor runs after regex
  // replacement, so the punct signature reflects _raw as indexed (post-SEDCMD,
  // post-transforms), not as ingested.
  return safeProcessor('ANNOTATE_PUNCT', events, (batch, c) => annotatePunct(batch, directives, c), ctx);
}

/**
 * The search-time stages over `events`, all read from `directives`. Splunk's
 * search-time order is EXTRACT → REPORT → automatic KV (KV_MODE) → FIELDALIAS → EVAL.
 */
function runSearchTimeStages(
  events: SplunkEvent[],
  directives: ConfDirective[],
  run: PipelineRun,
  ctx: RunContext,
): SplunkEvent[] {
  const { transformsConf } = run;
  // Step 8: EXTRACT (inline field extraction)
  let ev = safeProcessor('EXTRACT', events, (batch, c) => extractFields(batch, directives, c), ctx);
  // Step 9: Search-time REPORT transforms (run BEFORE automatic KV — Splunk's
  // documented order is inline EXTRACT → REPORT field transforms → automatic KV).
  ev = safeProcessor('REPORT', ev, (batch, c) => applyTransforms(batch, directives, transformsConf, 'search-time', c), ctx, 'transforms.conf');
  // Step 10: KV_MODE (automatic key-value extraction)
  ev = safeProcessor('KV_MODE', ev, (batch, c) => applyKvMode(batch, directives, c), ctx);
  // Step 11: FIELDALIAS
  ev = safeProcessor('FIELDALIAS', ev, (batch, c) => applyFieldAliases(batch, directives, c), ctx);
  // Step 12: EVAL (calculated fields)
  ev = safeProcessor('EVAL', ev, (batch, c) => applyEvalExpressions(batch, directives, c), ctx);
  // Step 13: attribute index-time `_raw` rewrites (SEDCMD, DEST_KEY = _raw) to
  // the fields whose extracted value they changed or destroyed. Runs last
  // because it replays search-time extraction against the pre-rewrite text.
  // See docs/adr/0011-raw-rewrites-attributed-by-replay.md.
  return safeProcessor('SEDCMD attribution', ev, (batch, c) => attributeRawMutations(batch, () => directives, transformsConf, c), ctx);
}

const metaKey = (m: EventMetadata) => `${m.sourcetype}|${m.host}|${m.source}`;

/**
 * Per-event search time: resolve each event's directives from its own
 * metadata, re-matching stanzas for events whose metadata changed at index time.
 */
function runSearchTimePerEvent(events: SplunkEvent[], run: PipelineRun, originalMetaKey: string): SplunkEvent[] {
  const { propsConf } = run;
  const directivesCache = new Map<string, ConfDirective[]>();
  directivesCache.set(originalMetaKey, run.searchTimeDirectives);

  const eventDirectives = events.map((event) => {
    const key = metaKey(event.metadata);
    const cached = directivesCache.get(key);
    if (cached !== undefined) return cached;
    // Metadata that differs from the batch's was rewritten at index time
    // (DEST_KEY = MetaData:*, INGEST_EVAL) or given to a CLONE_SOURCETYPE
    // copy. The input-time `sourcetype =` assignment already ran, before
    // either: applying it again would put back the sourcetype the rewrite
    // replaced. So match the metadata as it stands, as the clone pass does,
    // then take `rename` for the search-time set.
    const matched = matchStanzas(propsConf.stanzas, event.metadata);
    const renamed = getRenamedSourcetype(matched);
    const stanzas = renamed
      ? matchStanzas(propsConf.stanzas, { ...event.metadata, sourcetype: renamed })
      : matched;
    const resolvedDirs = mergeDirectives(stanzas);
    directivesCache.set(key, resolvedDirs);
    return resolvedDirs;
  });

  // Each processor is called once PER EVENT here, so a diagnostic describing a
  // *config* problem (an invalid KV_MODE regex, an eval parse failure, a REPORT
  // whose REGEX will not compile) would be pushed once per event: 500 events,
  // 500 identical warnings. Report through a view that keeps only the distinct
  // entries. Genuinely per-event diagnostics carry their own line number, so
  // they differ and all survive.
  const ctx = withDiagnostics(run.ctx, run.ctx.diagnostics.deduplicating());
  return events.flatMap((event, i) => {
    const evDirs = eventDirectives[i] ?? [];
    return runSearchTimeStages([traceRematch(event, originalMetaKey, evDirs.length)], evDirs, run, ctx);
  });
}

/**
 * Annotate an event whose metadata was rewritten so the trace shows the
 * re-match. A CLONE_SOURCETYPE copy differs because it was cloned to a new
 * sourcetype, not because a DEST_KEY = MetaData:* transform rewrote it, so its
 * step says that instead.
 */
function traceRematch(event: SplunkEvent, originalMetaKey: string, directiveCount: number): SplunkEvent {
  if (metaKey(event.metadata) === originalMetaKey) return event;
  const why = event.clonedFrom !== undefined
    ? `Cloned by CLONE_SOURCETYPE ("${event.clonedFrom}" → "${event.metadata.sourcetype}")`
    : `Metadata rewritten at index-time (sourcetype → "${event.metadata.sourcetype}")`;
  return {
    ...event,
    processingTrace: [
      ...event.processingTrace,
      {
        processor: 'StanzaRematch',
        phase: 'search-time' as const,
        description: `${why}; stanzas re-matched for search-time using ${directiveCount} directives`,
      },
    ],
  };
}

/**
 * Warn if any event had its routing metadata rewritten at index-time — search-time directives
 * are still resolved from the original metadata in batch mode.
 *
 * CLONE_SOURCETYPE copies are counted apart: they differ because they were
 * cloned to a new sourcetype, and blaming a DEST_KEY = MetaData:* transform
 * for them would send the reader looking for one that does not exist. Their
 * index-time SEDCMD and TRANSFORMS already come from the new sourcetype,
 * but search-time here does not, so they get their own warning.
 */
function warnBatchMetadataRewrites(events: SplunkEvent[], originalMetaKey: string, diagnostics: ValidationDiagnostic[]): void {
  const rewroteMetadata = events.some((e) => e.clonedFrom === undefined && metaKey(e.metadata) !== originalMetaKey);
  const clonedSourcetypes = [
    ...new Set(
      events
        .filter((e) => e.clonedFrom !== undefined && metaKey(e.metadata) !== originalMetaKey)
        .map((e) => e.metadata.sourcetype),
    ),
  ];
  if (clonedSourcetypes.length > 0) {
    diagnostics.push({
      level: 'warning',
      message:
        `CLONE_SOURCETYPE copied events to sourcetype ${clonedSourcetypes.map((st) => `"${st}"`).join(', ')}. ` +
        'Their index-time SEDCMD and TRANSFORMS come from the new sourcetype, but in batch mode search-time processors ' +
        '(EXTRACT, REPORT, FIELDALIAS, EVAL) still use the original stanza match for the copies. ' +
        'Enable "Re-match stanzas after metadata rewrites" in Settings to simulate this correctly.',
      file: 'transforms.conf',
    });
  }
  if (rewroteMetadata) {
    diagnostics.push({
      level: 'warning',
      message:
        'One or more events had their sourcetype/host/source rewritten at index-time by a DEST_KEY = MetaData:* transform or an INGEST_EVAL assignment. ' +
        'In batch mode, search-time processors (EXTRACT, REPORT, FIELDALIAS, EVAL) still use the original stanza match and will not apply directives from the new sourcetype. ' +
        'Enable "Re-match stanzas after metadata rewrites" in Settings to simulate this correctly.',
      file: 'transforms.conf',
    });
  }
}

/**
 * Run the full index-time + search-time simulation over `rawData`.
 *
 * Each conf argument is either the text of a single file or an ordered list of
 * layers, lowest precedence first — `[{ layer: 'default', text }, { layer:
 * 'local', text }]` — for a caller reading an app off disk, where `local/`
 * overrides `default/` per attribute. `parseConf` merges them; every directive
 * and every diagnostic derived from one then names the layer it came from.
 * See docs/adr/0012-layered-conf-input.md.
 */
export function runPipeline(
  rawData: string,
  metadata: EventMetadata,
  propsConfInput: ConfInput,
  transformsConfInput: ConfInput,
  options?: PipelineOptions
): { result: ProcessingResult; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = [];
  const ctx = createRunContext({
    // Read once, so every stage of one run agrees on what "now" is.
    now: options?.now ?? Date.now(),
    // Defaults to true: the browser reads these offsets to highlight extracted
    // fields, so declining them has to be an explicit choice by a caller that does not.
    captureOffsets: options?.captureOffsets ?? true,
    diagnostics,
    limits: options?.limits,
  });

  if (!rawData.trim()) {
    return {
      result: { events: [], originalRaw: rawData, eventCount: 0, processingSteps: [], inputMetadata: metadata },
      diagnostics,
    };
  }

  const truncatedRaw = capInput(rawData, ctx.limits, diagnostics);

  // 1. Parse configurations
  const propsConf = parseConf(propsConfInput, 'props.conf');
  const transformsConf = parseConf(transformsConfInput, 'transforms.conf');
  diagnostics.push(...propsConf.errors, ...transformsConf.errors);

  // Config-level lint: everything here reads the conf files alone, not which
  // stanzas match this event, and none of it changes what the pipeline does.
  lintConfigs(propsConf, transformsConf, diagnostics);

  const run: PipelineRun = {
    propsConf,
    transformsConf,
    ...resolveDirectives(propsConf, metadata, diagnostics),
    ctx,
  };
  lintMatchedDirectives(run.directives, diagnostics, run.searchTimeDirectives);

  let events = runIndexTime(truncatedRaw, run);

  // Compared against the metadata the events were BROKEN with, not the
  // caller's: an input-time `sourcetype =` assignment is not an index-time
  // rewrite. See docs/adr/0002-input-time-sourcetype-and-rename.md.
  const originalMetaKey = metaKey(run.effectiveMetadata);
  if (options?.perEventPipeline) {
    events = runSearchTimePerEvent(events, run, originalMetaKey);
  } else {
    warnBatchMetadataRewrites(events, originalMetaKey, diagnostics);
    events = runSearchTimeStages(events, run.searchTimeDirectives, run, ctx);
  }

  // Belt and braces: a processor that threw leaves `rawMutations` in place, and
  // the transient record must never reach a caller.
  events = events.map((e) => {
    if (!e.rawMutations) return e;
    const { rawMutations: _rawMutations, ...rest } = e;
    return rest;
  });

  return {
    result: {
      events,
      originalRaw: truncatedRaw,
      eventCount: events.length,
      processingSteps: events.flatMap((e) => e.processingTrace),
      // The metadata the events were broken with — the caller's, after any
      // input-time `sourcetype =` assignment, so the UI does not badge every
      // event of an assigned sourcetype as "Metadata Modified".
      inputMetadata: run.effectiveMetadata,
    },
    diagnostics,
  };
}
