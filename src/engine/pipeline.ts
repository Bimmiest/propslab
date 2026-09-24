import type { ConfInput, EventMetadata, PipelineOptions, ProcessingResult, ValidationDiagnostic, ConfDirective, SplunkEvent } from './types';
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
  // Defaults to true: the browser reads these offsets to highlight extracted
  // fields, so declining them has to be an explicit choice by a caller that does not.
  const captureOffsets = options?.captureOffsets ?? true;
  // Read once, so every stage of one run agrees on what "now" is.
  const now = options?.now ?? Date.now();

  if (!rawData.trim()) {
    return {
      result: { events: [], originalRaw: rawData, eventCount: 0, processingSteps: [], inputMetadata: metadata },
      diagnostics,
    };
  }

  // Guard against excessively large inputs (> 1MB). Cut back to the last line
  // break inside the cap rather than at an arbitrary character: slicing
  // mid-line hands the pipeline a half-event, which then mis-breaks,
  // mis-timestamps, or extracts a truncated final field — a corrupt result
  // presented as a real one. Losing the partial trailing line is the honest
  // outcome, and the warning says so.
  const MAX_RAW_SIZE = 1_000_000;
  let truncatedRaw = rawData;
  if (rawData.length > MAX_RAW_SIZE) {
    const capped = rawData.slice(0, MAX_RAW_SIZE);
    const lastBreak = capped.lastIndexOf('\n');
    truncatedRaw = lastBreak > 0 ? capped.slice(0, lastBreak) : capped;
    diagnostics.push({
      level: 'warning',
      message:
        `Input truncated to ${truncatedRaw.length.toLocaleString()} characters for performance ` +
        `(original: ${rawData.length.toLocaleString()}). Truncation is aligned to the last complete ` +
        'line, so the final partial event is dropped rather than processed half-formed.',
      file: 'props.conf',
    });
  }

  // 1. Parse configurations
  const propsConf = parseConf(propsConfInput, 'props.conf');
  const transformsConf = parseConf(transformsConfInput, 'transforms.conf');

  diagnostics.push(...propsConf.errors, ...transformsConf.errors);

  // Config-level lint: everything here reads the conf files alone, not which
  // stanzas match this event, and none of it changes what the pipeline does.
  lintConfigs(propsConf, transformsConf, diagnostics);

  // 2. Match stanzas to metadata (by precedence) and merge directives (deduped by key, first wins).
  // `resolveStanzasForEvent` rather than `matchStanzas` because a `[source::…]`
  // or `[host::…]` stanza can assign the sourcetype, which decides what else
  // matches — so it has to be resolved before anything reads the result (#186).
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
  const searchTimeStanzas = renamedSourcetype
    ? matchStanzas(propsConf.stanzas, { ...effectiveMetadata, sourcetype: renamedSourcetype })
    : matchedStanzas;
  const searchTimeDirectives = renamedSourcetype ? mergeDirectives(searchTimeStanzas) : directives;

  if (renamedSourcetype) {
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
  }

  lintMatchedDirectives(directives, diagnostics);

  // ── Index-time processing ─────────────────────────────

  // Step 1-2: Line breaking and merging.
  // The SHOULD_LINEMERGE default that INDEXED_EXTRACTIONS implies (off for the
  // line-per-record formats, on for XML) is decided inside breakLines alone.
  // This used to inject a synthetic `SHOULD_LINEMERGE = false` here for
  // csv/tsv/psv/w3c as well — a narrower copy of the same rule, which agreed
  // with the breaker only by accident and left JSON to the other copy (#322).
  //
  // Wrapped like every other stage: a throw here used to escape runPipeline
  // and fail the whole run, where every later stage degrades to a diagnostic.
  // With nothing broken there are no events to carry forward, so the fallback
  // is empty rather than the unbroken input.
  let events = safeProcessor('LINE_BREAKER', [], () => breakLines(truncatedRaw, directives, effectiveMetadata, diagnostics), diagnostics);

  // Step 3: Truncation
  events = safeProcessor('TRUNCATE', events, () => truncateEvents(events, directives, diagnostics), diagnostics);

  // Step 4: Timestamp extraction
  events = safeProcessor('Timestamp', events, () => extractTimestamps(events, directives, diagnostics, new Date(now)), diagnostics);

  // Step 4b: ROUTE_EVENTS_OLDER_THAN — the spec runs the age test "after
  // timestamp extraction", so it reads the extracted _time, before any
  // index-time transform can rewrite it (#275).
  events = safeProcessor('ROUTE_EVENTS_OLDER_THAN', events, () => routeEventsByAge(events, directives, diagnostics, now), diagnostics);

  // Step 5: Indexed extractions
  events = safeProcessor('INDEXED_EXTRACTIONS', events, () => applyIndexedExtractions(events, directives, diagnostics), diagnostics);

  // Step 6: SEDCMD
  events = safeProcessor('SEDCMD', events, () => applySedCommands(events, directives, diagnostics), diagnostics);

  // Step 7: Index-time TRANSFORMS — regex transforms, DEST_KEY routing, and
  // INGEST_EVAL / STOP_PROCESSING_IF stanzas are all applied here, interleaved
  // in TRANSFORMS-<class> list order, then every RULESET-<class> after them
  // (only when a props.conf stanza references them).
  events = safeProcessor('TRANSFORMS', events, () => applyTransforms(events, directives, transformsConf, 'index-time', diagnostics, now), diagnostics, 'transforms.conf');

  // Step 7b: CLONE_SOURCETYPE copies get the SEDCMD and TRANSFORMS of the
  // sourcetype they were cloned to (#282).
  events = safeProcessor('CLONE_SOURCETYPE', events, () => applyCloneIndexTime(events, propsConf, transformsConf, diagnostics, now), diagnostics, 'transforms.conf');

  // Step 8: ANNOTATE_PUNCT — the annotation processor runs after regex
  // replacement, so the punct signature reflects _raw as indexed (post-SEDCMD,
  // post-transforms), not as ingested.
  events = safeProcessor('ANNOTATE_PUNCT', events, () => annotatePunct(events, directives), diagnostics);

  // ── Search-time processing ────────────────────────────

  const metaKey = (m: EventMetadata) => `${m.sourcetype}|${m.host}|${m.source}`;
  // Compared against the metadata the events were BROKEN with, not the caller's:
  // an input-time `sourcetype =` assignment has already been applied to every
  // event by now, and is not an index-time rewrite. Keying on the caller's
  // metadata read it as one, so batch mode warned about a DEST_KEY = MetaData:*
  // transform that did not exist and per-event mode added a StanzaRematch step
  // to every event (#310).
  const originalMetaKey = metaKey(effectiveMetadata);

  if (options?.perEventPipeline) {
    // Resolve per-event directives; re-match stanzas for events whose metadata changed at index-time.
    const directivesCache = new Map<string, ConfDirective[]>();
    directivesCache.set(originalMetaKey, searchTimeDirectives);

    const eventDirectives = events.map((event) => {
      const key = metaKey(event.metadata);
      if (directivesCache.has(key)) return directivesCache.get(key)!;
      // Same resolution the batch path uses: an input-time `sourcetype`
      // assignment first, then `rename` for the search-time set (#186).
      const perEvent = resolveStanzasForEvent(propsConf.stanzas, event.metadata);
      const renamed = getRenamedSourcetype(perEvent.stanzas);
      const stanzas = renamed
        ? matchStanzas(propsConf.stanzas, { ...perEvent.metadata, sourcetype: renamed })
        : perEvent.stanzas;
      const resolvedDirs = mergeDirectives(stanzas);
      directivesCache.set(key, resolvedDirs);
      return resolvedDirs;
    });

    // Annotate events whose metadata was rewritten so the trace shows the re-match.
    // A CLONE_SOURCETYPE copy differs because it was cloned to a new
    // sourcetype, not because a DEST_KEY = MetaData:* transform rewrote it, so
    // its step says that instead (#330).
    events = events.map((event, i) => {
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
            description: `${why}; stanzas re-matched for search-time using ${eventDirectives[i]?.length ?? 0} directives`,
          },
        ],
      };
    });

    // Run search-time steps per-event with their resolved directives.
    //
    // Each processor is called once PER EVENT here, so a diagnostic describing a
    // *config* problem (an invalid KV_MODE regex, an eval parse failure, a REPORT
    // whose REGEX will not compile) would be pushed once per event: 500 events,
    // 500 identical warnings. Collect into a scratch array and merge the distinct
    // entries afterwards. Genuinely per-event diagnostics carry their own line
    // number, so they differ and all survive.
    const perEventDiagnostics: ValidationDiagnostic[] = [];
    const processed: SplunkEvent[] = [];
    for (const [i, event] of events.entries()) {
      const evDirs = eventDirectives[i] ?? [];
      let ev: SplunkEvent[] = [event];
      // Splunk's search-time order is EXTRACT → REPORT → automatic KV (KV_MODE) → FIELDALIAS → EVAL.
      ev = safeProcessor('EXTRACT', ev, () => extractFields(ev, evDirs, perEventDiagnostics, captureOffsets), perEventDiagnostics);
      ev = safeProcessor('REPORT', ev, () => applyTransforms(ev, evDirs, transformsConf, 'search-time', perEventDiagnostics), perEventDiagnostics, 'transforms.conf');
      ev = safeProcessor('KV_MODE', ev, () => applyKvMode(ev, evDirs, perEventDiagnostics), perEventDiagnostics);
      ev = safeProcessor('FIELDALIAS', ev, () => applyFieldAliases(ev, evDirs, perEventDiagnostics), perEventDiagnostics);
      ev = safeProcessor('EVAL', ev, () => applyEvalExpressions(ev, evDirs, perEventDiagnostics, now), perEventDiagnostics);
      // Step 13: attribute index-time `_raw` rewrites to the fields they hit.
      // Must run last — it replays extraction, which only exists now.
      ev = safeProcessor('SEDCMD attribution', ev, () => attributeRawMutations(ev, () => evDirs, transformsConf), perEventDiagnostics);
      processed.push(...ev);
    }
    diagnostics.push(...dedupeDiagnostics(perEventDiagnostics));
    events = processed;
  } else {
    // Warn if any event had its routing metadata rewritten at index-time — search-time directives
    // are still resolved from the original metadata in batch mode.
    //
    // CLONE_SOURCETYPE copies are counted apart: they differ because they were
    // cloned to a new sourcetype, and blaming a DEST_KEY = MetaData:* transform
    // for them sent the reader looking for one that did not exist. Their
    // index-time SEDCMD and TRANSFORMS already come from the new sourcetype
    // (#282), but search-time here does not, so they get their own warning (#330).
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
          'One or more events had their sourcetype/host/source rewritten by a DEST_KEY = MetaData:* transform at index-time. ' +
          'In batch mode, search-time processors (EXTRACT, REPORT, FIELDALIAS, EVAL) still use the original stanza match and will not apply directives from the new sourcetype. ' +
          'Enable "Re-match stanzas after metadata rewrites" in Settings to simulate this correctly.',
        file: 'transforms.conf',
      });
    }

    // Step 8: EXTRACT (inline field extraction)
    events = safeProcessor('EXTRACT', events, () => extractFields(events, searchTimeDirectives, diagnostics, captureOffsets), diagnostics);

    // Step 9: Search-time REPORT transforms (run BEFORE automatic KV — Splunk's
    // documented order is inline EXTRACT → REPORT field transforms → automatic KV).
    events = safeProcessor('REPORT', events, () => applyTransforms(events, searchTimeDirectives, transformsConf, 'search-time', diagnostics), diagnostics, 'transforms.conf');

    // Step 10: KV_MODE (automatic key-value extraction)
    events = safeProcessor('KV_MODE', events, () => applyKvMode(events, searchTimeDirectives, diagnostics), diagnostics);

    // Step 11: FIELDALIAS
    events = safeProcessor('FIELDALIAS', events, () => applyFieldAliases(events, searchTimeDirectives, diagnostics), diagnostics);

    // Step 12: EVAL (calculated fields)
    events = safeProcessor('EVAL', events, () => applyEvalExpressions(events, searchTimeDirectives, diagnostics, now), diagnostics);

    // Step 13: attribute index-time `_raw` rewrites (SEDCMD, DEST_KEY = _raw) to
    // the fields whose extracted value they changed or destroyed. Runs last
    // because it replays search-time extraction against the pre-rewrite text,
    // which is the only way the association can be computed at all.
    events = safeProcessor('SEDCMD attribution', events, () => attributeRawMutations(events, () => searchTimeDirectives, transformsConf), diagnostics);
  }

  // Belt and braces: a processor that threw leaves `rawMutations` in place, and
  // the transient record must never reach a caller.
  events = events.map((e) => {
    if (!e.rawMutations) return e;
    const { rawMutations: _rawMutations, ...rest } = e;
    return rest;
  });

  // Collect all processing steps
  const processingSteps = events.flatMap((e) => e.processingTrace);

  return {
    result: {
      events,
      originalRaw: truncatedRaw,
      eventCount: events.length,
      processingSteps,
      // The metadata the events were broken with — the caller's, after any
      // input-time `sourcetype =` assignment. Returning the caller's badged
      // every event of an assigned sourcetype as "Metadata Modified", the UI
      // counterpart of #310 (#330).
      inputMetadata: effectiveMetadata,
    },
    diagnostics,
  };
}
