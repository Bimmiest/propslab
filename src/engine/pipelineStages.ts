// ---------------------------------------------------------------------------
// pipelineStages.ts
// The ordered list of processing stages Splunk applies to an event, and the
// directives that control each one.
//
// Lifted out of HelpPanel when the dictionary arrived: the help drawer answers
// "what runs when" and the dictionary answers "what does this directive do",
// and both need to link to the other. Keeping the data here means neither
// component imports the other.
// ---------------------------------------------------------------------------

export interface PipelineStage {
  step: number;
  name: string;
  phase: 'index-time' | 'search-time';
  description: string;
  /** Directive keys that configure this stage, as base keys (no class suffix). */
  directives: string[];
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    step: 1,
    name: 'Line Breaking',
    phase: 'index-time',
    description:
      'Splits the raw data stream into individual events. Splunk looks for the LINE_BREAKER regex to find event boundaries. By default it breaks on newlines, but multiline events (e.g. stack traces) need SHOULD_LINEMERGE or BREAK_ONLY_BEFORE.',
    directives: ['LINE_BREAKER', 'SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE', 'BREAK_ONLY_BEFORE_DATE', 'MUST_BREAK_AFTER', 'MAX_EVENTS'],
  },
  {
    step: 2,
    name: 'Truncation',
    phase: 'index-time',
    description:
      'Truncates events that exceed the maximum allowed length. Prevents runaway events from consuming excessive index space. Events are cut at the TRUNCATE byte boundary.',
    directives: ['TRUNCATE'],
  },
  {
    step: 3,
    name: 'Timestamp Extraction',
    phase: 'index-time',
    description:
      'Locates and parses the event timestamp. TIME_PREFIX anchors the search position; TIME_FORMAT parses the found value using strftime tokens. If no timestamp is found, the event inherits the previous event’s _time; the first event falls back to the time of indexing.',
    directives: ['TIME_PREFIX', 'TIME_FORMAT', 'MAX_TIMESTAMP_LOOKAHEAD', 'TZ', 'MAX_DAYS_AGO', 'MAX_DAYS_HENCE'],
  },
  {
    step: 4,
    name: 'Indexed Extractions',
    phase: 'index-time',
    description:
      'Parses structured formats (JSON, CSV, TSV, PSV, W3C) at index time so field values are stored and searchable without search-time extraction overhead. Note: leading underscores are stripped from field names.',
    directives: ['INDEXED_EXTRACTIONS'],
  },
  {
    step: 5,
    name: 'SEDCMD',
    phase: 'index-time',
    description:
      'Applies sed-style s/pattern/replacement/ substitutions to the raw event text before indexing. Commonly used to mask or remove PII (credit cards, SSNs) before the data is persisted.',
    directives: ['SEDCMD'],
  },
  {
    step: 6,
    name: 'Index-Time Transforms',
    phase: 'index-time',
    description:
      'Applies transforms.conf stanzas referenced by TRANSFORMS directives. Can route events to different indexes, modify metadata fields, or drop events entirely before they are written to disk.',
    directives: ['TRANSFORMS', 'INGEST_EVAL'],
  },
  {
    step: 7,
    name: 'Field Extraction',
    phase: 'search-time',
    description:
      'Applies EXTRACT-<name> regex patterns to _raw, using named capture groups to produce fields. Each EXTRACT takes the first match only; use a REPORT transform with MV_ADD for repeated matches.',
    directives: ['EXTRACT'],
  },
  {
    step: 8,
    name: 'Search-Time Transforms',
    phase: 'search-time',
    description:
      'Applies transforms.conf stanzas referenced by REPORT directives. Uses REGEX + FORMAT to extract fields at search time, with SOURCE_KEY, MV_ADD and DELIMS. DEST_KEY is an index-time setting and has no effect here. Runs before automatic KV extraction, matching Splunk’s documented order.',
    directives: ['REPORT'],
  },
  {
    step: 9,
    name: 'KV Mode',
    phase: 'search-time',
    description:
      'Automatically extracts fields from structured content in _raw. "auto" handles key=value and key="value" pairs; "json" parses embedded JSON objects; "xml" parses XML; "none" disables auto-extraction.',
    directives: ['KV_MODE', 'AUTO_KV_JSON'],
  },
  {
    step: 10,
    name: 'Field Aliases',
    phase: 'search-time',
    description:
      'Creates alternative names for existing fields without copying data. Essential for CIM normalisation — map vendor-specific field names (e.g. src_ip) to CIM names (e.g. src) so CIM-based searches work across sourcetypes.',
    directives: ['FIELDALIAS'],
  },
  {
    step: 11,
    name: 'Eval Expressions',
    phase: 'search-time',
    description:
      'Computes new field values using SPL eval expressions at search time. Supports most of the eval function library, including if(), case(), coalesce(), lower(), tonumber(), strftime() and cidrmatch(); a function that is not simulated produces a warning rather than a silent null.',
    directives: ['EVAL'],
  },
];

export const PHASE_LABELS: Record<PipelineStage['phase'], string> = {
  'index-time': 'Index-Time',
  'search-time': 'Search-Time',
};

/**
 * Inverted index from directive key to the stages it configures, built once.
 *
 * A directive can drive more than one stage in principle, so the value is a
 * list; today every key maps to exactly one.
 */
const stagesByDirective = new Map<string, PipelineStage[]>();
for (const stage of PIPELINE_STAGES) {
  for (const key of stage.directives) {
    const existing = stagesByDirective.get(key);
    if (existing) existing.push(stage);
    else stagesByDirective.set(key, [stage]);
  }
}

/**
 * Stages configured by a directive key. Accepts class-based keys
 * ("EXTRACT-foo") by falling back to the base prefix, since the stage list
 * stores base keys only.
 */
export function getStagesForDirective(key: string): PipelineStage[] {
  const exact = stagesByDirective.get(key);
  if (exact) return exact;
  const dashIndex = key.indexOf('-');
  if (dashIndex > 0) {
    return stagesByDirective.get(key.substring(0, dashIndex)) ?? [];
  }
  return [];
}
