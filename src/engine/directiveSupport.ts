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
  // All six apply to the delimited formats (csv/tsv/psv). W3C keeps its own
  // #Fields header mechanism, which none of these override there.
  FIELD_DELIMITER: { support: 'simulated' },
  FIELD_QUOTE: { support: 'simulated' },
  FIELD_NAMES: { support: 'simulated' },
  HEADER_FIELD_LINE_NUMBER: { support: 'simulated' },
  PREAMBLE_REGEX: { support: 'simulated' },
  TIMESTAMP_FIELDS: { support: 'simulated' },
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
};

/**
 * Valid props.conf / transforms.conf attributes that this repository does not
 * document yet (#178).
 *
 * The table above classifies everything the registry knows. It cannot classify
 * what the registry has never heard of, and `pipeline.ts` reads a missing entry
 * as "honoured" -- so until #178 lands, writing one of these produced no
 * warning anywhere and the preview ignored the line in silence. That is the
 * failure #153 exists to prevent, reached by a different route: not a directive
 * we decided not to simulate, but one we never knew to decide about.
 *
 * Names only, deliberately. Value types, defaults and valid values are
 * structural facts belonging to Splunk's `.spec` files, and #178 generates them
 * from the spec rather than having anyone recall them -- a half-remembered
 * default committed here would be exactly the kind of confident wrong answer
 * the fidelity corpus was built to catch. Naming a directive is enough to stop
 * claiming it works.
 *
 * These are the 91 attributes in the Splunk 10.4.0 spec files minus the ones
 * the registry documents. Generating this list, rather than maintaining it by
 * hand, is the rest of #178.
 */
export const UNDOCUMENTED_ATTRIBUTES: ReadonlySet<string> = new Set([
  'ADD_EXTRA_TIME_FIELDS',
  'CAN_OPTIMIZE_IE',
  'CHECK_METHOD',
  'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME',
  'FIELD_HEADER_REGEX',
  'HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS',
  'HEADER_FIELD_DELIMITER',
  'HEADER_FIELD_QUOTE',
  'HEADER_MODE',
  'JSON_TRIM_BRACES_IN_ARRAY_NAMES',
  'KV_TRIM_SPACES',
  'LB_CHUNK_BREAKER',
  'LB_CHUNK_BREAKER_TRUNCATE',
  'LEARN_MODEL',
  'MAX_EXPECTED_EVENT_LINES',
  'METRICS_PROTOCOL',
  'MISSING_VALUE_REGEX',
  'OPTIMIZE_IE_EXTRACT',
  'PREFIX_SOURCETYPE',
  'REMOVE_DIMS_FROM_METRIC_NAME',
  'ROUTE_EVENTS_OLDER_THAN',
  'RULESET',
  'RULESET_DESC',
  'SOURCETYPE_NAME_RESTRICTED_CHARACTERS',
  'STATSD_EMIT_SINGLE_MEASUREMENT_FORMAT',
  'STOP_PROCESSING_IF',
  'XML_IE_EXCLUDE',
  'XML_IE_INCLUDE',
  'XML_INDEXED_EXTRACTIONS_PIPELINE',
]);

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
