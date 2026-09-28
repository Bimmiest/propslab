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

function safeProcessor(
  name: string,
  events: SplunkEvent[],
  fn: () => SplunkEvent[],
  diagnostics: ValidationDiagnostic[],
  file: ValidationDiagnostic['file'] = 'props.conf'
): SplunkEvent[] {
  try {
    return fn();
  } catch (err) {
    diagnostics.push({
      level: 'error',
      message: `Processor "${name}" failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      file,
    });
    return events; // Return unmodified events on failure
  }
}

/**
 * Collapse diagnostics that are identical in everything a reader can see. Used
 * by the per-event pipeline, where config-level problems would otherwise be
 * reported once per event.
 */
function dedupeDiagnostics(diagnostics: ValidationDiagnostic[]): ValidationDiagnostic[] {
  const seen = new Set<string>();
  const out: ValidationDiagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.level}|${d.file}|${d.layer ?? ''}|${d.line ?? ''}|${d.directiveKey ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

/**
 * Guard against excessively large inputs (> 1MB). Cut back to the last line
 * break inside the cap rather than at an arbitrary character: slicing
 * mid-line hands the pipeline a half-event, which then mis-breaks,
 * mis-timestamps, or extracts a truncated final field — a corrupt result
 * presented as a real one. Losing the partial trailing line is the honest
 * outcome, and the warning says so.
 */
function capInput(rawData: string, diagnostics: ValidationDiagnostic[]): string {
  const MAX_RAW_SIZE = 1_000_000;
  if (rawData.length <= MAX_RAW_SIZE) return rawData;
  const capped = rawData.slice(0, MAX_RAW_SIZE);
  const lastBreak = capped.lastIndexOf('\n');
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

/** Everything one run's stages share once the conf files are parsed and matched. */
interface RunContext {
  propsConf: ParsedConf;
  transformsConf: ParsedConf;
  /** Index-time directives: the stanzas matching the (assigned) metadata, merged. */
  directives: ConfDirective[];
  /** Search-time directives: `directives`, unless `rename` points elsewhere. */
  searchTimeDirectives: ConfDirective[];
  /** The metadata the events were broken with: the caller's, after any input-time assignment. */
  effectiveMetadata: EventMetadata;
  diagnostics: ValidationDiagnostic[];
  now: number;
  captureOffsets: boolean;
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
): Pick<RunContext, 'directives' | 'searchTimeDirectives' | 'effectiveMetadata'> {
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
  // sourcetype, and only search-time config comes from the target — and comes
  // from the target ALONE, since Splunk does not merge the original's
  // search-time settings in. Resolved here so index-time processing below is
  // unaffected by it.
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
function runIndexTime(rawData: string, ctx: RunContext): SplunkEvent[] {
  const { directives, diagnostics, now, propsConf, transformsConf } = ctx;
  // Step 1-2: Line breaking and merging.
  // The SHOULD_LINEMERGE default that INDEXED_EXTRACTIONS implies (off for the
  // line-per-record formats, on for XML) is decided inside breakLines alone;
  // a second copy of the rule here would drift from it.
  //
  // Wrapped like every other stage, so a throw degrades to a diagnostic rather
  // than failing the whole run. With nothing broken there are no events to
  // carry forward, so the fallback
  // is empty rather than the unbroken input.
  let events = safeProcessor('LINE_BREAKER', [], () => breakLines(rawData, directives, ctx.effectiveMetadata, diagnostics), diagnostics);

  // Step 3: Truncation
  events = safeProcessor('TRUNCATE', events, () => truncateEvents(events, directives, diagnostics), diagnostics);

  // Step 4: Timestamp extraction
  events = safeProcessor('Timestamp', events, () => extractTimestamps(events, directives, diagnostics, new Date(now)), diagnostics);

  // Step 4b: ROUTE_EVENTS_OLDER_THAN — the spec runs the age test "after
  // timestamp extraction", so it reads the extracted _time, before any
  // index-time transform can rewrite it.
  events = safeProcessor('ROUTE_EVENTS_OLDER_THAN', events, () => routeEventsByAge(events, directives, diagnostics, now), diagnostics);

  // Step 5: Indexed extractions
  events = safeProcessor('INDEXED_EXTRACTIONS', events, () => applyIndexedExtractions(events, directives, diagnostics, new Date(now)), diagnostics);

  // Step 6: SEDCMD
  events = safeProcessor('SEDCMD', events, () => applySedCommands(events, directives, diagnostics), diagnostics);

  // Step 7: Index-time TRANSFORMS — regex transforms, DEST_KEY routing, and
  // INGEST_EVAL / STOP_PROCESSING_IF stanzas are all applied here, interleaved
  // in TRANSFORMS-<class> list order, then every RULESET-<class> after them
  // (only when a props.conf stanza references them).
  events = safeProcessor('TRANSFORMS', events, () => applyTransforms(events, directives, transformsConf, 'index-time', diagnostics, now), diagnostics, 'transforms.conf');

  // Step 7b: CLONE_SOURCETYPE copies get the SEDCMD and TRANSFORMS of the
  // sourcetype they were cloned to.
  events = safeProcessor('CLONE_SOURCETYPE', events, () => applyCloneIndexTime(events, propsConf, transformsConf, diagnostics, now), diagnostics, 'transforms.conf');

  // Step 8: ANNOTATE_PUNCT — the annotation processor runs after regex
  // replacement, so the punct signature reflects _raw as indexed (post-SEDCMD,
  // post-transforms), not as ingested.
  return safeProcessor('ANNOTATE_PUNCT', events, () => annotatePunct(events, directives), diagnostics);
}

/**
 * The search-time stages over `events`, all read from `directives`. Splunk's
 * search-time order is EXTRACT → REPORT → automatic KV (KV_MODE) → FIELDALIAS → EVAL.
 */
function runSearchTimeStages(
  events: SplunkEvent[],
  directives: ConfDirective[],
  ctx: RunContext,
  diagnostics: ValidationDiagnostic[],
): SplunkEvent[] {
  const { transformsConf, now, captureOffsets } = ctx;
  // Step 8: EXTRACT (inline field extraction)
  let ev = safeProcessor('EXTRACT', events, () => extractFields(events, directives, diagnostics, captureOffsets), diagnostics);
  // Step 9: Search-time REPORT transforms (run BEFORE automatic KV — Splunk's
  // documented order is inline EXTRACT → REPORT field transforms → automatic KV).
  ev = safeProcessor('REPORT', ev, () => applyTransforms(ev, directives, transformsConf, 'search-time', diagnostics), diagnostics, 'transforms.conf');
  // Step 10: KV_MODE (automatic key-value extraction)
  ev = safeProcessor('KV_MODE', ev, () => applyKvMode(ev, directives, diagnostics), diagnostics);
  // Step 11: FIELDALIAS
  ev = safeProcessor('FIELDALIAS', ev, () => applyFieldAliases(ev, directives, diagnostics), diagnostics);
  // Step 12: EVAL (calculated fields)
  ev = safeProcessor('EVAL', ev, () => applyEvalExpressions(ev, directives, diagnostics, now), diagnostics);
  // Step 13: attribute index-time `_raw` rewrites (SEDCMD, DEST_KEY = _raw) to
  // the fields whose extracted value they changed or destroyed. Runs last
  // because it replays search-time extraction against the pre-rewrite text,
  // which is the only way the association can be computed at all.
  return safeProcessor('SEDCMD attribution', ev, () => attributeRawMutations(ev, () => directives, transformsConf), diagnostics);
}

const metaKey = (m: EventMetadata) => `${m.sourcetype}|${m.host}|${m.source}`;

/**
 * Per-event search time: resolve each event's directives from its own
 * metadata, re-matching stanzas for events whose metadata changed at index time.
 */
function runSearchTimePerEvent(events: SplunkEvent[], ctx: RunContext, originalMetaKey: string): SplunkEvent[] {
  const { propsConf } = ctx;
  const directivesCache = new Map<string, ConfDirective[]>();
  directivesCache.set(originalMetaKey, ctx.searchTimeDirectives);

  const eventDirectives = events.map((event) => {
    const key = metaKey(event.metadata);
    const cached = directivesCache.get(key);
    if (cached !== undefined) return cached;
    // Same resolution the batch path uses: an input-time `sourcetype`
    // assignment first, then `rename` for the search-time set.
    const perEvent = resolveStanzasForEvent(propsConf.stanzas, event.metadata);
    const renamed = getRenamedSourcetype(perEvent.stanzas);
    const stanzas = renamed
      ? matchStanzas(propsConf.stanzas, { ...perEvent.metadata, sourcetype: renamed })
      : perEvent.stanzas;
    const resolvedDirs = mergeDirectives(stanzas);
    directivesCache.set(key, resolvedDirs);
    return resolvedDirs;
  });

  // Each processor is called once PER EVENT here, so a diagnostic describing a
  // *config* problem (an invalid KV_MODE regex, an eval parse failure, a REPORT
  // whose REGEX will not compile) would be pushed once per event: 500 events,
  // 500 identical warnings. Collect into a scratch array and merge the distinct
  // entries afterwards. Genuinely per-event diagnostics carry their own line
  // number, so they differ and all survive.
  const perEventDiagnostics: ValidationDiagnostic[] = [];
  const processed = events.flatMap((event, i) => {
    const evDirs = eventDirectives[i] ?? [];
    return runSearchTimeStages([traceRematch(event, originalMetaKey, evDirs.length)], evDirs, ctx, perEventDiagnostics);
  });
  ctx.diagnostics.push(...dedupeDiagnostics(perEventDiagnostics));
  return processed;
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
 */
export function runPipeline(
  rawData: string,
  metadata: EventMetadata,
  propsConfInput: ConfInput,
  transformsConfInput: ConfInput,
  options?: PipelineOptions
): { result: ProcessingResult; diagnostics: ValidationDiagnostic[] } {
  const diagnostics: ValidationDiagnostic[] = [];

  if (!rawData.trim()) {
    return {
      result: { events: [], originalRaw: rawData, eventCount: 0, processingSteps: [], inputMetadata: metadata },
      diagnostics,
    };
  }

  const truncatedRaw = capInput(rawData, diagnostics);

  // 1. Parse configurations
  const propsConf = parseConf(propsConfInput, 'props.conf');
  const transformsConf = parseConf(transformsConfInput, 'transforms.conf');
  diagnostics.push(...propsConf.errors, ...transformsConf.errors);

  // Config-level lint: everything here reads the conf files alone, not which
  // stanzas match this event, and none of it changes what the pipeline does.
  lintConfigs(propsConf, transformsConf, diagnostics);

  const ctx: RunContext = {
    propsConf,
    transformsConf,
    ...resolveDirectives(propsConf, metadata, diagnostics),
    diagnostics,
    // Read once, so every stage of one run agrees on what "now" is.
    now: options?.now ?? Date.now(),
    // Defaults to true: the browser reads these offsets to highlight extracted
    // fields, so declining them has to be an explicit choice by a caller that does not.
    captureOffsets: options?.captureOffsets ?? true,
  };
  lintMatchedDirectives(ctx.directives, diagnostics);

  let events = runIndexTime(truncatedRaw, ctx);

  // Compared against the metadata the events were BROKEN with, not the caller's:
  // an input-time `sourcetype =` assignment has already been applied to every
  // event by now, and is not an index-time rewrite: keyed on the caller's
  // metadata, batch mode would warn about a DEST_KEY = MetaData:* transform
  // that does not exist and per-event mode would re-match every event.
  const originalMetaKey = metaKey(ctx.effectiveMetadata);
  if (options?.perEventPipeline) {
    events = runSearchTimePerEvent(events, ctx, originalMetaKey);
  } else {
    warnBatchMetadataRewrites(events, originalMetaKey, diagnostics);
    events = runSearchTimeStages(events, ctx.searchTimeDirectives, ctx, diagnostics);
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
      inputMetadata: ctx.effectiveMetadata,
    },
    diagnostics,
  };
}
