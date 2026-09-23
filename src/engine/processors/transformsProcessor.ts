import type { SplunkEvent, ConfDirective, DirectiveNoOp, ParsedConf, ProcessingStep, ValidationDiagnostic } from '../types';
import type { NoOpReason } from '../noOpExplainer';
import { applyRegexTransform } from '../transforms/regexTransform';
import { applyDestKey } from '../transforms/destKeyRouter';
import { applyIngestEval } from '../transforms/ingestEval';
import { byClassName } from '../utils/asciiCompare';
import { changeWindow } from '../utils/changeWindow';
import { SIMULATED_DEST_KEYS, VALID_UNSIMULATED_DEST_KEYS, normaliseDestKey } from '../transforms/destKeys';
import { atDirective, atStanza } from '../parser/provenance';

// A DEST_KEY=_raw transform that shrinks the event by at least this fraction is
// treated as accidental data loss (FORMAT did not reproduce the rest of the line).
const RAW_LOSS_THRESHOLD = 0.3;

/**
 * Locate a diagnostic at a named directive in a transform stanza, falling back
 * to the stanza header when the stanza does not carry that key. Both carry the
 * layer they came from, so the position stays unambiguous when the conf was read
 * as default/ + local/.
 */
function positionOfKeyOrStanza(stanza: ParsedConf['stanzas'][number], key: string) {
  const directive = stanza.directives.find((d) => d.key === key);
  return directive ? atDirective(directive) : atStanza(stanza);
}



export function applyTransforms(
  events: SplunkEvent[],
  directives: ConfDirective[],
  transformsConf: ParsedConf,
  phase: 'index-time' | 'search-time',
  diagnostics?: ValidationDiagnostic[],
  /** Epoch ms that INGEST_EVAL's now()/time() read. See `PipelineOptions.now`. */
  now: number = Date.now(),
): SplunkEvent[] {
  const directiveType = phase === 'index-time' ? 'TRANSFORMS' : 'REPORT';
  // When multiple TRANSFORMS-<class>/REPORT-<class> entries match, Splunk applies
  // them in ASCII order of the class name (comma-separated names within one class
  // stay list-ordered). Ordering is decisive once queue routing is last-wins.
  const transformDirectives = directives
    .filter((d) => d.directiveType === directiveType)
    .sort(byClassName);

  if (transformDirectives.length === 0) return events;

  const stanzaMap = new Map(transformsConf.stanzas.map((s) => [s.name, s]));
  // Emit the DEST_KEY=_raw data-loss warning at most once per transform stanza.
  const warnedRawLoss = new Set<string>();
  // SEM-7: warn once per stanza about index-time transforms that extract fields
  // with no WRITE_META/DEST_KEY (which have no effect at index time in Splunk).
  const warnedNoWriteMeta = new Set<string>();
  // SEM-16: warn once per stanza whose REGEX could not be compiled (invalid or ReDoS-rejected).
  const warnedInvalidRegex = new Set<string>();
  // SEM-11: warn once per stanza that routes via an unknown/unsimulated DEST_KEY.
  const warnedUnknownDestKey = new Set<string>();
  // Warn once per stanza whose DEST_KEY is reached through a search-time REPORT-,
  // where Splunk ignores it.
  const warnedSearchTimeDestKey = new Set<string>();
  const warnedSearchOnlyAttrs = new Set<string>();
  const warnedSearchTimeNoFormat = new Set<string>();

  return events.flatMap((event) => {
    let currentEvent: SplunkEvent = event;
    // CLONE_SOURCETYPE copies show up alongside the original (#87). Collected
    // rather than emitted inline: the clone is taken from the event as it stood
    // when the transform matched, and the original carries on through the rest
    // of the list unchanged.
    const clones: SplunkEvent[] = [];
    // Directives that reached a transform and changed nothing (#84).
    const noOps: DirectiveNoOp[] = [];
    const noteNoOp = (dir: ConfDirective, stanzaName: string, reason: NoOpReason) => {
      noOps.push({
        directive: `${dir.key} → [${stanzaName}]`,
        file: 'props.conf',
        line: dir.line,
        phase,
        reason,
      });
    };

    for (const dir of transformDirectives) {
      // Value can be comma-separated list of transform stanza names
      const stanzaNames = dir.value.split(',').map((s) => s.trim()).filter(Boolean);

      for (const stanzaName of stanzaNames) {
        const transformStanza = stanzaMap.get(stanzaName);
        if (!transformStanza) {
          noteNoOp(dir, stanzaName, { kind: 'transforms-stanza-missing', name: stanzaName });
          continue;
        }

        // INGEST_EVAL stanzas are part of the index-time TRANSFORMS list: they
        // execute at THIS position (interleaved with regex transforms), and only
        // because a TRANSFORMS-<class> references them. A regex transform listed
        // after the eval therefore sees the evaled event. INGEST_EVAL is
        // index-time only, so it is ignored on the search-time (REPORT) pass.
        const ingestEvalDirs = transformStanza.directives.filter((d) => d.key === 'INGEST_EVAL');
        if (ingestEvalDirs.length > 0) {
          if (phase === 'index-time') {
            currentEvent = applyIngestEval([currentEvent], ingestEvalDirs, diagnostics, now)[0] ?? currentEvent;
          }
          continue;
        }

        const result = applyRegexTransform(currentEvent, transformStanza, (pattern) => {
          if (!diagnostics || warnedInvalidRegex.has(stanzaName)) return;
          warnedInvalidRegex.add(stanzaName);
          diagnostics.push({
            level: 'warning',
            message: `Transform "${stanzaName}" was skipped: its REGEX (${pattern}) could not be compiled safely (invalid regex or rejected as ReDoS-prone).`,
            file: 'transforms.conf',
            ...positionOfKeyOrStanza(transformStanza, 'REGEX'),
          });
        }, phase);

        // Fires whether or not the transform matched: a DELIMS stanza reached
        // through TRANSFORMS- extracts nothing at all, so `matched` is false and
        // a warning gated on it would never reach the one config that needs it.
        if (phase === 'index-time' && diagnostics) {
          warnIndexTimeSearchOnlyAttrs(stanzaName, transformStanza, diagnostics, warnedSearchOnlyAttrs);
        }

        if (result.matched) {
          if (phase === 'index-time' && diagnostics) {
            warnIndexTimeNoWriteMeta(result, stanzaName, transformStanza, diagnostics, warnedNoWriteMeta);
          }
          // applyRegexTransform already ignored DEST_KEY on the search-time pass
          // (it is index-time only); say so, rather than silently applying half
          // the stanza.
          if (phase === 'search-time' && diagnostics) {
            warnSearchTimeDestKey(stanzaName, transformStanza, diagnostics, warnedSearchTimeDestKey);
            warnSearchTimeNoFormat(result, stanzaName, transformStanza, diagnostics, warnedSearchTimeNoFormat);
          }
          // An index-time extraction with neither WRITE_META = true nor a
          // DEST_KEY stores nothing in Splunk (#288). The warning above says so,
          // and the preview has to agree with it: showing the fields anyway made
          // the dead config look like a working one, contradicting its own
          // diagnostic. The field names are still reported, in the warning and
          // the trace, so the reader can see what was lost.
          const discardedFields =
            phase === 'index-time' && !result.destKey && !stanzaWritesMeta(transformStanza)
              ? Object.keys(result.fields)
              : [];
          const effective = discardedFields.length > 0 ? { ...result, fields: {} } : result;
          const beforeRaw = currentEvent._raw;
          // applyDestKey records queue values onto _meta._queue rather than dropping
          // the event — a later transform in the list can still overwrite the queue
          // (last-wins). nullQueue events are flagged (and shown as dropped) only
          // after the whole list runs; they are never removed mid-list.
          const routed = applyDestKey(currentEvent, effective);
          if (result.destKey === '_raw' && diagnostics) {
            warnRawLoss(beforeRaw, routed._raw, stanzaName, transformStanza, diagnostics, warnedRawLoss);
          }
          if (result.destKey && diagnostics) {
            warnUnknownDestKey(result.destKey, stanzaName, transformStanza, diagnostics, warnedUnknownDestKey);
          }
          // DEST_KEY = _raw overwrites the whole event with the FORMAT output,
          // destroying field values by the same mechanism as SEDCMD. Record the
          // rewrite so the same counterfactual attribution applies, and carry
          // the before/after text — this step previously logged neither.
          const rewroteRaw = result.destKey === '_raw' && routed._raw !== beforeRaw;
          const step: ProcessingStep = {
            processor: `${directiveType}-${dir.className ?? ''}:${stanzaName}`,
            phase,
            description: result.destKey
              ? `Transform routed to ${result.destKey}`
              : discardedFields.length > 0
                ? `Transform matched, but without WRITE_META = true or a DEST_KEY its fields are not stored: ${discardedFields.join(', ')}`
                : `Transform extracted fields: ${Object.keys(result.fields).join(', ')}`,
            fieldsAdded: Object.keys(effective.fields),
            ...(rewroteRaw ? changeWindow(beforeRaw, routed._raw) : {}),
          };
          currentEvent = {
            ...routed,
            processingTrace: [...routed.processingTrace, step],
            rawMutations: rewroteRaw
              ? [
                  ...(routed.rawMutations ?? []),
                  { traceIndex: routed.processingTrace.length, rawBefore: beforeRaw, rawAfter: routed._raw },
                ]
              : routed.rawMutations,
          };
          // CLONE_SOURCETYPE is index-time only. Splunk emits a copy carrying
          // the new sourcetype and lets the original continue untouched; the
          // copy re-enters the pipeline and picks up the new sourcetype's props
          // — its SEDCMD and TRANSFORMS in cloneSourcetype.ts, its search-time
          // config through the per-event path for any event whose metadata changed.
          const cloneType =
            phase === 'index-time'
              ? transformStanza.directives.filter((d) => d.key === 'CLONE_SOURCETYPE').at(-1)?.value.trim()
              : undefined;
          if (cloneType) {
            clones.push({
              ...currentEvent,
              metadata: { ...currentEvent.metadata, sourcetype: cloneType },
              clonedFrom: currentEvent.metadata.sourcetype,
              processingTrace: [
                ...currentEvent.processingTrace,
                {
                  processor: `${directiveType}-${dir.className ?? ''}:${stanzaName}`,
                  phase,
                  description: `CLONE_SOURCETYPE = ${cloneType} — emitted a copy of this event under sourcetype "${cloneType}"`,
                },
              ],
            });
          }
        } else if (result.noOp) {
          noteNoOp(dir, stanzaName, result.noOp);
        }
      }
    }

    const resolved =
      noOps.length > 0
        ? { ...currentEvent, noOps: [...(currentEvent.noOps ?? []), ...noOps] }
        : currentEvent;
    return clones.length > 0 ? [resolved, ...clones] : [resolved];
  });
}

/**
 * Whether the stanza's effective WRITE_META is true. Last definition wins, as
 * applyRegexTransform reads it — the warning and the discard must not disagree
 * with the extraction about a stanza that sets it twice.
 */
function stanzaWritesMeta(transformStanza: ParsedConf['stanzas'][number]): boolean {
  return (
    transformStanza.directives
      .filter((d) => d.key === 'WRITE_META')
      .at(-1)
      ?.value.trim()
      .toLowerCase() === 'true'
  );
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
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  if (warned.has(stanzaName)) return;
  // Only a concern when the transform produced fields and did not route anywhere.
  if (result.destKey || Object.keys(result.fields).length === 0) return;
  if (stanzaWritesMeta(transformStanza)) return;

  warned.add(stanzaName);
  diagnostics.push({
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
 * SEM-11: warn when DEST_KEY is set to something outside the documented Splunk
 * key set. The router falls back to treating an unknown key as a field name, so
 * a typo'd key silently "works" in the preview while doing nothing in Splunk.
 * `_TCP_ROUTING` / `_SYSLOG_ROUTING` are valid keys this tool just doesn't model;
 * they get an informational note rather than a warning. Fires once per stanza.
 */
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
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  if (warned.has(stanzaName)) return;
  const present = SEARCH_TIME_ONLY_ATTRS.filter((key) =>
    transformStanza.directives.some((d) => d.key === key),
  );
  if (present.length === 0) return;
  warned.add(stanzaName);

  const hasDelims = present.includes('DELIMS');
  diagnostics.push({
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
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  if (warned.has(stanzaName)) return;
  const destKeyDir = [...transformStanza.directives].reverse().find((d) => d.key === 'DEST_KEY');
  if (!destKeyDir) return;
  warned.add(stanzaName);
  const destKey = destKeyDir.value.trim();
  diagnostics.push({
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
 * and no named groups. At search time FORMAT has no default (#288) — the
 * `<stanza>::$1` default is index-time only — so this is a silent no-op in
 * Splunk, and the most likely cause is a config written with the index-time
 * default in mind.
 */
function warnSearchTimeNoFormat(
  result: { fields: Record<string, string | string[]> },
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  if (warned.has(stanzaName) || Object.keys(result.fields).length > 0) return;
  const has = (key: string) => transformStanza.directives.some((d) => d.key === key);
  if (has('FORMAT') || has('DELIMS')) return;
  // A named group that simply did not participate in this match also leaves
  // `fields` empty; that is data, not config, so stay quiet for it.
  const regex = transformStanza.directives.filter((d) => d.key === 'REGEX').at(-1)?.value ?? '';
  if (/\(\?P?<(?![=!])/.test(regex)) return;
  warned.add(stanzaName);
  diagnostics.push({
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

function warnUnknownDestKey(
  destKey: string,
  stanzaName: string,
  transformStanza: ParsedConf['stanzas'][number],
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  // Mirror the router's _MetaData:→MetaData: alias normalisation before comparing.
  const normalized = normaliseDestKey(destKey);
  if (SIMULATED_DEST_KEYS.has(normalized) || warned.has(stanzaName)) return;
  warned.add(stanzaName);

  const line = transformStanza.directives.find((d) => d.key === 'DEST_KEY')?.line ?? transformStanza.lineRange.start;
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
  diagnostics: ValidationDiagnostic[],
  warned: Set<string>,
): void {
  if (warned.has(stanzaName)) return;
  const origLen = beforeRaw.length;
  const dropped = origLen - afterRaw.length;
  if (origLen === 0 || dropped <= 0 || dropped / origLen <= RAW_LOSS_THRESHOLD) return;

  warned.add(stanzaName);
  diagnostics.push({
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

