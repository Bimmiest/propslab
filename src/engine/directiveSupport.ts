// ---------------------------------------------------------------------------
// directiveSupport.ts
// What the simulator actually does with each directive, as opposed to what it
// knows about it (#153).
//
// The registry powers autocomplete, hover and linting, so every key in it looks
// supported. For 44 of the 76 it is not: the directive is offered, explained,
// accepted by validation -- and then the preview renders as though it were not
// there. That is a worse failure than not knowing the key at all, because
// nothing on screen contradicts it.
//
// This table is the declared boundary. It lives beside the registry rather than
// inside it so the whole classification can be read in one screen and audited
// against the engine; `directiveRegistry` merges `support` onto every
// `DirectiveInfo`, so consumers never read this file directly.
//
//   simulated  -- the engine implements it and tests assert the behaviour.
//   documented -- recognised on purpose, outside the simulation for a stated
//                 reason that is not going to change (it belongs to a layer a
//                 browser has no access to, or it has no observable effect on
//                 output).
//   ignored    -- should be simulated, is not yet, and names the issue tracking
//                 it. Every entry here is a known wrong answer.
//
// A key absent from this table fails `directiveSupport.test.ts`, so a directive
// cannot be added to the registry without someone deciding which of the three
// it is.
// ---------------------------------------------------------------------------

export type DirectiveSupport = 'simulated' | 'documented' | 'ignored';

export interface SupportEntry {
  support: DirectiveSupport;
  /**
   * Why, in one sentence. Required for everything that is not `simulated`, and
   * used for a caveat on the handful of `simulated` keys that are honoured only
   * in part. Rendered verbatim in the hover, the dictionary and the diagnostic,
   * so it is written for a user rather than for this file.
   */
  note?: string;
  /** Tracking issue number. Required for `ignored`. */
  issue?: number;
}

/**
 * Keyed by directive key. `MATCH_LIMIT` and `DEPTH_LIMIT` exist once per conf
 * file in the registry but carry the same classification in both, so a single
 * entry covers both rows.
 */
export const DIRECTIVE_SUPPORT: Record<string, SupportEntry> = {
  // ---- Time -------------------------------------------------------------
  TIME_PREFIX: { support: 'simulated' },
  TIME_FORMAT: { support: 'simulated' },
  MAX_TIMESTAMP_LOOKAHEAD: { support: 'simulated' },
  TZ: { support: 'simulated' },
  DATETIME_CONFIG: {
    support: 'simulated',
    note:
      'CURRENT and NONE are simulated; both resolve to the moment of simulation, since a browser ' +
      'has no index time. A value naming a datetime.xml file is not applied — that file is not reachable from here.',
  },
  MAX_DAYS_AGO: { support: 'simulated' },
  MAX_DAYS_HENCE: { support: 'simulated' },
  MAX_DIFF_SECS_AGO: { support: 'simulated' },
  MAX_DIFF_SECS_HENCE: { support: 'simulated' },
  TZ_ALIAS: { support: 'simulated' },

  // ---- Event breaking ---------------------------------------------------
  SHOULD_LINEMERGE: { support: 'simulated' },
  BREAK_ONLY_BEFORE: { support: 'simulated' },
  BREAK_ONLY_BEFORE_DATE: { support: 'simulated' },
  MUST_BREAK_AFTER: { support: 'simulated' },
  MUST_NOT_BREAK_BEFORE: {
    support: 'simulated',
    note:
      'Measured inert: three 10.4.0 captures show the documented suppression never happening — ' +
      'date, BREAK_ONLY_BEFORE and MUST_BREAK_AFTER breaks all stand — so the faithful ' +
      'simulation is no effect.',
  },
  MUST_NOT_BREAK_AFTER: {
    support: 'simulated',
    note:
      'After a matching line, rule-driven breaks are suppressed until MUST_BREAK_AFTER matches ' +
      '(pinned by capture); MAX_EVENTS still caps the merge.',
  },
  LINE_BREAKER_LOOKBEHIND: {
    support: 'documented',
    note:
      'Governs how far Splunk looks back across an internal chunk boundary. The simulator holds the ' +
      'whole input in memory and has no chunk boundaries, so there is nothing for it to change.',
  },
  MAX_EVENTS: { support: 'simulated' },
  LINE_BREAKER: { support: 'simulated' },
  TRUNCATE: { support: 'simulated' },
  EVENT_BREAKER: {
    support: 'documented',
    note:
      'Applies on a universal forwarder before data reaches an indexer, which is upstream of ' +
      'everything this tool simulates.',
  },
  EVENT_BREAKER_ENABLE: {
    support: 'documented',
    note: 'Enables forwarder-side breaking, which is upstream of the pipeline simulated here.',
  },

  // ---- Field extraction -------------------------------------------------
  EXTRACT: { support: 'simulated' },
  REPORT: { support: 'simulated' },
  TRANSFORMS: { support: 'simulated' },
  INDEXED_EXTRACTIONS: { support: 'simulated' },
  FIELDALIAS: { support: 'simulated' },
  EVAL: { support: 'simulated' },
  SEDCMD: { support: 'simulated' },
  KV_MODE: { support: 'simulated' },
  AUTO_KV_JSON: { support: 'simulated' },
  REGEX: { support: 'simulated' },
  FORMAT: { support: 'simulated' },
  DELIMS: { support: 'simulated' },
  FIELDS: { support: 'simulated' },
  SOURCE_KEY: { support: 'simulated' },
  DEST_KEY: { support: 'simulated' },
  REPEAT_MATCH: { support: 'simulated' },
  WRITE_META: { support: 'simulated' },
  INGEST_EVAL: { support: 'simulated' },
  MV_ADD: { support: 'simulated' },
  CLEAN_KEYS: { support: 'simulated' },
  KEEP_EMPTY_VALS: { support: 'simulated' },
  DEFAULT_VALUE: { support: 'simulated' },
  LOOKAHEAD: { support: 'simulated' },

  // ---- Structured data (INDEXED_EXTRACTIONS options) --------------------
  // All eleven apply to the delimited formats (csv/tsv/psv). W3C keeps its own
  // #Fields header mechanism, which none of these override there.
  FIELD_DELIMITER: { support: 'simulated' },
  FIELD_QUOTE: { support: 'simulated' },
  FIELD_NAMES: { support: 'simulated' },
  HEADER_FIELD_LINE_NUMBER: { support: 'simulated' },
  PREAMBLE_REGEX: { support: 'simulated' },
  TIMESTAMP_FIELDS: { support: 'simulated' },
  FIELD_HEADER_REGEX: { support: 'simulated' },
  HEADER_FIELD_DELIMITER: { support: 'simulated' },
  HEADER_FIELD_QUOTE: { support: 'simulated' },
  HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS: {
    support: 'simulated',
    note:
      'Header cleaning replaces spaces as well, although the spec wording exempts them; no capture ' +
      'settles it. Naming a space here keeps it.',
  },
  MISSING_VALUE_REGEX: { support: 'simulated' },
  CHECK_FOR_HEADER: {
    support: 'documented',
    note: 'Deprecated by Splunk and superseded by INDEXED_EXTRACTIONS, which is simulated.',
  },

  // ---- Data input / indexer layer ---------------------------------------
  CHARSET: {
    support: 'documented',
    note:
      'Character-set conversion happens as bytes are read off a file or socket; the simulator is ' +
      'handed text that is already decoded.',
  },
  NO_BINARY_CHECK: {
    support: 'documented',
    note: 'Binary-file detection applies to files being monitored, and there are no files here.',
  },
  LEARN_SOURCETYPE: {
    support: 'documented',
    note: 'Sourcetype learning happens at input, before the stanza this tool resolves is chosen.',
  },
  SEGMENTATION: {
    support: 'documented',
    note: 'Controls how the indexer segments terms for search; it does not change event text or fields.',
  },
  ANNOTATE_PUNCT: {
    support: 'simulated',
    note:
      'The signature is pinned by the punct-* captures: alphanumerics dropped, space to _, tab ' +
      'to the letter t, newlines removed, capped at 50 characters.',
  },
  // The stanza-level four (#186). All change which stanza applies rather than
  // what one directive does, so getting one wrong moves every downstream result.
  sourcetype: { support: 'simulated' },
  rename: { support: 'simulated' },
  priority: { support: 'simulated' },
  disabled: { support: 'simulated' },

  // ---- Routing ----------------------------------------------------------
  CLONE_SOURCETYPE: { support: 'simulated' },

  // ---- Performance / optimiser knobs ------------------------------------
  MATCH_LIMIT: {
    support: 'documented',
    note:
      'A PCRE backtracking budget with no equivalent in the browser regex engine; it bounds how hard ' +
      'a match tries, not what a successful match produces.',
  },
  DEPTH_LIMIT: {
    support: 'documented',
    note:
      'A PCRE recursion budget with no equivalent in the browser regex engine; it bounds how hard a ' +
      'match tries, not what a successful match produces.',
  },
  CAN_OPTIMIZE: {
    support: 'documented',
    note: 'Lets the search optimiser skip a transform it can prove is unused; the result is unchanged.',
  },

  // ---- Lookups ----------------------------------------------------------
  // Every lookup attribute is documented rather than ignored: evaluating one
  // needs a lookup table, and there is nowhere in a no-backend browser tool for
  // that table to come from. pipeline.ts already warns per LOOKUP- directive.
  LOOKUP: { support: 'documented', note: 'Lookup tables cannot be evaluated without the table itself.' },
  filename: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  match_type: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  max_matches: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  min_matches: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  default_match: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  case_sensitive_match: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  external_cmd: { support: 'documented', note: 'External lookup scripts cannot run in a browser.' },
  external_type: { support: 'documented', note: 'External lookup scripts cannot run in a browser.' },
  collection: { support: 'documented', note: 'KV store collections are not reachable from a browser.' },
  fields_list: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  batch_index_query: { support: 'documented', note: 'Lookup tables are not evaluated.' },
  time_field: { support: 'documented', note: 'Time-bounded lookups are not evaluated.' },
  time_format: { support: 'documented', note: 'Time-bounded lookups are not evaluated.' },

  // ---- props.conf.spec 10.4.3 completeness (#178) ------------------------
  // Added to the registry so they complete, hover and warn rather than
  // passing unnoticed. Most belong to the input and forwarder layers a
  // browser has no access to; the rest are real gaps and name their issue.
  CHECK_METHOD: { support: 'documented', note: 'A file-input concern: which bytes identify a file as already read. There are no files here.' },
  HEADER_MODE: { support: 'documented', note: 'Belongs to the input layer, which decides whether an inline ***SPLUNK*** directive may rewrite fields.' },
  LB_CHUNK_BREAKER: { support: 'documented', note: 'Deprecated, and governs forwarder-to-indexer chunking over HTTP — a transport this tool has no part in.' },
  LB_CHUNK_BREAKER_TRUNCATE: { support: 'documented', note: 'Bounds an HTTP forwarder chunk, which is a transport concern rather than an event one.' },
  LEARN_MODEL: { support: 'documented', note: 'Controls sourcetype-model learning on disk, which has no analogue in a browser.' },
  MAX_EXPECTED_EVENT_LINES: { support: 'documented', note: 'A memory-allocation hint. It tunes throughput and cannot change output.' },
  'METRIC-SCHEMA-TRANSFORMS': { support: 'documented', note: 'Converts events into metrics, and metrics are outside what this tool previews.' },
  METRICS_PROTOCOL: { support: 'documented', note: 'Declares the source to be metrics rather than events. This simulator models the event pipeline.' },
  PREFIX_SOURCETYPE: { support: 'documented', note: 'Names files the classifier found too small to classify, which requires the input layer.' },
  SOURCETYPE_NAME_RESTRICTED_CHARACTERS: { support: 'documented', note: 'Constrains sourcetype naming at input time; it does not change how an event is processed.' },
  'STATSD-DIM-TRANSFORMS': { support: 'documented', note: 'Extracts dimensions from statsd metrics, which are outside the event pipeline modelled here.' },
  STATSD_EMIT_SINGLE_MEASUREMENT_FORMAT: { support: 'documented', note: 'Shapes metric data points, not events.' },
  category: { support: 'documented', note: 'Sourcetype metadata for the Splunk UI, with no effect on events or fields.' },
  description: { support: 'documented', note: 'Sourcetype metadata for the Splunk UI, with no effect on events or fields.' },
  detect_trailing_nulls: { support: 'documented', note: 'Decided at input time while reading a file from disk, which this tool does not do.' },
  force_local_processing: { support: 'documented', note: 'Moves processing onto a universal forwarder. Where the work happens is not modelled here.' },
  initCrcLength: { support: 'documented', note: 'Part of file identity for the monitor input, upstream of anything this tool sees.' },
  invalid_cause: { support: 'documented', note: 'Hands a file to the archive or Event Log processor at input time, before any of this runs.' },
  is_valid: { support: 'documented', note: 'Set automatically by invalid_cause, and the spec says plainly not to set it.' },
  maxDist: { support: 'documented', note: 'Tunes sourcetype model matching, a classification step upstream of the pipeline simulated here.' },
  termFrequencyWeightedDist: { support: 'documented', note: 'Changes how file distance is measured for sourcetype classification, upstream of this tool.' },
  trackPipelineLatency: { support: 'documented', note: 'Emits latency metrics to metrics.log. It observes processing rather than changing it.' },
  unarchive_cmd: { support: 'documented', note: 'Runs a shell command to expand an archive at input time. There is no shell and no archive here.' },
  unarchive_cmd_start_mode: { support: 'documented', note: 'Chooses how the unarchive command is launched, which this tool never launches.' },
  unarchive_sourcetype: { support: 'documented', note: 'Names the sourcetype for the contents of an expanded archive, an input-layer decision.' },
  XML_INDEXED_EXTRACTIONS_PIPELINE: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_INCLUDE: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_INCLUDE_MV: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_EXCLUDE: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_EXCLUDE_MV: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_EXCLUDE_VALS: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_SKIP_XML_ENCODED_VALS: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  XML_IE_MAX_EXTRACTED_VALUE_SIZE: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  extraction_cutoff: { support: 'ignored', issue: 271, note: 'XML index-time extraction is not simulated at all, so this has no effect on the preview.' },
  ADD_EXTRA_TIME_FIELDS: {
    support: 'simulated',
    note:
      'The field values follow the documented conventions; no capture recorded them. Only an event whose ' +
      'timestamp was read from its text gets date_*; the rest get timestamp=none.',
  },
  DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME: {
    support: 'simulated',
    note: 'Only a TIME_FORMAT can describe a dateless timestamp here — automatic recognition has no time-only pattern.',
  },
  KV_TRIM_SPACES: { support: 'simulated' },
  JSON_TRIM_BRACES_IN_ARRAY_NAMES: {
    support: 'simulated',
    note: 'Applies to INDEXED_EXTRACTIONS = json only, as the spec scopes it; KV_MODE = json keeps the braces, as spath does.',
  },
  RULESET: {
    support: 'simulated',
    note:
      'Applied after every TRANSFORMS- class, in class order. Splunk also runs rulesets on a heavy ' +
      'forwarder as well as the indexer; the preview is one pipeline and shows them run once.',
  },
  RULESET_DESC: { support: 'documented', note: 'A description of the matching RULESET- for the next reader. Splunk does nothing with it, and neither does the preview.' },
  ROUTE_EVENTS_OLDER_THAN: {
    support: 'simulated',
    note:
      'Age is measured from the moment of simulation, and a bare number is read as seconds. The ' +
      'route is a nullQueue queue write, so a later transform writing the queue can still override it.',
  },
  OPTIMIZE_IE_EXTRACT: {
    support: 'documented',
    note:
      'A search performance optimisation keyed on the fields a particular search asks for. The preview runs ' +
      'no search, and used as documented it skips only work whose fields index time already produced.',
  },

  // ---- transforms.conf.spec 10.4.3 completeness (#178) --------------------
  // Mostly lookup settings, documented for the reason every lookup attribute
  // is: a lookup needs a table, and a browser with no backend has none. The
  // metrics settings describe the metrics pipeline, not the event pipeline.
  'METRIC-SCHEMA-BLACKLIST-DIMS': { support: 'documented', note: 'Selects dimensions for generated metrics, not fields on an event.' },
  'METRIC-SCHEMA-MEASURES': { support: 'documented', note: 'Turns events into metrics, which this tool does not preview.' },
  'METRIC-SCHEMA-WHITELIST-DIMS': { support: 'documented', note: 'Selects dimensions for generated metrics, not fields on an event.' },
  REMOVE_DIMS_FROM_METRIC_NAME: { support: 'documented', note: 'Shapes statsd metric names, and metrics are outside the event pipeline modelled here.' },
  allow_caching: { support: 'documented', note: 'Caches scripted-lookup output, and this tool runs no lookup scripts.' },
  cache_size: { support: 'documented', note: 'Sizes the lookup cache, and there is no lookup to cache here.' },
  check_permission: { support: 'documented', note: 'Guards writes to a CSV lookup file, which this tool never performs.' },
  feature_id_element: { support: 'documented', note: 'A geospatial lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  filter: { support: 'documented', note: 'Narrows lookup rows before they are returned, and there are no rows here.' },
  index_fields_list: { support: 'documented', note: 'A lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  max_duplicates: { support: 'documented', note: 'A lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  max_ext_batch: { support: 'documented', note: 'A KV Store lookup setting, and there is no KV Store here.' },
  max_offset_secs: { support: 'documented', note: 'A temporal lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  'metrics.disabled': { support: 'documented', note: 'Controls reporting to metrics.log. It observes processing rather than changing it.' },
  'metrics.report_interval': { support: 'documented', note: 'Sets how often metrics.log is written, which has no bearing on an event.' },
  'metrics.rule_filter': { support: 'documented', note: 'Limits which rules report to metrics.log; it changes no output.' },
  min_offset_secs: { support: 'documented', note: 'A temporal lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  'python.required': { support: 'documented', note: 'Selects the interpreter for a scripted lookup, which this tool cannot run.' },
  'python.version': { support: 'documented', note: 'Deprecated, and it selects the interpreter for a scripted lookup this tool cannot run.' },
  replicate: { support: 'documented', note: 'Decides where a CSV lookup is replicated, which is a deployment concern.' },
  reverse_lookup_honor_case_sensitive_match: { support: 'documented', note: 'A lookup setting, and a lookup needs a table this tool has nowhere to get.' },
  CAN_OPTIMIZE_IE: {
    support: 'documented',
    note:
      'A search performance optimisation keyed on the fields a particular search asks for. The preview runs ' +
      'no search, and used as documented it skips only work whose fields index time already produced.',
  },
  STOP_PROCESSING_IF: {
    support: 'simulated',
    note:
      'When true, skips the rules after it in the same RULESET- or TRANSFORMS- list; later lists still run.',
  },
};

/**
 * Valid props.conf / transforms.conf attributes the registry has never heard
 * of. **Empty as of #178**, and that is the point rather than an accident.
 *
 * The table above classifies everything the registry knows. It cannot classify
 * what it has never heard of, and `pipeline.ts` reads a missing entry as
 * "honoured" -- so an attribute in neither place produced no warning anywhere
 * and the preview ignored the line in silence. That is the failure #153 exists
 * to prevent, reached by a different route: not a directive we decided not to
 * simulate, but one we never knew to decide about.
 *
 * #178 closed the gap by registering every attribute in `props.conf.spec` and
 * `transforms.conf.spec` for Splunk 10.4.3. This set stays because the next
 * Splunk release will add attributes, and a name parked here is what stops the
 * first person to write one getting silence.
 *
 * Names only, deliberately. Value types, defaults and valid values are
 * structural facts belonging to Splunk's `.spec` files; a half-remembered
 * default committed here would be exactly the kind of confident wrong answer
 * the fidelity corpus was built to catch. Naming a directive is enough to stop
 * claiming it works -- classify it properly in the registry when the facts are
 * to hand.
 */
export const UNDOCUMENTED_ATTRIBUTES: ReadonlySet<string> = new Set([]);

/**
 * Whether a key is a real Splunk attribute this repository has not documented.
 * Distinguishes "we don't simulate that" from "that isn't a thing", which are
 * different pieces of advice and were previously both delivered as the second.
 */
export function isUndocumentedAttribute(key: string): boolean {
  return UNDOCUMENTED_ATTRIBUTES.has(key);
}

/** The classification for a directive key, or undefined if it is unclassified. */
export function getDirectiveSupport(key: string): SupportEntry | undefined {
  return DIRECTIVE_SUPPORT[key];
}

/**
 * Whether a directive the user has written will be honoured by the preview.
 *
 * A key that is neither classified nor a known-undocumented attribute counts as
 * honoured: at that point it is a typo rather than a gap, which is a different
 * problem with its own diagnostic, and answering "not simulated" would be
 * misleading advice about a directive that does not exist.
 */
export function isSimulated(key: string): boolean {
  if (UNDOCUMENTED_ATTRIBUTES.has(key)) return false;
  return (DIRECTIVE_SUPPORT[key]?.support ?? 'simulated') === 'simulated';
}
