import type { ConfInput, EventMetadata, PipelineOptions, ProcessingResult, ValidationDiagnostic, ConfDirective, SplunkEvent } from './types';
import { parseConf } from './parser/confParser';
import { matchStanzas, mergeDirectives, resolveStanzasForEvent, getRenamedSourcetype } from './parser/stanzaMatcher';
import { breakLines } from './processors/lineBreaker';
import { extractTimestamps } from './processors/timestampExtractor';
import { truncateEvents } from './processors/truncator';
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
      result: { events: [], originalRaw: rawData, eventCount: 0, processingSteps: [] },
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
  // Real Splunk implicitly sets SHOULD_LINEMERGE=false when INDEXED_EXTRACTIONS is a
  // structured format (csv/tsv/psv/w3c), so each line becomes its own event.
  const STRUCTURED_EXTRACTIONS = new Set(['csv', 'tsv', 'psv', 'w3c']);
  const indexedExtDir = directives.find((d) => d.key === 'INDEXED_EXTRACTIONS');
  const lineBreakDirectives =
    indexedExtDir && STRUCTURED_EXTRACTIONS.has(indexedExtDir.value.trim().toLowerCase()) &&
    !directives.some((d) => d.key === 'SHOULD_LINEMERGE')
      ? [...directives, { key: 'SHOULD_LINEMERGE', value: 'false', directiveType: 'SHOULD_LINEMERGE', line: 0 } as ConfDirective]
      : directives;
  // Wrapped like every other stage: a throw here used to escape runPipeline
  // and fail the whole run, where every later stage degrades to a diagnostic.
  // With nothing broken there are no events to carry forward, so the fallback
  // is empty rather than the unbroken input.
  let events = safeProcessor('LINE_BREAKER', [], () => breakLines(truncatedRaw, lineBreakDirectives, effectiveMetadata, diagnostics), diagnostics);

  // Step 3: Truncation
  events = safeProcessor('TRUNCATE', events, () => truncateEvents(events, directives, diagnostics), diagnostics);

  // Step 4: Timestamp extraction
  events = safeProcessor('Timestamp', events, () => extractTimestamps(events, directives, diagnostics, new Date(now)), diagnostics);

  // Step 5: Indexed extractions
  events = safeProcessor('INDEXED_EXTRACTIONS', events, () => applyIndexedExtractions(events, directives, diagnostics), diagnostics);

  // Step 6: SEDCMD
  events = safeProcessor('SEDCMD', events, () => applySedCommands(events, directives, diagnostics), diagnostics);

  // Step 7: Index-time TRANSFORMS — regex transforms, DEST_KEY routing, and
  // INGEST_EVAL stanzas are all applied here, interleaved in TRANSFORMS-<class>
  // list order (only when a props.conf stanza references them).
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
  const originalMetaKey = metaKey(metadata);

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
    events = events.map((event, i) => {
      if (metaKey(event.metadata) === originalMetaKey) return event;
      return {
        ...event,
        processingTrace: [
          ...event.processingTrace,
          {
            processor: 'StanzaRematch',
            phase: 'search-time' as const,
            description: `Metadata rewritten at index-time (sourcetype → "${event.metadata.sourcetype}"); stanzas re-matched for search-time using ${eventDirectives[i]?.length ?? 0} directives`,
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
    const rewroteMetadata = events.some((e) => metaKey(e.metadata) !== originalMetaKey);
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
    },
    diagnostics,
  };
}
