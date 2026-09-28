import type { SplunkEvent, ConfDirective, DirectiveNoOp, ParsedConf, ProcessingStep } from '../types';
import { noOpDirectiveKey, type NoOpReason } from '../noOpExplainer';
import { applyRegexTransform } from '../transforms/regexTransform';
import { applyDestKey } from '../transforms/destKeyRouter';
import { applyIngestEval } from '../transforms/ingestEval';
import { evaluateStopCondition } from '../transforms/stopProcessing';
import { byClassName } from '../utils/asciiCompare';
import { appendTraceStep, metadataChanges } from '../utils/traceStep';
import { SIMULATED_DEST_KEYS, VALID_UNSIMULATED_DEST_KEYS, normaliseDestKey } from '../transforms/destKeys';
import { atDirective, atStanza } from '../parser/provenance';
import { effectiveDirective, parseSplunkBool } from '../utils/directiveValues';
import { validateRegex } from '../../utils/splunkRegex';
import { epochOutOfRangeMessage } from '../utils/epochTime';
import type { DiagnosticsCollector, RunContext } from '../runContext';

// A DEST_KEY=_raw transform that shrinks the event by at least this fraction is
// treated as accidental data loss (FORMAT did not reproduce the rest of the line).
const RAW_LOSS_THRESHOLD = 0.3;

/**
 * Locate a diagnostic at a named directive in a transform stanza, falling back
 * to the stanza header when the stanza does not carry that key. Both carry the
 * layer they came from, so the position stays unambiguous when the conf was read
 * as default/ + local/ — and it is the effective (last) definition, the one the
 * transform actually ran, rather than a shadowed one above it.
 */
function positionOfKeyOrStanza(stanza: ParsedConf['stanzas'][number], key: string) {
  const directive = effectiveDirective(stanza.directives, key);
  return directive ? atDirective(directive) : atStanza(stanza);
}

type Phase = 'index-time' | 'search-time';
type TransformStanza = ParsedConf['stanzas'][number];
type TransformResult = ReturnType<typeof applyRegexTransform>;

/**
 * The transform lists a phase runs, in the order Splunk applies them.
 *
 * When multiple TRANSFORMS-<class>/REPORT-<class> entries match, Splunk applies
 * them in ASCII order of the class name (comma-separated names within one class
 * stay list-ordered). Ordering is decisive once queue routing is last-wins.
 *
 * RULESET-<class> is the other index-time list. It does what
 * TRANSFORMS- does, and transforms.conf.spec fixes the order between them:
 * every TRANSFORMS class alphabetically, then every RULESET class
 * alphabetically, then by position within a ruleset. So the two are sorted
 * separately and concatenated rather than sorted together — a RULESET-a
 * still runs after a TRANSFORMS-z.
 */
function orderedTransformLists(directives: ConfDirective[], phase: Phase): ConfDirective[] {
  const byType = (type: string) =>
    directives.filter((d) => d.directiveType === type).sort(byClassName);
  return phase === 'index-time' ? [...byType('TRANSFORMS'), ...byType('RULESET')] : byType('REPORT');
}

/** One applyTransforms call: its phase, and the run it reports into. */
interface TransformsRun {
  phase: Phase;
  ctx: RunContext;
  diagnostics: DiagnosticsCollector;
  stanzaMap: Map<string, TransformStanza>;
}

/**
 * The run-wide key for a once-per-stanza warning. The index-time stage and the
 * CLONE_SOURCETYPE pass share the run's ledger, so a clone, which is its own
 * applyTransforms call, does not repeat what the originals reported. Keyed by
 * phase too: a stanza reached by both TRANSFORMS- and REPORT- is reported on
 * each pass.
 */
function warnKey(run: TransformsRun, warning: string, stanzaName: string): string {
  return `transforms|${run.phase}|${warning}|${stanzaName}`;
}

/** One event on its way through the transform lists. */
interface EventState {
  event: SplunkEvent;
  /**
   * CLONE_SOURCETYPE copies show up alongside the original. Collected
   * rather than emitted inline: the clone is taken from the event as it stood
   * when the transform matched, and the original carries on through the rest
   * of the list unchanged.
   */
  clones: SplunkEvent[];
  /** Directives that reached a transform and changed nothing. */
  noOps: DirectiveNoOp[];
}

/** Where one transform sits: the list directive, its label, and the stanza's name. */
interface TransformSite {
  dir: ConfDirective;
  /**
   * The trace names the list a step came from, so a RULESET- rule reads as
   * one rather than being mislabelled TRANSFORMS-.
   */
  listLabel: string;
  stanzaName: string;
}

/** Where a no-op at `site` is reported: the list directive, naming the stanza. */
function noOpSite(site: TransformSite) {
  return { directive: `${site.dir.key} → [${site.stanzaName}]`, file: 'props.conf' as const, line: site.dir.line };
}

function noteNoOp(run: TransformsRun, state: EventState, site: TransformSite, reason: NoOpReason): void {
  state.noOps.push({ ...noOpSite(site), phase: run.phase, reason });
}

/**
 * Run an INGEST_EVAL / STOP_PROCESSING_IF stanza. Returns true when the stop
 * condition held, so the rest of the list is skipped.
 *
 * INGEST_EVAL stanzas are part of the index-time TRANSFORMS list: they
 * execute at THIS position (interleaved with regex transforms), and only
 * because a TRANSFORMS-<class> references them. A regex transform listed
 * after the eval therefore sees the evaled event. INGEST_EVAL is
 * index-time only, so it is ignored on the search-time (REPORT) pass.
 *
 * STOP_PROCESSING_IF is the same kind of stanza: like INGEST_EVAL
 * it overrides the stanza's other index-time settings, and it runs after
 * the stanza's INGEST_EVAL, so it sees the evaled event. When it holds,
 * the rules after it in this list are skipped. The spec states that
 * scope for a ruleset — "skips every rule after it in that ruleset" —
 * and the same scope is applied to a TRANSFORMS- list, which is the
 * same construct: a class's comma-separated rules. Later classes still
 * run; nothing in the spec says a stop reaches across lists.
 */
function runEvalStanza(
  run: TransformsRun,
  state: EventState,
  site: TransformSite,
  transformStanza: TransformStanza,
  ingestEvalDirs: ConfDirective[],
  skipped: string[],
): boolean {
  if (run.phase !== 'index-time') return false;
  if (ingestEvalDirs.length > 0) {
    state.event = applyIngestEval([state.event], ingestEvalDirs, run.ctx)[0] ?? state.event;
  }
  const stop = evaluateStopCondition(state.event, transformStanza.directives, run.ctx);
  if (!stop) return false;
  const { listLabel } = site;
  const description = !stop.stop
    ? `STOP_PROCESSING_IF (${stop.expression}) was false — processing continues`
    : skipped.length > 0
      ? `STOP_PROCESSING_IF (${stop.expression}) was true — skipped the rest of ${listLabel}: ${skipped.join(', ')}`
      : `STOP_PROCESSING_IF (${stop.expression}) was true — no rules follow it in ${listLabel}`;
  state.event = {
    ...state.event,
    processingTrace: [
      ...state.event.processingTrace,
      { processor: `${listLabel}:${site.stanzaName}`, phase: run.phase, description },
    ],
  };
  return stop.stop;
}

/** The once-per-stanza warnings a matched regex transform can raise before routing. */
function warnMatched(run: TransformsRun, result: TransformResult, stanzaName: string, transformStanza: TransformStanza): void {
  const { diagnostics } = run;
  if (run.phase === 'index-time') {
    warnIndexTimeNoWriteMeta(result, stanzaName, transformStanza, diagnostics, warnKey(run, 'noWriteMeta', stanzaName));
  }
  // applyRegexTransform already ignored DEST_KEY on the search-time pass
  // (it is index-time only); say so, rather than silently applying half
  // the stanza.
  if (run.phase === 'search-time') {
    warnSearchTimeDestKey(stanzaName, transformStanza, diagnostics, warnKey(run, 'searchTimeDestKey', stanzaName));
    warnSearchTimeNoFormat(result, stanzaName, transformStanza, diagnostics, warnKey(run, 'searchTimeNoFormat', stanzaName));
  }
}

/** The trace text for a transform that matched. */
function describeMatch(
  result: TransformResult,
  discardedFields: string[],
  cloneType: string | undefined,
): string {
  const extracted = Object.keys(result.fields);
  if (result.destKey) return `Transform routed to ${result.destKey}`;
  if (discardedFields.length > 0) {
    return `Transform matched, but without WRITE_META = true or a DEST_KEY its fields are not stored: ${discardedFields.join(', ')}`;
  }
  if (extracted.length > 0) return `Transform extracted fields: ${extracted.join(', ')}`;
  // A stanza that exists for CLONE_SOURCETYPE, or a REGEX with nothing to
  // capture, matched and extracted nothing — say what it did instead of
  // "extracted fields:" over an empty list.
  return cloneType
    ? `Transform matched; it extracts no fields, and CLONE_SOURCETYPE = ${cloneType} copies the event`
    : 'Transform matched; it extracted no fields';
}

/**
 * CLONE_SOURCETYPE is index-time only. Splunk emits a copy carrying the new
 * sourcetype and lets the original continue untouched; the copy re-enters the
 * pipeline and picks up the new sourcetype's props — its SEDCMD and TRANSFORMS
 * in cloneSourcetype.ts, its search-time config through the per-event path for
 * any event whose metadata changed.
 */
function cloneEvent(event: SplunkEvent, cloneType: string, processor: string, phase: Phase): SplunkEvent {
  return {
    ...event,
    metadata: { ...event.metadata, sourcetype: cloneType },
    clonedFrom: event.metadata.sourcetype,
    processingTrace: [
      ...event.processingTrace,
      {
        processor,
        phase,
        description: `CLONE_SOURCETYPE = ${cloneType} — emitted a copy of this event under sourcetype "${cloneType}"`,
      },
    ],
  };
}

/** Route a matched transform's result onto the event, tracing and cloning as it says. */
function applyMatch(
  run: TransformsRun,
  state: EventState,
  site: TransformSite,
  transformStanza: TransformStanza,
  result: TransformResult,
): void {
  const { phase, diagnostics } = run;
  const { stanzaName } = site;
  warnMatched(run, result, stanzaName, transformStanza);
  // An index-time extraction with neither WRITE_META = true nor a
  // DEST_KEY stores nothing in Splunk. The warning above says so, and the
  // preview has to agree with it: showing the fields anyway would make the
  // dead config look like a working one. The field names are still reported,
  // in the warning and
  // the trace, so the reader can see what was lost.
  const discardedFields =
    phase === 'index-time' && !result.destKey && !stanzaWritesMeta(transformStanza)
      ? Object.keys(result.fields)
      : [];
  const effective = discardedFields.length > 0 ? { ...result, fields: {} } : result;
  const beforeRaw = state.event._raw;
  // applyDestKey records queue values onto _meta._queue rather than dropping
  // the event — a later transform in the list can still overwrite the queue
  // (last-wins). nullQueue events are flagged (and shown as dropped) only
  // after the whole list runs; they are never removed mid-list.
  const routed = applyDestKey(state.event, effective, (value) => {
    diagnostics.report(warnKey(run, 'timeOutOfRange', stanzaName), {
      level: 'warning',
      message: epochOutOfRangeMessage(`DEST_KEY = _time in transform "${stanzaName}"`, value),
      file: 'transforms.conf',
      ...positionOfKeyOrStanza(transformStanza, 'DEST_KEY'),
    });
  });
  if (result.destKey === '_raw') {
    warnRawLoss(beforeRaw, routed._raw, stanzaName, transformStanza, diagnostics, warnKey(run, 'rawLoss', stanzaName));
  }
  if (result.destKey) {
    warnUnknownDestKey(result.destKey, stanzaName, transformStanza, diagnostics, warnKey(run, 'unknownDestKey', stanzaName));
  }
  // DEST_KEY = _raw overwrites the whole event with the FORMAT output,
  // destroying field values by the same mechanism as SEDCMD. The
  // rewrite is recorded (appendTraceStep) so the same counterfactual
  // attribution applies, with the before/after text — the path
  // INGEST_EVAL's `_raw=` shares. Only DEST_KEY = _raw can
  // change _raw here, so an unchanged _raw records nothing.
  const cloneType =
    phase === 'index-time'
      ? effectiveDirective(transformStanza.directives, 'CLONE_SOURCETYPE')?.value.trim()
      : undefined;
  const metaChanges = metadataChanges(state.event.metadata, routed.metadata);
  const processor = `${site.listLabel}:${stanzaName}`;
  const step: ProcessingStep = {
    processor,
    phase,
    description: describeMatch(result, discardedFields, cloneType),
    fieldsAdded: Object.keys(effective.fields),
    ...(metaChanges.length > 0 ? { metadataChanges: metaChanges } : {}),
  };
  state.event = appendTraceStep(routed, step, beforeRaw);
  if (cloneType) state.clones.push(cloneEvent(state.event, cloneType, processor, phase));
}

/** Run one REGEX (or DELIMS) transform stanza against the event. */
function runRegexStanza(run: TransformsRun, state: EventState, site: TransformSite, transformStanza: TransformStanza): void {
  const { phase, diagnostics } = run;
  const { stanzaName } = site;
  const result = applyRegexTransform(state.event, transformStanza, (pattern) => {
    diagnostics.report(warnKey(run, 'invalidRegex', stanzaName), {
      level: 'warning',
      message: `Transform "${stanzaName}" was skipped: its REGEX (${pattern}) does not compile (${validateRegex(pattern) ?? 'invalid regex'}).`,
      file: 'transforms.conf',
      ...positionOfKeyOrStanza(transformStanza, 'REGEX'),
    });
  }, phase, () => run.ctx.explanations.take(noOpDirectiveKey(noOpSite(site))));

  // Fires whether or not the transform matched: a DELIMS stanza reached
  // through TRANSFORMS- extracts nothing at all, so `matched` is false and
  // a warning gated on it would never reach the one config that needs it.
  if (phase === 'index-time') {
    warnIndexTimeSearchOnlyAttrs(stanzaName, transformStanza, diagnostics, warnKey(run, 'searchOnlyAttrs', stanzaName));
  }

  if (result.matched) applyMatch(run, state, site, transformStanza, result);
  else if (result.noOp) noteNoOp(run, state, site, result.noOp);
}

/** Run one TRANSFORMS-/RULESET-/REPORT- list against the event. */
function runTransformList(run: TransformsRun, state: EventState, dir: ConfDirective): void {
  // Value can be comma-separated list of transform stanza names
  const stanzaNames = dir.value.split(',').map((s) => s.trim()).filter(Boolean);
  const listLabel = `${dir.directiveType}-${dir.className ?? ''}`;

  for (const [position, stanzaName] of stanzaNames.entries()) {
    const site: TransformSite = { dir, listLabel, stanzaName };
    const transformStanza = run.stanzaMap.get(stanzaName);
    if (!transformStanza) {
      noteNoOp(run, state, site, { kind: 'transforms-stanza-missing', name: stanzaName });
      continue;
    }
    const ingestEvalDirs = transformStanza.directives.filter((d) => d.key === 'INGEST_EVAL');
    const hasStopCondition = transformStanza.directives.some((d) => d.key === 'STOP_PROCESSING_IF');
    if (ingestEvalDirs.length > 0 || hasStopCondition) {
      const skipped = stanzaNames.slice(position + 1);
      if (runEvalStanza(run, state, site, transformStanza, ingestEvalDirs, skipped)) break;
      continue;
    }
    runRegexStanza(run, state, site, transformStanza);
  }
}

export function applyTransforms(
  events: SplunkEvent[],
  directives: ConfDirective[],
  transformsConf: ParsedConf,
  phase: Phase,
  /** `ctx.now` is what INGEST_EVAL's now()/time() read. */
  ctx: RunContext,
): SplunkEvent[] {
  const transformDirectives = orderedTransformLists(directives, phase);
  if (transformDirectives.length === 0) return events;

  const run: TransformsRun = {
    phase,
    ctx,
    diagnostics: ctx.diagnostics,
    stanzaMap: new Map(transformsConf.stanzas.map((s) => [s.name, s])),
  };

  return events.flatMap((event) => {
    const state: EventState = { event, clones: [], noOps: [] };
    for (const dir of transformDirectives) runTransformList(run, state, dir);

    const { noOps, clones } = state;
    const resolved =
      noOps.length > 0
        ? { ...state.event, noOps: [...(state.event.noOps ?? []), ...noOps] }
        : state.event;
    return clones.length > 0 ? [resolved, ...clones] : [resolved];
  });
}

/**
 * Whether the stanza's effective WRITE_META is true. Last definition wins, as
 * applyRegexTransform reads it — the warning and the discard must not disagree
 * with the extraction about a stanza that sets it twice.
 */
function stanzaWritesMeta(transformStanza: ParsedConf['stanzas'][number]): boolean {
  return parseSplunkBool(effectiveDirective(transformStanza.directives, 'WRITE_META')?.value, false);
}

/**
 * Warn when an index-time transform extracts fields but writes nowhere — no
 * WRITE_META = true and no DEST_KEY. In real Splunk such a stanza does nothing at
 * index time (index-time field extraction requires WRITE_META), so a config that
 * "works" in the preview would ship dead. Fires at most once per stanza.
 */
function warnIndexTimeNoWriteMeta(
  result: { fields: Record<string, string | string[]>; destKey?: string },
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  // Only a concern when the transform produced fields and did not route anywhere.
  if (result.destKey || Object.keys(result.fields).length === 0) return;
  if (stanzaWritesMeta(transformStanza)) return;

  diagnostics.report(key, {
    level: 'warning',
    message:
      `Index-time transform "${stanzaName}" extracts fields (${Object.keys(result.fields).join(', ')}) but has no ` +
      'WRITE_META = true and no DEST_KEY. In real Splunk an index-time TRANSFORMS stanza only stores fields when ' +
      'WRITE_META = true (or it routes via DEST_KEY); without either it has no effect. If you meant a search-time ' +
      'extraction, reference it with REPORT-<class> instead of TRANSFORMS-<class>.',
    file: 'transforms.conf',
    ...atStanza(transformStanza),
  });
}

/**
 * Attributes transforms.conf documents as valid only for search-time field
 * extractions. Reached through an index-time `TRANSFORMS-`, Splunk ignores them.
 *
 * DELIMS and FIELDS are the consequential pair: they are the *alternative* to
 * REGEX, so a DELIMS stanza used index-time has no extraction mechanism left and
 * does nothing whatsoever — the config looks reasonable and produces no fields.
 */
const SEARCH_TIME_ONLY_ATTRS = ['DELIMS', 'FIELDS', 'MV_ADD', 'CLEAN_KEYS', 'KEEP_EMPTY_VALS'];

function warnIndexTimeSearchOnlyAttrs(
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  const present = SEARCH_TIME_ONLY_ATTRS.filter((attr) =>
    transformStanza.directives.some((d) => d.key === attr),
  );
  if (present.length === 0) return;

  const hasDelims = present.includes('DELIMS');
  diagnostics.report(key, {
    level: 'warning',
    message:
      `Transform "${stanzaName}" sets ${present.join(', ')}, but it is referenced by an index-time TRANSFORMS-. ` +
      `${present.length === 1 ? 'That attribute is' : 'Those attributes are'} valid only for search-time field ` +
      'extractions, so Splunk ignores ' +
      `${present.length === 1 ? 'it' : 'them'} here. ` +
      (hasDelims
        ? 'DELIMS is the alternative to REGEX, so this stanza extracts nothing at all. '
        : '') +
      'Reference the stanza with REPORT-<class> instead.',
    file: 'transforms.conf',
    ...positionOfKeyOrStanza(transformStanza, present[0] ?? 'DELIMS'),
  });
}

/**
 * A stanza referenced by `REPORT-` runs at search time, where transforms.conf
 * defines DEST_KEY as having no meaning. Splunk performs the field extraction
 * and ignores the routing; say so rather than silently dropping half the stanza.
 */
function warnSearchTimeDestKey(
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  const destKeyDir = effectiveDirective(transformStanza.directives, 'DEST_KEY');
  if (!destKeyDir) return;
  const destKey = destKeyDir.value.trim();
  diagnostics.report(key, {
    level: 'warning',
    message:
      `Transform "${stanzaName}" sets DEST_KEY = ${destKey}, but it is referenced by a search-time REPORT-. ` +
      'DEST_KEY is index-time only, so Splunk applies the field extraction and ignores the routing. ' +
      'Reference the stanza from TRANSFORMS- instead if the routing is intended.',
    file: 'transforms.conf',
    ...atDirective(destKeyDir),
  });
}

/**
 * A REPORT- whose REGEX matched but produced nothing because it has no FORMAT
 * and no named groups. At search time FORMAT has no default — the
 * `<stanza>::$1` default is index-time only — so this is a silent no-op in
 * Splunk, and the most likely cause is a config written with the index-time
 * default in mind.
 */
function warnSearchTimeNoFormat(
  result: { fields: Record<string, string | string[]> },
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  if (Object.keys(result.fields).length > 0) return;
  const has = (attr: string) => transformStanza.directives.some((d) => d.key === attr);
  if (has('FORMAT') || has('DELIMS')) return;
  // A named group that simply did not participate in this match also leaves
  // `fields` empty; that is data, not config, so stay quiet for it.
  const regex = effectiveDirective(transformStanza.directives, 'REGEX')?.value ?? '';
  if (/\(\?P?<(?![=!])/.test(regex)) return;
  diagnostics.report(key, {
    level: 'warning',
    message:
      `Transform "${stanzaName}" is referenced by a search-time REPORT- and its REGEX matched, but it has no ` +
      'FORMAT and no named capture groups, so it extracts nothing. At search time FORMAT has no default ' +
      `(the "${stanzaName}::$1" default applies only to index-time TRANSFORMS-). Add a FORMAT such as ` +
      'field::$1, or name the groups: (?<field>…).',
    file: 'transforms.conf',
    ...positionOfKeyOrStanza(transformStanza, 'REGEX'),
  });
}

/**
 * Warn when DEST_KEY is set to something outside the documented Splunk key
 * set. The router falls back to treating an unknown key as a field name, so
 * a typo'd key silently "works" in the preview while doing nothing in Splunk.
 * `_TCP_ROUTING` / `_SYSLOG_ROUTING` are valid keys this tool just doesn't model;
 * they get an informational note rather than a warning. Fires once per stanza.
 */
function warnUnknownDestKey(
  destKey: string,
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  // Mirror the router's _MetaData:→MetaData: alias normalisation before comparing.
  const normalized = normaliseDestKey(destKey);
  if (SIMULATED_DEST_KEYS.has(normalized) || !diagnostics.once(key)) return;

  const line = effectiveDirective(transformStanza.directives, 'DEST_KEY')?.line ?? transformStanza.lineRange.start;
  if (VALID_UNSIMULATED_DEST_KEYS.has(normalized)) {
    diagnostics.push({
      level: 'info',
      message: `DEST_KEY = ${destKey} in transform "${stanzaName}" is a valid Splunk routing key but is not simulated here — the event is shown unchanged.`,
      file: 'transforms.conf',
      line,
    });
    return;
  }
  diagnostics.push({
    level: 'warning',
    message:
      `DEST_KEY = ${destKey} in transform "${stanzaName}" is not a recognized Splunk DEST_KEY ` +
      '(expected one of queue, _raw, _meta, _time, MetaData:Host, MetaData:Index, MetaData:Source, ' +
      'MetaData:Sourcetype, _TCP_ROUTING, _SYSLOG_ROUTING). The preview treats it as a field name, ' +
      'but real Splunk ignores unknown DEST_KEY values.',
    file: 'transforms.conf',
    line,
  });
}

/**
 * Warn when a DEST_KEY=_raw transform discards a large chunk of the event — the
 * classic footgun where FORMAT captures only part of the line and the rest is
 * lost. Fires at most once per stanza.
 */
function warnRawLoss(
  beforeRaw: string,
  afterRaw: string,
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: DiagnosticsCollector,
  key: string,
): void {
  const origLen = beforeRaw.length;
  const dropped = origLen - afterRaw.length;
  if (origLen === 0 || dropped <= 0 || dropped / origLen <= RAW_LOSS_THRESHOLD) return;

  diagnostics.report(key, {
    level: 'warning',
    message:
      `DEST_KEY = _raw in transform "${stanzaName}" replaced the event and dropped ${dropped} of ${origLen} characters. ` +
      'DEST_KEY = _raw overwrites the entire event with the FORMAT output — any text the REGEX does not capture and ' +
      'FORMAT does not reproduce is discarded. To keep the surrounding text, capture the whole line ' +
      '(e.g. REGEX = (.*?)(secret)(.*), FORMAT = $1XXXX$3) or use SEDCMD to substitute in place.',
    file: 'transforms.conf',
    ...positionOfKeyOrStanza(transformStanza, 'DEST_KEY'),
  });
}

