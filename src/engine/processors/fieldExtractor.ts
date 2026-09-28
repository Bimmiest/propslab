import type { SplunkEvent, ConfDirective, DirectiveNoOp, ValidationDiagnostic } from '../types';
import { extractionLimits, safeRegex, validateRegex, type SplunkRegex } from '../../utils/splunkRegex';
import { longestPartialMatch, type NoOpReason } from '../noOpExplainer';
import { effectiveValue } from '../utils/directiveValues';
import { isInternalField } from '../utils/internalFields';
import { byClassName } from '../utils/asciiCompare';
import { unquoteFieldName } from '../utils/fieldRef';
import { getMetadataField } from '../utils/metadataFields';
import { getField, hasField, setField } from '../utils/fieldBag';
import { atDirective } from '../parser/provenance';

/**
 * Each EXTRACT runs under its stanza's MATCH_LIMIT and DEPTH_LIMIT (Splunk's
 * defaults when unset). A match that hits one is no match, as in Splunk, and
 * the no-op says which limit it was.
 *
 * @param captureOffsets Record the capture spans of positional extractions in
 *   `fieldOffsets`, which the highlighter reads. Defaults to `true`; a caller
 *   that renders no highlights can pass `false` to skip the bookkeeping.
 */
export function extractFields(
  events: SplunkEvent[],
  directives: ConfDirective[],
  diagnostics?: ValidationDiagnostic[],
  captureOffsets: boolean = true,
): SplunkEvent[] {
  const extractDirectives = directives
    .filter((d) => d.directiveType === 'EXTRACT')
    .sort(byClassName);

  if (extractDirectives.length === 0) return events;

  const limits = extractionLimits(
    effectiveValue(directives, 'MATCH_LIMIT'),
    effectiveValue(directives, 'DEPTH_LIMIT'),
  );

  const extractions = extractDirectives.map((dir): Extraction => {
    const { pattern, sourceField } = parseExtractValue(dir.value);
    // Inline EXTRACT extracts the FIRST match only (max_match defaults to 1);
    // multivalue extraction requires a transforms.conf REGEX with MV_ADD, which
    // EXTRACT lacks.
    const regex = pattern ? safeRegex(pattern, '', limits) : null;
    // An extraction that does not compile is skipped, so surface it.
    if (pattern && !regex && diagnostics) {
      diagnostics.push({
        level: 'warning',
        message: `EXTRACT-${dir.className ?? ''} was skipped: its pattern does not compile (${validateRegex(pattern) ?? 'invalid regex'}). No fields were extracted.`,
        file: 'props.conf',
        ...atDirective(dir),
        directiveKey: dir.key,
      });
    }
    return { directive: dir, regex, sourceField };
  });

  const reportedStrippedRefs = new Set<string>();
  return events.map((event) => {
    const state: ExtractionState = {
      fields: { ...event.fields },
      offsets: { ...(event.fieldOffsets ?? {}) },
      offsetsChanged: false,
      traces: [],
      noOps: [],
    };
    for (const extraction of extractions) {
      runExtraction(event, extraction, state, { diagnostics, captureOffsets, reportedStrippedRefs });
    }
    return {
      ...event,
      fields: state.fields,
      ...(state.offsetsChanged ? { fieldOffsets: state.offsets } : {}),
      processingTrace: [...event.processingTrace, ...state.traces],
      ...(state.noOps.length > 0 ? { noOps: [...(event.noOps ?? []), ...state.noOps] } : {}),
    };
  });
}

interface Extraction {
  directive: ConfDirective;
  regex: SplunkRegex | null;
  sourceField: string | undefined;
}

/** What one event accumulates as its EXTRACTs run. */
interface ExtractionState {
  fields: SplunkEvent['fields'];
  offsets: Record<string, Array<[number, number]>>;
  offsetsChanged: boolean;
  traces: SplunkEvent['processingTrace'];
  /**
   * Every directive that stops early in runExtraction changed nothing, and
   * says why here.
   */
  noOps: DirectiveNoOp[];
}

interface ExtractionOptions {
  diagnostics: ValidationDiagnostic[] | undefined;
  captureOffsets: boolean;
  /** Source fields already warned about, so each is reported once per run. */
  reportedStrippedRefs: Set<string>;
}

function noteNoOp(state: ExtractionState, dir: ConfDirective, reason: NoOpReason): void {
  state.noOps.push({
    directive: dir.key,
    file: 'props.conf',
    line: dir.line,
    phase: 'search-time',
    reason,
  });
}

/**
 * Warn when an EXTRACT reads `in _field` and the event has `field`: index-time
 * extractions strip leading underscores, so Splunk resolves the name without it.
 */
function warnStrippedSourceRef(fields: SplunkEvent['fields'], extraction: Extraction, options: ExtractionOptions): void {
  const { diagnostics, reportedStrippedRefs } = options;
  const { sourceField, directive } = extraction;
  if (
    !diagnostics ||
    !sourceField ||
    !sourceField.startsWith('_') ||
    isInternalField(sourceField) ||
    reportedStrippedRefs.has(sourceField)
  ) {
    return;
  }
  const stripped = sourceField.replace(/^_+/, '');
  if (!stripped || !hasField(fields, stripped)) return;
  reportedStrippedRefs.add(sourceField);
  diagnostics.push({
    level: 'warning',
    message: `EXTRACT-${directive.className ?? ''} references source field "${sourceField}", but index-time extractions strip leading underscores — Splunk will resolve this as "${stripped}".`,
    file: 'props.conf',
    ...atDirective(directive),
    directiveKey: directive.key,
    suggestion: `Replace "in ${sourceField}" with "in ${stripped}"`,
  });
}

/**
 * Splunk trims leading and trailing whitespace from an EXTRACT value, and an
 * empty result creates no field. Checked on Splunk 10.4.0 (#411): `"  abc"`,
 * `"abc  "` and tab-wrapped `abc` all gave `abc`, `" a b "` gave `a b`, and
 * `"   "` and `""` gave no field. Spaces and tabs were observed; the rest of
 * ASCII whitespace is trimmed with them. Whether non-ASCII spaces such as
 * U+00A0 are trimmed is unchecked, so they are kept.
 */
const LEADING_WHITESPACE = /^[ \t\n\v\f\r]+/;
const TRAILING_WHITESPACE = /[ \t\n\v\f\r]+$/;

/** Store a match's named groups, first-wins, and trace or explain the outcome. */
function storeGroups(
  directive: ConfDirective,
  groups: Record<string, string | undefined>,
  indices: Record<string, [number, number] | undefined> | undefined,
  state: ExtractionState,
): void {
  const added: string[] = [];
  const alreadySet: string[] = [];
  const emptied: string[] = [];
  for (const [name, captured] of Object.entries(groups)) {
    if (captured === undefined) continue;
    const lead = LEADING_WHITESPACE.exec(captured)?.[0].length ?? 0;
    const value = captured.slice(lead).replace(TRAILING_WHITESPACE, '');
    if (value === '') {
      emptied.push(name);
      continue;
    }
    // First-wins (a simplification): this engine keeps the value from
    // the first extraction and discards later ones for the same field name.
    // Real Splunk's behaviour when two search-time extractions yield the same
    // field is closer to producing a multivalue field; verify against a live
    // indexer before relying on the collision outcome here.
    if (hasField(state.fields, name)) {
      alreadySet.push(name);
      continue;
    }
    setField(state.fields, name, value);
    added.push(name);
    const span = indices?.[name];
    if (span) {
      // The highlight covers the value as stored, without what was trimmed.
      const start = span[0] + lead;
      setField(state.offsets, name, [[start, start + value.length]]);
      state.offsetsChanged = true;
    }
  }

  if (added.length > 0) {
    state.traces.push({
      processor: `EXTRACT-${directive.className ?? ''}`,
      phase: 'search-time',
      description: `Extracted fields: ${added.join(', ')}`,
      fieldsAdded: added,
    });
  } else if (alreadySet.length > 0) {
    // It matched and still produced nothing, which looks identical in the
    // preview to a pattern that never matched at all.
    noteNoOp(state, directive, { kind: 'fields-already-set', fields: alreadySet });
  } else if (emptied.length > 0) {
    noteNoOp(state, directive, { kind: 'values-empty', fields: emptied });
  }
}

/** Run one EXTRACT against one event. */
function runExtraction(event: SplunkEvent, extraction: Extraction, state: ExtractionState, options: ExtractionOptions): void {
  const { directive, regex, sourceField } = extraction;
  if (!regex) {
    const { pattern } = parseExtractValue(directive.value);
    noteNoOp(state, directive, { kind: 'regex-invalid', error: validateRegex(pattern) ?? 'invalid regex' });
    return;
  }

  // `in <field>` reads the fields as they stand at this point in the pass, so
  // an extraction can read what an earlier one (in class-name order) produced.
  const sourceValue = sourceField ? getFieldValue(event, state.fields, sourceField) : event._raw;
  if (!sourceValue) {
    warnStrippedSourceRef(state.fields, extraction, options);
    noteNoOp(state, directive, { kind: 'source-key-empty', sourceKey: sourceField ?? '_raw' });
    return;
  }

  // Inline EXTRACT takes the first match only.
  const m = regex.exec(sourceValue);
  if (!m && regex.lastError !== undefined) {
    noteNoOp(state, directive, { kind: 'regex-limit', error: regex.lastError });
    return;
  }
  if (!m || !m.groups) {
    const { pattern } = parseExtractValue(directive.value);
    const partial = longestPartialMatch(pattern, sourceValue);
    noteNoOp(
      state,
      directive,
      partial
        ? { kind: 'no-match', partialEnd: partial.end, partialPattern: partial.prefix }
        : { kind: 'no-match' },
    );
    return;
  }
  // Offsets only authoritative when extracting from _raw — a captured position in a
  // derived source field cannot be translated back to _raw coordinates reliably.
  const isPositional = !sourceField;
  const indices = isPositional && options.captureOffsets ? m.indices.groups : undefined;
  storeGroups(directive, m.groups, indices, state);
}

export function parseExtractValue(value: string): { pattern: string; sourceField?: string } {
  const trimmed = value.trim();
  // Greedy match: consume as much as possible before the last " in <field>" suffix.
  // This avoids mis-splitting on regex bodies that contain the word "in". The source
  // field may be single/double-quoted so a nested-JSON name with a period survives
  // as one token (Splunk requires quoting for such names); strip the quotes here.
  const inMatch = trimmed.match(/^([\s\S]+)\s+in\s+('[^']*'|"[^"]*"|[\w.]+)\s*$/);
  if (inMatch) {
    return { pattern: inMatch[1] ?? '', sourceField: unquoteFieldName(inMatch[2] ?? '') };
  }
  return { pattern: trimmed };
}

/**
 * The value `in <field>` reads: from `fields`, which holds what the event
 * arrived with plus what earlier EXTRACTs in this pass produced. Checked on
 * Splunk 10.4.0 (#410): with EXTRACT-m_src producing `src`, EXTRACT-z_… in src
 * matched and EXTRACT-a_… in src, whose class sorts first, found nothing.
 * Fields from KV_MODE are not here, because automatic extraction runs after
 * every EXTRACT (the extract-in-source-field fixture).
 */
function getFieldValue(event: SplunkEvent, fields: SplunkEvent['fields'], fieldName: string): string | undefined {
  if (fieldName === '_raw') return event._raw;
  const val = getField(fields, fieldName);
  if (Array.isArray(val)) return val[0];
  // `EXTRACT-app = …(?<app>\w+)… in source` is a staple TA idiom: host/source/
  // sourcetype/index are default fields at search time, so extraction can run
  // against them without anything having extracted them first.
  if (val === undefined) return getMetadataField(event, fieldName);
  return val;
}
