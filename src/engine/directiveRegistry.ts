// ---------------------------------------------------------------------------
// directiveRegistry.ts
// Comprehensive registry of Splunk props.conf and transforms.conf directives.
// Powers autocomplete, hover tooltips, linting, and validation features.
//
// Knowing a directive is not the same as simulating it. Every entry here also
// carries a `support` level from `directiveSupport.ts`, which is the declared
// boundary of what the preview actually honours (#153).
// ---------------------------------------------------------------------------

import { getDirectiveSupport, type DirectiveSupport } from './directiveSupport';

export interface DirectiveInfo {
  key: string;
  description: string;
  example: string;
  defaultValue: string;
  category: string;
  appliesTo: 'props.conf' | 'transforms.conf' | 'both';
  valueType: 'regex' | 'string' | 'number' | 'boolean' | 'enum' | 'strftime' | 'eval';
  enumValues?: string[];
  isClassBased: boolean;
  phase: 'index-time' | 'search-time' | 'both';
  deprecated?: boolean;
  /**
   * What the simulator does with this directive, as opposed to what it knows
   * about it (#153). Attached from `directiveSupport.ts` rather than written on
   * each entry, so the whole boundary can be read in one place.
   */
  support: DirectiveSupport;
  /** Why it is not simulated, or the caveat on one that only partly is. */
  supportNote?: string;
  /** Tracking issue, for `ignored`. */
  supportIssue?: number;
}

/** The literal entries below, before support classification is attached. */
type DirectiveDefinition = Omit<DirectiveInfo, 'support' | 'supportNote' | 'supportIssue'>;

// ---------------------------------------------------------------------------
// Directive definitions
// ---------------------------------------------------------------------------

const DIRECTIVE_DEFINITIONS: DirectiveDefinition[] = [
  // =======================================================================
  // props.conf -- Time Configuration
  // =======================================================================
  {
    key: 'TIME_PREFIX',
    description:
      'A regex that identifies a pattern immediately before the timestamp in the event text. ' +
      'Splunk starts looking for the timestamp immediately after the first match of this regex. ' +
      'If TIME_PREFIX cannot be found, the timestamp will not be extracted.',
    example: 'TIME_PREFIX = \\d{4}-\\d{2}-\\d{2}T',
    defaultValue: '',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'TIME_FORMAT',
    description:
      'A strftime-style format string that describes the timestamp format in the event. ' +
      'Splunk uses this format to parse the timestamp from the event text after applying TIME_PREFIX. ' +
      'Common tokens include %Y (4-digit year), %m (month), %d (day), %H (hour), %M (minute), %S (second), %3N (milliseconds), %6N (microseconds), %z (timezone offset).',
    example: 'TIME_FORMAT = %Y-%m-%dT%H:%M:%S.%6N%z',
    defaultValue: '',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'strftime',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_TIMESTAMP_LOOKAHEAD',
    description:
      'How far past the TIME_PREFIX match the timestamp scan is allowed to reach, counted in characters. ' +
      'A window that ends before the timestamp does means no timestamp is found at all; an over-wide one ' +
      'invites a false match on digits elsewhere in the line. 0 or -1 disables the limit, so the scan reaches the end of the event.',
    example: 'MAX_TIMESTAMP_LOOKAHEAD = 128',
    defaultValue: '128',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'TZ',
    description:
      'The timezone to apply to timestamps that do not include timezone information. ' +
      'Accepts IANA/Olson identifiers (e.g. "America/New_York"), numeric offsets (+0530, -05:00) and a small table of abbreviations (UTC, GMT, EST/EDT, CST/CDT, MST/MDT, PST/PDT, IST, CET/CEST, JST, AEST/AEDT, NZST/NZDT). An IANA name is resolved through the browser\'s own time-zone data, so the offset applied is the one that was in force on the event\'s date, DST included. A name the runtime does not recognise is treated as UTC and warned about. ' +
      'If not set, Splunk uses the timezone of the server where the data was indexed.',
    example: 'TZ = America/Los_Angeles',
    defaultValue: '',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'DATETIME_CONFIG',
    description:
      'The path to the datetime configuration file that Splunk uses for automatic timestamp recognition. ' +
      'Set to CURRENT to use the event\'s receipt time as its timestamp. ' +
      'Set to NONE to disable automatic timestamp parsing entirely.',
    example: 'DATETIME_CONFIG = CURRENT',
    defaultValue: '/etc/datetime.xml',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_DAYS_AGO',
    description:
      'The maximum number of days in the past that an extracted timestamp is considered valid. ' +
      'If a parsed timestamp is more than this many days before the current date, Splunk rejects it and falls back to other timestamp strategies.',
    example: 'MAX_DAYS_AGO = 2000',
    defaultValue: '2000',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_DAYS_HENCE',
    description:
      'The maximum number of days in the future that an extracted timestamp is considered valid. ' +
      'If a parsed timestamp is more than this many days after the current date, Splunk rejects it.',
    example: 'MAX_DAYS_HENCE = 2',
    defaultValue: '2',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_DIFF_SECS_AGO',
    description:
      'The maximum number of seconds that a timestamp from an event can differ (into the past) from the timestamp of the previous event. ' +
      'Beyond it, Splunk accepts the parsed timestamp only if it has the same exact time format as the majority of timestamps from the source, ' +
      'so out-of-order lines in one consistent format keep their own times while a stray date of another shape in the event text is rejected. ' +
      'The simulator judges "majority" over the events accepted earlier in the same sample.',
    example: 'MAX_DIFF_SECS_AGO = 86400',
    defaultValue: '3600',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_DIFF_SECS_HENCE',
    description:
      'The maximum number of seconds that a timestamp from an event can differ (into the future) from the timestamp of the previous event. ' +
      'Beyond it, Splunk accepts the parsed timestamp only if it has the same exact time format as the majority of timestamps from the source. ' +
      'The simulator judges "majority" over the events accepted earlier in the same sample.',
    example: 'MAX_DIFF_SECS_HENCE = 604800',
    defaultValue: '604800',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },

  // =======================================================================
  // props.conf -- Event / Line Breaking
  // =======================================================================
  {
    key: 'SHOULD_LINEMERGE',
    description:
      'Controls whether Splunk combines multiple lines from the input into a single event. ' +
      'When true, Splunk uses BREAK_ONLY_BEFORE, MUST_BREAK_AFTER, and related settings to determine where events end. ' +
      'Set to false when LINE_BREAKER alone is sufficient to delineate events.',
    example: 'SHOULD_LINEMERGE = false',
    defaultValue: 'true',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'BREAK_ONLY_BEFORE',
    description:
      'A regex pattern that, when matched at the start of a line, causes Splunk to start a new event. ' +
      'Requires SHOULD_LINEMERGE = true. Lines that match this pattern begin a new event; ' +
      'preceding lines are appended to the previous event.',
    example: 'BREAK_ONLY_BEFORE = ^\\d{4}-\\d{2}-\\d{2}',
    defaultValue: '',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'BREAK_ONLY_BEFORE_DATE',
    description:
      'When set to true, Splunk starts a new event only when it encounters a line that begins with a date or timestamp pattern. ' +
      'Requires SHOULD_LINEMERGE = true. This is a convenience alternative to specifying a BREAK_ONLY_BEFORE regex.',
    example: 'BREAK_ONLY_BEFORE_DATE = true',
    defaultValue: 'true',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MUST_BREAK_AFTER',
    description:
      'A regex pattern that, when matched in a line, forces the current event to end after that line. ' +
      'Requires SHOULD_LINEMERGE = true. The next line begins a new event.',
    example: 'MUST_BREAK_AFTER = </event>',
    defaultValue: '',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MUST_NOT_BREAK_BEFORE',
    description:
      'Documented as preventing an event break before a line matching the regex. Measured against ' +
      'Splunk 10.4.0, the suppression never happens: breaks driven by BREAK_ONLY_BEFORE_DATE, ' +
      'BREAK_ONLY_BEFORE and MUST_BREAK_AFTER all stand with this set (three captures). The ' +
      'simulator mirrors the measured behaviour, so the setting has no effect here either. For a ' +
      'no-break span that does work, see MUST_NOT_BREAK_AFTER.',
    example: 'MUST_NOT_BREAK_BEFORE = ^\\s+at ',
    defaultValue: '',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MUST_NOT_BREAK_AFTER',
    description:
      'A regex that starts a no-break span: after a line matching it, rule-driven breaks are ' +
      'suppressed until a line matches MUST_BREAK_AFTER, so the span merges into one event ' +
      '(MAX_EVENTS still caps it). Requires SHOULD_LINEMERGE = true. Without a MUST_BREAK_AFTER ' +
      'to end the span, the suppression runs to the end of the input.',
    example: 'MUST_NOT_BREAK_AFTER = \\\\$',
    defaultValue: '',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'LINE_BREAKER_LOOKBEHIND',
    description:
      'How many characters before the end of the previous chunk Splunk looks back when applying ' +
      'LINE_BREAKER across a chunk boundary. Raise it when events are large enough that a break ' +
      'pattern can straddle the boundary and be missed.',
    example: 'LINE_BREAKER_LOOKBEHIND = 100',
    defaultValue: '100',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_EVENTS',
    description:
      'A ceiling on how many lines one merged event may contain, applied when SHOULD_LINEMERGE is on. ' +
      'Once that many have accumulated the event ends, whether or not a break rule fired — which is what ' +
      'stops a log with no date-like lines from merging into one enormous event.',
    example: 'MAX_EVENTS = 256',
    defaultValue: '256',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'LINE_BREAKER',
    description:
      'A regex with a capturing group that determines where event boundaries occur in the raw data stream. ' +
      'The text matched by the capturing group is consumed as the event break; ' +
      'everything before becomes one event and everything after starts the next. ' +
      'The default value breaks on newlines.',
    example: 'LINE_BREAKER = ([\\r\\n]+)\\d{4}-\\d{2}-\\d{2}',
    defaultValue: '([\\r\\n]+)',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'TRUNCATE',
    description:
      'The maximum number of bytes that an event can contain. Any content beyond this limit is truncated. ' +
      'Set to 0 to disable truncation entirely (not recommended for production).',
    example: 'TRUNCATE = 50000',
    defaultValue: '10000',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'EVENT_BREAKER_ENABLE',
    description:
      'Enables the event breaker on a universal forwarder so it can split a data stream into ' +
      'individual events before sending them to indexers. ' +
      'When true, Splunk uses EVENT_BREAKER to determine boundaries. ' +
      'This improves load balancing by ensuring events are not split across indexers. ' +
      '(Applies to forwarder event breaking, not HEC.)',
    example: 'EVENT_BREAKER_ENABLE = true',
    defaultValue: 'false',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'EVENT_BREAKER',
    description:
      'A regex with a capturing group that determines event boundaries on the forwarder before data is sent to the indexer. ' +
      'Requires EVENT_BREAKER_ENABLE = true. Works similarly to LINE_BREAKER but is applied on the forwarder.',
    example: 'EVENT_BREAKER = ([\\r\\n]+)(?=\\d{4}-\\d{2}-\\d{2})',
    defaultValue: '([\\r\\n]+)',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },

  // =======================================================================
  // props.conf -- Field Extraction
  // =======================================================================
  {
    key: 'EXTRACT',
    description:
      'Defines an inline regular expression for field extraction at search time. ' +
      'Uses named capturing groups (?P<fieldname>...) to extract fields directly in props.conf. ' +
      'The class name following the dash identifies this extraction uniquely.',
    example: 'EXTRACT-ip_address = (?P<src_ip>\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3})',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: true,
    phase: 'search-time',
  },
  {
    key: 'REPORT',
    description:
      'References one or more transforms stanza names (comma-separated) defined in transforms.conf for search-time field extraction. ' +
      'Each referenced stanza should contain a REGEX and FORMAT directive. ' +
      'The class name following the dash identifies this extraction set.',
    example: 'REPORT-custom_fields = extract_user, extract_action',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'search-time',
  },
  {
    key: 'TRANSFORMS',
    description:
      'References one or more transforms stanza names (comma-separated) defined in transforms.conf for index-time field extraction. ' +
      'Used for routing, filtering, or modifying events before they are indexed. ' +
      'Unlike REPORT, TRANSFORMS operations happen at index time.',
    example: 'TRANSFORMS-routing = set_index_by_severity',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'index-time',
  },
  {
    key: 'INDEXED_EXTRACTIONS',
    description:
      'Specifies structured data format for automatic field extraction at index time. ' +
      'Splunk will parse the data according to the chosen format and create indexed fields. ' +
      'Valid values are csv, tsv, psv, w3c, json, hec, xml, xmlkv and xmlkv-winevt. ' +
      'Note: this simulator models csv, tsv, psv, w3c and json; the xml family and hec ' +
      'are accepted as valid config but not simulated.',
    example: 'INDEXED_EXTRACTIONS = json',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'enum',
    // The xml family is valid Splunk config; omitting it made completion and lint
    // falsely reject a working directive.
    enumValues: ['csv', 'tsv', 'psv', 'w3c', 'json', 'hec', 'xml', 'xmlkv', 'xmlkv-winevt'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'FIELDALIAS',
    description:
      'Creates an alias for an existing field at search time. ' +
      'Allows you to reference the same field value by an alternative name without duplicating the data. ' +
      'Syntax is FIELDALIAS-<class> = <original_field> AS <alias_field>. Multiple aliases can be comma-separated.',
    example: 'FIELDALIAS-src = src_ip AS src',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'search-time',
  },
  {
    key: 'EVAL',
    description:
      'Creates a calculated field at search time using an eval expression. ' +
      'The class name after the dash becomes the output field name. ' +
      'The value is a valid Splunk eval expression that can reference other fields.',
    example: 'EVAL-duration_seconds = duration / 1000',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'eval',
    isClassBased: true,
    phase: 'search-time',
  },
  {
    key: 'SEDCMD',
    description:
      'Applies sed-style substitution commands to the raw event text at index time, before other processing. ' +
      'Useful for anonymizing or masking sensitive data such as credit card numbers, SSNs, or passwords. ' +
      'Syntax follows the sed s/regex/replacement/flags format.',
    example: 'SEDCMD-anonymize_ssn = s/\\d{3}-\\d{2}-\\d{4}/XXX-XX-XXXX/g',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'index-time',
  },
  {
    key: 'KV_MODE',
    description:
      'Controls the automatic key-value pair extraction mode at search time. ' +
      '"auto" extracts key=value pairs (and JSON, when AUTO_KV_JSON is true). ' +
      '"auto_escaped" is like "auto" but honours backslash-escaped quotes in values. ' +
      '"none" disables automatic extraction. "json" extracts only JSON fields. ' +
      '"xml" extracts only XML fields. "multi" extracts from tabular (multikv) events.',
    example: 'KV_MODE = json',
    defaultValue: 'auto',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['auto', 'auto_escaped', 'none', 'json', 'xml', 'multi'],
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'AUTO_KV_JSON',
    description:
      'When KV_MODE is "auto" or "auto_escaped", controls whether JSON-formatted events ' +
      'are automatically field-extracted. Defaults to true.',
    example: 'AUTO_KV_JSON = true',
    defaultValue: 'true',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },

  // =======================================================================
  // props.conf -- Other
  // =======================================================================
  {
    key: 'CHARSET',
    description:
      'The character encoding of the input data. Splunk uses this to correctly decode the raw bytes into text. ' +
      'Common values include UTF-8, UTF-16LE, UTF-16BE, LATIN-1, and AUTO. ' +
      'When set to AUTO, Splunk attempts to detect the encoding automatically. ' +
      'The default is UTF-8 on *nix and AUTO on Windows.',
    example: 'CHARSET = UTF-8',
    defaultValue: 'UTF-8',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'ANNOTATE_PUNCT',
    description:
      'Controls whether Splunk creates the punct:: field, which contains a punctuation signature of the event. ' +
      'The punct field is used for event pattern detection and similarity analysis. ' +
      'Disabling this can slightly improve indexing performance.',
    example: 'ANNOTATE_PUNCT = false',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MATCH_LIMIT',
    description:
      'The maximum number of match attempts the PCRE regex engine makes before aborting (props.conf context). ' +
      'Applies to regex-based field extractions. Increase this when complex regexes time out on long events. ' +
      'Setting to 0 means unlimited (may cause performance issues).',
    example: 'MATCH_LIMIT = 500000',
    defaultValue: '100000',
    category: 'Performance',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'DEPTH_LIMIT',
    description:
      'The maximum recursion depth for the PCRE regex engine (props.conf context). ' +
      'Complex regex patterns with nested groups may hit this limit. ' +
      'Increase when field extractions fail silently on deeply nested patterns.',
    example: 'DEPTH_LIMIT = 5000',
    defaultValue: '1000',
    category: 'Performance',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'LEARN_SOURCETYPE',
    description:
      'Controls whether Splunk attempts to learn and classify the sourcetype of incoming data automatically. ' +
      'When set to true, Splunk uses its sourcetype detection algorithm to categorize data. ' +
      'Set to false when you want to enforce explicit sourcetype assignments.',
    example: 'LEARN_SOURCETYPE = false',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'SEGMENTATION',
    description:
      'Specifies the segmentation rule to use for indexing the event text. ' +
      'Segmentation determines how event text is tokenized for efficient searching. ' +
      'The value names a stanza in segmenters.conf; the shipped rules are ' +
      '"inner", "outer", "full", "none" and the default "indexing".',
    example: 'SEGMENTATION = inner',
    defaultValue: 'indexing',
    category: 'Data Input',
    appliesTo: 'props.conf',
    // Modelled as an enum so completion offers the shipped rules and a typo is
    // flagged, as it is for KV_MODE / INDEXED_EXTRACTIONS. `indexing` is listed
    // because it IS the default — the previous description enumerated four
    // values that excluded its own defaultValue.
    valueType: 'enum',
    enumValues: ['indexing', 'inner', 'outer', 'full', 'none'],
    isClassBased: false,
    phase: 'index-time',
  },

  // =======================================================================
  // props.conf -- Lookup
  // =======================================================================
  {
    key: 'LOOKUP',
    description:
      'Defines an automatic lookup that runs at search time for events matching this stanza. ' +
      'References a lookup table (transforms stanza or lookup definition) and specifies how to ' +
      'join fields from the event with fields from the lookup table. The class name identifies the lookup.',
    example: 'LOOKUP-user_info = user_lookup user_id OUTPUT user_name, department',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'search-time',
  },

  // =======================================================================
  // transforms.conf -- Field Extraction
  // =======================================================================
  {
    key: 'REGEX',
    description:
      'A PCRE regular expression used to extract fields from the event data. ' +
      'Must contain at least one named capturing group (?P<fieldname>...) or be paired with a FORMAT directive ' +
      'that maps numbered capturing groups ($1, $2, ...) to field names.',
    example: 'REGEX = (?P<src_ip>\\d+\\.\\d+\\.\\d+\\.\\d+)\\s+(?P<action>\\w+)',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'FORMAT',
    description:
      'Specifies how to map captured groups from the REGEX to field-value pairs. ' +
      'Uses $1, $2, etc. to reference numbered capturing groups. ' +
      'Syntax is field_name::$capture_group or $capture_group for indexed field routing. ' +
      'With DEST_KEY = MetaData:Host/Source/Sourcetype the value needs the host::, source:: or ' +
      'sourcetype:: prefix; with DEST_KEY = _MetaData:Index it is the bare index name.',
    example: 'FORMAT = src_ip::$1 action::$2',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'DELIMS',
    description:
      'Delimiter-based field extraction, used in place of REGEX. Each character in a ' +
      'quoted set is treated as a separate delimiter. Provide two quoted sets for ' +
      'field/value pairs (first set splits pairs, second splits field name from value), ' +
      'or one set plus FIELDS to name positional values. Escapes: \\t \\n \\r \\\\ \\".',
    example: 'DELIMS = "|", "="',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'FIELDS',
    description:
      'Used with a single-set DELIMS (values only, no field names) to assign field ' +
      'names to the extracted values positionally, in the order they are extracted.',
    example: 'FIELDS = "user", "action", "status"',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'SOURCE_KEY',
    description:
      'Specifies the field from which the REGEX extracts values. ' +
      'By default, REGEX runs against _raw. Set this to run the regex against a different field. ' +
      'Special values include MetaData:Source, MetaData:Host, and MetaData:Sourcetype.',
    example: 'SOURCE_KEY = MetaData:Source',
    defaultValue: '_raw',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'DEST_KEY',
    description:
      'Specifies the field where the result of the REGEX/FORMAT transformation is written. ' +
      'Commonly used for index-time transforms such as routing events. ' +
      'Special values include queue (for routing), MetaData:Index, MetaData:Host, MetaData:Source, and MetaData:Sourcetype. ' +
      'For MetaData:Host/Source/Sourcetype, FORMAT must carry the host::, source:: or sourcetype:: prefix; ' +
      'for _MetaData:Index, FORMAT is the bare index name (FORMAT = my_index).',
    example: 'DEST_KEY = MetaData:Index',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'REPEAT_MATCH',
    description:
      'When true, re-runs the REGEX repeatedly across the source text (starting where ' +
      'the previous match ended) to extract every occurrence, rather than stopping at ' +
      'the first match. Combine with MV_ADD to build multivalue fields. Default: false.',
    example: 'REPEAT_MATCH = true',
    defaultValue: 'false',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'WRITE_META',
    description:
      'When set to true, writes the extracted fields into the _meta field of the event at index time. ' +
      'This allows the extracted fields to be stored as indexed fields (metadata) that are available ' +
      'for search without needing search-time extraction.',
    example: 'WRITE_META = true',
    defaultValue: 'false',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'INGEST_EVAL',
    description:
      'An eval expression that runs at index time (ingest) to create or modify fields. ' +
      'This is a powerful mechanism for computing fields before data is written to the index. ' +
      'Multiple expressions can be separated by commas.',
    example: 'INGEST_EVAL = vendor=upper(vendor), index=if(severity>7,"critical","main")',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'eval',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'CLONE_SOURCETYPE',
    description:
      'Creates a copy of each event and assigns the specified sourcetype to the clone. ' +
      'The original event keeps its original sourcetype. ' +
      'Used in conjunction with REGEX to selectively clone events that match a pattern.',
    example: 'CLONE_SOURCETYPE = cloned_security_event',
    defaultValue: '',
    category: 'Event Routing',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },

  // =======================================================================
  // transforms.conf -- Performance
  // =======================================================================
  {
    key: 'MATCH_LIMIT',
    description:
      'The maximum number of match attempts the PCRE regex engine makes before aborting (transforms.conf context). ' +
      'Applies specifically to the REGEX defined in this transforms stanza. ' +
      'Useful for preventing runaway regex operations on large events.',
    example: 'MATCH_LIMIT = 500000',
    defaultValue: '100000',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'DEPTH_LIMIT',
    description:
      'The maximum recursion depth for the PCRE regex engine (transforms.conf context). ' +
      'Controls how deep PCRE recurses when evaluating complex patterns with nested groups. ' +
      'Increase if your regex fails silently on valid data.',
    example: 'DEPTH_LIMIT = 5000',
    defaultValue: '1000',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'both',
  },

  // =======================================================================
  // transforms.conf -- Lookup
  // =======================================================================
  {
    key: 'filename',
    description:
      'The name of the CSV lookup file located in $SPLUNK_HOME/etc/apps/<app>/lookups/. ' +
      'This file provides the lookup table data for the transforms stanza. ' +
      'Must be a valid CSV file with a header row defining field names.',
    example: 'filename = ip_reputation.csv',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'match_type',
    description:
      'Specifies the matching algorithm for one or more lookup fields. ' +
      'Supported types include EXACT (default), WILDCARD (supports * patterns), and CIDR (for IP subnet matching). ' +
      'Syntax: match_type = WILDCARD(field1), CIDR(field2).',
    example: 'match_type = WILDCARD(src_host), CIDR(src_ip)',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'max_matches',
    description:
      'The maximum number of matching rows from the lookup table that can be returned per event. ' +
      'When a lookup matches multiple rows, this caps how many are returned. ' +
      'Default is 100 for non-temporal lookups (1 for time-bounded lookups). Set to 1 for single-value lookups.',
    example: 'max_matches = 5',
    defaultValue: '100',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'min_matches',
    description:
      'The minimum number of matches required from the lookup table for results to be returned. ' +
      'If fewer matches are found, the default_match value is used instead. ' +
      'Useful for ensuring a minimum quality threshold for lookup results.',
    example: 'min_matches = 1',
    defaultValue: '0',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'default_match',
    description:
      'The default value returned when a lookup finds no matches or fewer matches than min_matches. ' +
      'Ensures that lookup-dependent logic always has a fallback value.',
    example: 'default_match = unknown',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'case_sensitive_match',
    description:
      'Controls whether lookup matching is case-sensitive. ' +
      'When true, "Admin" and "admin" are treated as different values. ' +
      'Set to false for case-insensitive matching.',
    example: 'case_sensitive_match = false',
    defaultValue: 'true',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },

  // =======================================================================
  // transforms.conf -- Event Routing
  // =======================================================================
  {
    key: 'LOOKAHEAD',
    description:
      'The number of characters from the start of an event that Splunk examines when applying the transforms REGEX. ' +
      'Limits the portion of each event that the regex is tested against. ' +
      'Setting this appropriately can improve performance for long events.',
    example: 'LOOKAHEAD = 4096',
    defaultValue: '4096',
    category: 'Event Routing',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MV_ADD',
    description:
      'When set to true, allows the extraction to append values to a multi-value field instead of overwriting it. ' +
      'If the same field is extracted multiple times, each value is retained. ' +
      'When false (default), later extractions overwrite earlier ones.',
    example: 'MV_ADD = true',
    defaultValue: 'false',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'CLEAN_KEYS',
    description:
      'When set to true (the default), Splunk cleans the field names it extracts: every non-alphanumeric ' +
      'character becomes an underscore, then any leading underscores and digits are stripped. Case is ' +
      'preserved and interior underscores survive, so "2026-01-15T10:00:00Z a" becomes "T10_00_00Z_a". ' +
      'Set to false (or 0) to keep the raw key text. Search-time field extractions only.',
    example: 'CLEAN_KEYS = true',
    defaultValue: 'true',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'KEEP_EMPTY_VALS',
    description:
      'When set to true, fields that match the REGEX but capture an empty string are still created with an empty value. ' +
      'When false, empty captures are discarded.',
    example: 'KEEP_EMPTY_VALS = true',
    defaultValue: 'false',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'CAN_OPTIMIZE',
    description:
      'Controls whether Splunk can optimize this transforms stanza by skipping it when the fields it extracts are not required by the search. ' +
      'Set to false to force the transform to always run, which is necessary when it has side effects.',
    example: 'CAN_OPTIMIZE = false',
    defaultValue: 'true',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },

  // =======================================================================
  // props.conf -- Additional directives
  // =======================================================================
  {
    key: 'HEADER_FIELD_LINE_NUMBER',
    description:
      'For structured data types (INDEXED_EXTRACTIONS), names which line carries the header — ' +
      'counting from 1. At 0, the default, the header is located automatically.',
    example: 'HEADER_FIELD_LINE_NUMBER = 2',
    defaultValue: '0',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'FIELD_DELIMITER',
    description:
      'For structured data types (INDEXED_EXTRACTIONS = csv/tsv/psv), specifies the character used to delimit fields. ' +
      'Typically set automatically based on the INDEXED_EXTRACTIONS type.',
    example: 'FIELD_DELIMITER = ,',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'FIELD_QUOTE',
    description:
      'For structured data types (INDEXED_EXTRACTIONS), specifies the character used to quote field values that ' +
      'contain the delimiter character.',
    example: 'FIELD_QUOTE = "',
    defaultValue: '"',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'TIMESTAMP_FIELDS',
    description:
      'A comma-separated list of field names that contain timestamp data in structured data (INDEXED_EXTRACTIONS). ' +
      'Splunk uses the value of the first non-empty field found as the event timestamp.',
    example: 'TIMESTAMP_FIELDS = event_time, created_at',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'FIELD_NAMES',
    description:
      'Explicitly specifies a comma-separated list of field names for structured data parsing when the data does not contain a header row. ' +
      'Used with INDEXED_EXTRACTIONS when the data files lack a header line.',
    example: 'FIELD_NAMES = timestamp, severity, message, host',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'PREAMBLE_REGEX',
    description:
      'A regex that matches non-data preamble lines at the beginning of a file that should be skipped. ' +
      'Lines matching this pattern are ignored during structured data parsing.',
    example: 'PREAMBLE_REGEX = ^#',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'rename',
    description:
      'Renames a sourcetype to a new name. When Splunk encounters the original sourcetype, it replaces it with the value of rename. ' +
      'This is useful for normalizing sourcetype names.',
    example: 'rename = cisco:asa',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'priority',
    description:
      'Sets the priority for stanza matching when a data input matches multiple stanzas. ' +
      'Higher values take precedence. Used to control which stanza\'s settings are applied first.',
    example: 'priority = 10',
    defaultValue: '0',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },

  // =======================================================================
  // transforms.conf -- Additional directives
  // =======================================================================
  {
    key: 'external_cmd',
    description:
      'Specifies an external command or script to use for a scripted lookup. ' +
      'The script must be located in $SPLUNK_HOME/etc/apps/<app>/bin/ and must accept input/output in CSV format on stdin/stdout.',
    example: 'external_cmd = lookup_user.py user_id',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'external_type',
    description:
      'Specifies the type of external lookup: "python" (scripted), "executable" (scripted via a binary), ' +
      '"kvstore" (KV Store collection), "geo" / "geo_hex" (geospatial lookups). ' +
      'Used with external_cmd for scripted lookups or with collection for KV Store lookups.',
    example: 'external_type = python',
    defaultValue: 'python',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'enum',
    enumValues: ['python', 'executable', 'kvstore', 'geo', 'geo_hex'],
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'collection',
    description:
      'The name of the KV Store collection to use for a KV Store lookup. ' +
      'Requires external_type = kvstore. The collection must be defined in collections.conf.',
    example: 'collection = asset_inventory',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'fields_list',
    description:
      'A comma-separated list of fields that this lookup provides. ' +
      'Defines which fields are available as both input (matching) fields and output fields for the lookup.',
    example: 'fields_list = user_id, user_name, department, role',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'batch_index_query',
    description:
      'Controls whether the lookup uses batch mode for KV Store or external script queries. ' +
      'When true, Splunk sends all lookup values in one batch instead of querying row by row. ' +
      'Can significantly improve lookup performance for large datasets.',
    example: 'batch_index_query = true',
    defaultValue: 'true',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'time_field',
    description:
      'Specifies which field in the lookup table contains time data, enabling time-based lookup filtering. ' +
      'When set, Splunk can scope the lookup to only match entries within a relevant time range.',
    example: 'time_field = event_timestamp',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'time_format',
    description:
      'The strftime format string used to parse the time_field values in the lookup table. ' +
      'Required when time_field is set and the time values are not in epoch format.',
    example: 'time_format = %Y-%m-%dT%H:%M:%S',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'strftime',
    isClassBased: false,
    phase: 'search-time',
  },

  // =======================================================================
  // props.conf -- Miscellaneous (commonly-seen directives)
  // =======================================================================
  {
    key: 'sourcetype',
    description:
      'Overrides the sourcetype for events matching this stanza. Most often used inside a ' +
      '[source::...] stanza to assign a sourcetype based on the file path.',
    example: 'sourcetype = my_app_logs',
    defaultValue: '',
    category: 'Miscellaneous',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'TZ_ALIAS',
    description:
      'Remaps timezone abbreviations found in event text to specific timezones, resolving ambiguous ' +
      'abbreviations (e.g. TZ_ALIAS = EST=GMT-5,CST=GMT-6). Applied during timestamp extraction.',
    example: 'TZ_ALIAS = EST=GMT-5,CST=GMT-6',
    defaultValue: '',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'NO_BINARY_CHECK',
    description:
      'When true, Splunk processes files that appear to be binary instead of skipping them. ' +
      'Set on a per-sourcetype basis for data that Splunk misdetects as binary.',
    example: 'NO_BINARY_CHECK = true',
    defaultValue: 'false',
    category: 'Miscellaneous',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'CHECK_FOR_HEADER',
    description:
      'When true, Splunk inspects the start of a file for a header to dynamically create a sourcetype ' +
      '(used with structured/header-bearing files). Deprecated in favour of INDEXED_EXTRACTIONS.',
    example: 'CHECK_FOR_HEADER = true',
    // props.conf.spec: defaults to FALSE. Hover and lint were telling users this
    // defaults on, which is the opposite of what an indexer does.
    defaultValue: 'false',
    category: 'Miscellaneous',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
    deprecated: true,
  },
  {
    key: 'disabled',
    description:
      'When true, disables this stanza so Splunk ignores its settings. A standard toggle available ' +
      'on most Splunk configuration stanzas.',
    example: 'disabled = false',
    defaultValue: 'false',
    category: 'Miscellaneous',
    appliesTo: 'both',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'both',
  },
  {
    key: 'DEFAULT_VALUE',
    description:
      'The value an index-time transform writes to its DEST_KEY when the REGEX does not match, so ' +
      'the destination is written for every event rather than only the matching ones. Valid only ' +
      'for index-time transforms (reached from props.conf via TRANSFORMS-<class>); a search-time ' +
      'REPORT- ignores it.',
    example: 'DEFAULT_VALUE = unknown',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },

  // -------------------------------------------------------------------------
  // props.conf.spec 10.4.3 completeness (#178)
  //
  // Everything below was valid in props.conf and unknown to this registry, so
  // writing one of these produced no completion, no hover, and no warning --
  // the preview simply behaved as though the line were not there. Twenty-one
  // of them were not even named in UNDOCUMENTED_ATTRIBUTES.
  //
  // Structural facts (value type, default, enumerated values) are read from
  // props.conf.spec. The descriptions are written here, deliberately: the spec
  // prose is Splunk's and is not copied into this repository.
  // -------------------------------------------------------------------------
  {
    key: 'ADD_EXTRA_TIME_FIELDS',
    description:
      'Controls which index-time timestamp fields travel with the event — date_hour, ' +
      'date_mday, date_minute, date_month, date_second, date_wday, date_year, date_zone, ' +
      'timestartpos, timeendpos and timestamp. "none" (or false) strips them and the ' +
      'sub-second granularity with them, leaving _time accurate only to the second; ' +
      '"subseconds" drops the fields but keeps the granularity; "all" (or true) keeps ' +
      'everything.',
    example: 'ADD_EXTRA_TIME_FIELDS = subseconds',
    defaultValue: 'true',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['none', 'subseconds', 'all', 'true', 'false'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME',
    description:
      'Decides where the date comes from when a timestamp has a time but no date. True ' +
      'reads the system clock, treating a stamp less than three hours ahead as today and ' +
      'anything further ahead as yesterday; false carries the date forward from the last ' +
      'timestamp that parsed.',
    example: 'DETERMINE_TIMESTAMP_DATE_WITH_SYSTEM_TIME = true',
    defaultValue: 'false',
    category: 'Time Configuration',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'ROUTE_EVENTS_OLDER_THAN',
    description:
      'Sends events older than the given age to nullQueue, after timestamp extraction has ' +
      'run. The value is a number with an optional s, m, h or d suffix. Because it acts ' +
      'on the extracted time, a stanza whose timestamps are being misread will drop ' +
      'events that are not actually old.',
    example: 'ROUTE_EVENTS_OLDER_THAN = 7d',
    defaultValue: '',
    category: 'Event Routing',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MAX_EXPECTED_EVENT_LINES',
    description:
      'The average number of lines an event is expected to span. Splunk sizes its memory ' +
      'allocation around this; it does not cap anything, so it changes throughput rather ' +
      'than output. The spec asks you to consult Splunk Support before changing it.',
    example: 'MAX_EXPECTED_EVENT_LINES = 7',
    defaultValue: '7',
    category: 'Performance',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'LB_CHUNK_BREAKER',
    description:
      'Deprecated in favour of EVENT_BREAKER. Sets the event boundary a universal ' +
      'forwarder uses when deciding where it may switch indexers, and applies only when ' +
      'an [httpout] stanza is configured in outputs.conf. Like LINE_BREAKER it needs a ' +
      'capturing group, whose contents are discarded.',
    example: 'LB_CHUNK_BREAKER = ([\\r\\n]+)',
    defaultValue: '([\\r\\n]+)',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
    deprecated: true,
  },
  {
    key: 'LB_CHUNK_BREAKER_TRUNCATE',
    description:
      'The largest chunk, in bytes, a forwarder will send over HTTP. Rounded down rather ' +
      'than splitting a multi-byte character. Applies only when an [httpout] stanza is ' +
      'configured in outputs.conf.',
    example: 'LB_CHUNK_BREAKER_TRUNCATE = 2000000',
    defaultValue: '2000000',
    category: 'Event Breaking',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'METRICS_PROTOCOL',
    description:
      'Declares that the source carries metrics rather than events, and which wire format ' +
      'they use. STATSD reads <name>:<value>|<type>, auto-extracting dimensions when they ' +
      'follow a "#"; COLLECTD_HTTP reads the streaming JSON the collectd write_http ' +
      'plugin emits.',
    example: 'METRICS_PROTOCOL = statsd',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['STATSD', 'COLLECTD_HTTP'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'STATSD-DIM-TRANSFORMS',
    description:
      'Names the transforms.conf stanzas that pull dimensions out of statsd metric data, ' +
      'as a comma-separated list. Stanza names must carry the statsd-dims: prefix. Only ' +
      'meaningful when METRICS_PROTOCOL is statsd, and optional when the stanza is named ' +
      'after the sourcetype.',
    example: 'STATSD-DIM-TRANSFORMS = statsd-dims:extract_ip',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'STATSD_EMIT_SINGLE_MEASUREMENT_FORMAT',
    description:
      'Chooses the shape of the metric data points the statsd processor emits. True gives ' +
      'one measurement per point, as metric_name=<name> with _value=<number>, which is ' +
      'what statsd data actually is and what downstream transforms can edit. False packs ' +
      'several measurements into one point.',
    example: 'STATSD_EMIT_SINGLE_MEASUREMENT_FORMAT = true',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'METRIC-SCHEMA-TRANSFORMS',
    description:
      'Names metric-schema stanzas from transforms.conf that turn one log event into ' +
      'several metrics, as a comma-separated list. Applied after index-time field ' +
      'extraction, and only valid for index-time extractions — so it needs TRANSFORMS, ' +
      'not REPORT.',
    example: 'METRIC-SCHEMA-TRANSFORMS = metric-schema:logtometrics',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'FIELD_HEADER_REGEX',
    description:
      'Matches a prefix that sits in front of the real header line, for sources that ' +
      'decorate it. The header is read from just after the match; the matched text is not ' +
      'part of any field name.',
    example: 'FIELD_HEADER_REGEX = ^#Fields:\\s',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'HEADER_FIELD_DELIMITER',
    description:
      'The single character separating fields in the header line, when it differs from ' +
      'the one separating fields in the body. Accepts the delimiter names space, tab, fs, ' +
      'gs, rs, us, \\xHH and whitespace.',
    example: 'HEADER_FIELD_DELIMITER = tab',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'HEADER_FIELD_QUOTE',
    description:
      'The quote character used in the header line, when it differs from the body\'s. ' +
      'Accepts the same delimiter names as the other header settings, plus "none" for a ' +
      'null terminator.',
    example: 'HEADER_FIELD_QUOTE = "',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS',
    description:
      'Exempts characters from header-name cleaning. By default anything that is neither ' +
      'alphanumeric nor a space becomes an underscore, so a CSV header of "field.name" is ' +
      'indexed as field_name; naming "." here keeps the dot. ASCII below 128 only, and ' +
      'some characters — "=" in particular — produce field names that break search ' +
      'syntax.',
    example: 'HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS = .',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'MISSING_VALUE_REGEX',
    description:
      'The placeholder that marks an absent value in structured data, so an empty column ' +
      'can be told apart from one holding a literal dash or NULL.',
    example: 'MISSING_VALUE_REGEX = ^-$',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'regex',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'JSON_TRIM_BRACES_IN_ARRAY_NAMES',
    description:
      'Strips the "{}" the JSON index-time parser appends to array field names, turning ' +
      'data.mount_point{} into data.mount_point. Setting it true makes index-time array ' +
      'names disagree with what the spath search command produces at search time.',
    example: 'JSON_TRIM_BRACES_IN_ARRAY_NAMES = true',
    defaultValue: 'false',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'KV_TRIM_SPACES',
    description:
      'Whether automatic key-value extraction strips the outer spaces from a value. ' +
      'Default true, so myfield=" apples " yields apples; false keeps them. Applies to ' +
      'spaces only, not tabs, and only when KV_MODE is auto or auto_escaped.',
    example: 'KV_TRIM_SPACES = false',
    defaultValue: 'true',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'OPTIMIZE_IE_EXTRACT',
    description:
      'Lets Splunk skip search-time extraction for a stanza when index-time extraction ' +
      'already produced every field the search asked for. Only affects events that went ' +
      'through index-time extraction.',
    example: 'OPTIMIZE_IE_EXTRACT = true',
    defaultValue: 'false',
    category: 'Performance',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'XML_INDEXED_EXTRACTIONS_PIPELINE',
    description:
      'Which pipeline performs index-time extraction from XML, and the switch that makes ' +
      'the XML values of INDEXED_EXTRACTIONS active at all. typing runs on indexers and ' +
      'heavy forwarders; structuredparsing, exec and wineventlog exist so universal ' +
      'forwarders can extract instead.',
    example: 'XML_INDEXED_EXTRACTIONS_PIPELINE = typing',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['structuredparsing', 'wineventlog', 'typing', 'exec'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_INCLUDE',
    description:
      'The XML metadata fields to extract at index time, as a comma-separated list ' +
      'accepting "*" as a wildcard. Defaults to everything.',
    example: 'XML_IE_INCLUDE = *Process*,Event*',
    defaultValue: '*',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_INCLUDE_MV',
    description:
      'The XML fields allowed to carry multiple values, as a comma-separated list ' +
      'accepting "*". A field outside this list keeps only its first value.',
    example: 'XML_IE_INCLUDE_MV = *Process*,Event*',
    defaultValue: '*',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_EXCLUDE',
    description:
      'XML metadata fields to leave out of index-time extraction, as a comma-separated ' +
      'list accepting "*". Filters what XML_IE_INCLUDE let through.',
    example: 'XML_IE_EXCLUDE = TargetProcessId',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_EXCLUDE_MV',
    description:
      'XML fields that must not become multivalued; only the first value is kept for ' +
      'each. Comma-separated, "*" accepted.',
    example: 'XML_IE_EXCLUDE_MV = EventID',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_EXCLUDE_VALS',
    description:
      'Values that disqualify a field from index-time XML extraction — a field whose ' +
      'value matches an entry here is skipped, which is how placeholder values like a ' +
      'bare dash are kept out of the index.',
    example: 'XML_IE_EXCLUDE_VALS = -',
    defaultValue: '',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_SKIP_XML_ENCODED_VALS',
    description:
      'Whether a value containing XML-encoded characters is left for search-time ' +
      'extraction rather than decoded and indexed. Applies only to INDEXED_EXTRACTIONS = ' +
      'xmlkv-winevt.',
    example: 'XML_IE_SKIP_XML_ENCODED_VALS = false',
    defaultValue: 'true',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'XML_IE_MAX_EXTRACTED_VALUE_SIZE',
    description:
      'The longest XML metadata value index-time extraction will take; anything larger is ' +
      'left to search time. Lowering it pushes work to search and raises CPU there, and ' +
      'the index processor truncates above 1000 during index-time handling regardless.',
    example: 'XML_IE_MAX_EXTRACTED_VALUE_SIZE = 500',
    defaultValue: '1000',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'extraction_cutoff',
    description:
      'How many bytes of an XML event index-time extraction reads before it stops.',
    example: 'extraction_cutoff = 10000',
    defaultValue: '10000',
    category: 'Structured Data',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'RULESET',
    description:
      'Index-time transformation — filtering, routing, masking — naming transforms.conf ' +
      'stanzas in a comma-separated list, applied in order. Nearly identical to ' +
      'TRANSFORMS, with two differences: a ruleset runs on both heavy forwarder and ' +
      'indexer rather than being skipped once done, and where a source matches both, ' +
      'TRANSFORMS is applied first. Configured through /services/data/ingest/rulesets.',
    example: 'RULESET-drop_debug = drop_debug_logs',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'index-time',
  },
  {
    key: 'RULESET_DESC',
    description:
      'A human-readable description of the matching RULESET- entry. It changes nothing ' +
      'about processing; it exists so the next reader knows what a ruleset was for.',
    example: 'RULESET_DESC-drop_debug = Drops DEBUG lines before indexing',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: true,
    phase: 'index-time',
  },
  {
    key: 'CHECK_METHOD',
    description:
      'How the file input decides whether a file has already been indexed. endpoint_md5 ' +
      'checksums the first and last 256 bytes and indexes only what is new; entire_md5 ' +
      'checksums the whole file; modtime looks only at the modification time. Anything ' +
      'but endpoint_md5 re-indexes the whole file on every change. Valid only on ' +
      '[source::...] stanzas.',
    example: 'CHECK_METHOD = entire_md5',
    defaultValue: 'endpoint_md5',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['endpoint_md5', 'entire_md5', 'modtime'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'initCrcLength',
    description:
      'How many bytes from the start of a file are used for its identity checksum. Raise ' +
      'it when many files share a long identical header and are being mistaken for one ' +
      'another. Documented in inputs.conf.spec.',
    example: 'initCrcLength = 1024',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'detect_trailing_nulls',
    description:
      'Whether trailing null bytes are trimmed rather than indexed, which exists for ' +
      'programs that pre-allocate a log file with nulls and fill it in later. Set false ' +
      'for UTF-16 and other encodings where a null byte is part of the text.',
    example: 'detect_trailing_nulls = false',
    defaultValue: 'false',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['auto', 'true', 'false'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'HEADER_MODE',
    description:
      'Whether an inline ***SPLUNK*** directive in the data may rewrite index-time ' +
      'fields. always allows it on any line, firstline only on the first, none treats the ' +
      'string as ordinary text. Left empty, scripted inputs behave as always and file ' +
      'inputs as none.',
    example: 'HEADER_MODE = firstline',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['always', 'firstline', 'none'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'PREFIX_SOURCETYPE',
    description:
      'Applies only to the [too_small] sourcetype, which catches files under 100 lines ' +
      'that cannot be classified. True names them <sourcename>-too_small so wildcard ' +
      'searches can still find them; false lumps them all under too_small.',
    example: 'PREFIX_SOURCETYPE = false',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'LEARN_MODEL',
    description:
      'Whether the file classifier writes a model file for a known sourcetype into the ' +
      'learned directory. Turn it off for sources with no representative example — source ' +
      'code being the spec\'s own case.',
    example: 'LEARN_MODEL = false',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'maxDist',
    description:
      'How far a file may differ from a sourcetype\'s learned model and still match. ' +
      'Smaller is stricter; the spec suggests moving it by about 100 at a time when a ' +
      'model matches too broadly or too narrowly.',
    example: 'maxDist = 30',
    defaultValue: '300',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'termFrequencyWeightedDist',
    description:
      'Whether file distance is measured by how often shared terms occur rather than by ' +
      'how many unique terms two files share. The frequency measure is the more accurate ' +
      'one; the count is the legacy behaviour and remains the default.',
    example: 'termFrequencyWeightedDist = true',
    defaultValue: 'false',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'trackPipelineLatency',
    description:
      'Whether pipeline latency is measured against ingest time and averaged into ' +
      'metrics.log, under the per_host/sourcetype/source/index_thruput group.',
    example: 'trackPipelineLatency = false',
    defaultValue: 'true',
    category: 'Performance',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'force_local_processing',
    description:
      'Makes a universal forwarder run the linebreaker, aggregator and regexreplacement ' +
      'processors itself instead of passing the data on raw. It moves CPU and memory onto ' +
      'the forwarder, and applies only there.',
    example: 'force_local_processing = true',
    defaultValue: 'false',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'invalid_cause',
    description:
      'Diverts a file away from ordinary reading. "archive" hands it to the archive ' +
      'processor named by unarchive_cmd; "winevt" hands it to the Event Log input; any ' +
      'other string raises an error in splunkd.log. Only valid on a [<sourcetype>] ' +
      'stanza.',
    example: 'invalid_cause = archive',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'is_valid',
    description:
      'Set automatically by invalid_cause. The spec is unusually blunt about this one: do ' +
      'not set it.',
    example: 'is_valid = false',
    defaultValue: 'true',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'unarchive_cmd',
    description:
      'The shell command that extracts an archived source, reading stdin and writing ' +
      'stdout. Called only when invalid_cause is archive, and valid only on [source::...] ' +
      'stanzas. _auto uses Splunk\'s own handling for tar, tar.gz, tgz, tbz, tbz2 and zip.',
    example: 'unarchive_cmd = gzip -cd -',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'unarchive_cmd_start_mode',
    description:
      'Whether unarchive_cmd runs through a shell or directly. direct runs the first ' +
      'value as the command and the rest as its arguments, so shell operators like && and ' +
      '; do not work; shell allows a full pipeline.',
    example: 'unarchive_cmd_start_mode = direct',
    defaultValue: 'shell',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'enum',
    enumValues: ['direct', 'shell'],
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'unarchive_sourcetype',
    description:
      'The sourcetype given to what comes out of a matching archive, used instead of ' +
      'sourcetype for files ending gz, bz, bz2 or Z. Left empty, Splunk strips the ' +
      'extension and looks for another stanza.',
    example: 'unarchive_sourcetype = my_logs',
    defaultValue: '',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'SOURCETYPE_NAME_RESTRICTED_CHARACTERS',
    description:
      'The characters a sourcetype name may not contain, as a quoted comma-separated ' +
      'list. Supplying more characters tightens the rule and fewer loosens it; an empty ' +
      'or whitespace-only value falls back to the default. The spec says to consult ' +
      'Splunk Support before changing it.',
    example: 'SOURCETYPE_NAME_RESTRICTED_CHARACTERS = "#,&,>,<"',
    defaultValue: '"#,&,>,<,?,::"',
    category: 'Data Input',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'description',
    description:
      'Free text describing the sourcetype, shown in the Splunk UI. It has no effect on ' +
      'indexing or on search results.',
    example: 'description = Apache access log, combined format',
    defaultValue: '',
    category: 'Miscellaneous',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'category',
    description:
      'Groups sourcetypes for presentation in the Splunk UI. Case sensitive, and with no ' +
      'effect on indexing or on search results.',
    example: 'category = Web',
    defaultValue: '',
    category: 'Miscellaneous',
    appliesTo: 'props.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },

  // -------------------------------------------------------------------------
  // transforms.conf.spec 10.4.3 completeness (#178)
  //
  // The other half of the same sweep. Most of these are lookup settings, which
  // are `documented` for the reason every lookup attribute is: a lookup needs
  // a table, and a browser with no backend has nowhere to get one. The metrics
  // settings describe the metrics pipeline rather than the event pipeline.
  //
  // Structural facts come from transforms.conf.spec; the descriptions are
  // written here.
  // -------------------------------------------------------------------------
  {
    key: 'CAN_OPTIMIZE_IE',
    description:
      'Lets a search-time extraction be skipped when index-time extraction already ran ' +
      'for the event. The transforms.conf counterpart of OPTIMIZE_IE_EXTRACT. Only set it ' +
      'true when the output field is genuinely already present from index time, and only ' +
      'when SOURCE_KEY names an extracted field rather than _raw or nothing.',
    example: 'CAN_OPTIMIZE_IE = true',
    defaultValue: 'false',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'STOP_PROCESSING_IF',
    description:
      'An eval expression that halts further index-time processing of an event when it ' +
      'evaluates true. Like INGEST_EVAL it overrides the other index-time settings, and ' +
      'it runs after INGEST_EVAL. The result is read as a boolean: numeric 0 and null are ' +
      'false, everything else is true. Ordering is defined — all TRANSFORMS ' +
      'alphabetically, then all RULESETs alphabetically, then by position within a ' +
      'ruleset — and a rule that stops processing skips every rule after it in that ' +
      'ruleset.',
    example: 'STOP_PROCESSING_IF = len(_raw) > 4096',
    defaultValue: '',
    category: 'Event Routing',
    appliesTo: 'transforms.conf',
    valueType: 'eval',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'REMOVE_DIMS_FROM_METRIC_NAME',
    description:
      'In a [statsd-dims:...] stanza, whether the dimension values the REGEX matched are ' +
      'removed from the metric name. False leaves them in the name as well as extracting ' +
      'them as dimensions.',
    example: 'REMOVE_DIMS_FROM_METRIC_NAME = true',
    defaultValue: 'true',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'METRIC-SCHEMA-MEASURES',
    description:
      'In a [metric-schema:...] stanza, which index-time extracted fields become measures ' +
      'when a log event is converted into metrics; the rest become dimensions. _ALLNUMS_ ' +
      'takes every numeric field, _NUMS_EXCEPT_ takes every numeric field but the ones ' +
      'named, and a bare list takes the named fields that hold numbers. "*" matches ' +
      'similar field names. Lower precedence than the prefixed form.',
    example: 'METRIC-SCHEMA-MEASURES = _NUMS_EXCEPT_ pid,port',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'METRIC-SCHEMA-BLACKLIST-DIMS',
    description:
      'Dimensions to omit when a log event becomes metrics, which is how a ' +
      'high-cardinality field is kept out. "*" matches similar names. Where both lists ' +
      'name a dimension, the deny list wins.',
    example: 'METRIC-SCHEMA-BLACKLIST-DIMS = *_id',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'METRIC-SCHEMA-WHITELIST-DIMS',
    description:
      'The only dimensions to keep when a log event becomes metrics. An empty list ' +
      'behaves as though it named every field. A dimension in the deny list is dropped ' +
      'even when this list names it.',
    example: 'METRIC-SCHEMA-WHITELIST-DIMS = name,host',
    defaultValue: '',
    category: 'Field Extraction',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'metrics.disabled',
    description:
      'In [_ruleset:global_settings], whether per-transform-rule metrics are collected. ' +
      'When on, the indexer reports each rule\'s event count, raw size and routing to ' +
      'metrics.log.',
    example: 'metrics.disabled = false',
    defaultValue: 'true',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'metrics.report_interval',
    description:
      'How often per-transform-rule metrics are written, as a duration such as 30s or 1m. ' +
      'Rounded to a multiple of the interval in limits.conf\'s [metrics] stanza.',
    example: 'metrics.report_interval = 1m',
    defaultValue: '30s',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'metrics.rule_filter',
    description:
      'Restricts per-transform-rule metrics to rule names matching this comma-separated ' +
      'list, which accepts "*". It exists to stop metrics.log being flooded where many ' +
      'rules are defined; empty means every rule is reported.',
    example: 'metrics.rule_filter = abc*,*def',
    defaultValue: '',
    category: 'Performance',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'index-time',
  },
  {
    key: 'max_duplicates',
    description:
      'The most duplicate rows a lookup may hold across all fields, read into memory ' +
      'before max_matches and min_matches are applied. Should exceed max_matches. 0 means ' +
      'no limit. Applies to file-based lookups larger than max_memtable_bytes, or ' +
      'replicated ones above that size.',
    example: 'max_duplicates = 1000',
    defaultValue: '0',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'reverse_lookup_honor_case_sensitive_match',
    description:
      'Whether a reverse lookup respects case_sensitive_match. True follows that setting; ' +
      'false matches case-insensitively regardless. Does not apply to KV Store lookups.',
    example: 'reverse_lookup_honor_case_sensitive_match = false',
    defaultValue: 'true',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'index_fields_list',
    description:
      'Which fields of a static CSV lookup are indexed and therefore searchable. ' +
      'Restricting the list makes the lookup faster. Defaults to every field in the ' +
      'file\'s header.',
    example: 'index_fields_list = host, ip',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'python.version',
    description:
      'Deprecated in favour of python.required. For scripted lookups, which Python the ' +
      'script runs under.',
    example: 'python.version = python3',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'enum',
    enumValues: ['default', 'python', 'python2', 'python3', 'python3.7', 'python3.9', 'latest'],
    isClassBased: false,
    phase: 'search-time',
    deprecated: true,
  },
  {
    key: 'python.required',
    description:
      'For scripted lookups, the Python versions the script supports, as a ' +
      'comma-separated list; the platform picks the highest available. Takes precedence ' +
      'over python.version. Prefer a specific version to "latest", which is an internal ' +
      'value tied to unfinished work.',
    example: 'python.required = 3.9, 3.13',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'max_offset_secs',
    description:
      'For a temporal lookup, how far after a lookup entry\'s time an event may fall and ' +
      'still match.',
    example: 'max_offset_secs = 3600',
    defaultValue: '2000000000',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'min_offset_secs',
    description:
      'For a temporal lookup, how far after a lookup entry\'s time an event must fall ' +
      'before it may match.',
    example: 'min_offset_secs = 60',
    defaultValue: '0',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'allow_caching',
    description:
      'Whether output from a scripted lookup may be cached.',
    example: 'allow_caching = false',
    defaultValue: 'true',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'cache_size',
    description:
      'How many input values this lookup caches output for. The spec asks you not to ' +
      'change it without advice from Splunk Support.',
    example: 'cache_size = 10000',
    defaultValue: '10000',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'max_ext_batch',
    description:
      'The largest external batch size, between 1 and 1000. Applies only to KV Store ' +
      'lookups.',
    example: 'max_ext_batch = 300',
    defaultValue: '300',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'number',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'filter',
    description:
      'Narrows the lookup table before any rows are returned, written like a search with ' +
      'boolean and comparison operators. KV Store lookups filter as the data is ' +
      'retrieved; CSV lookups filter in memory.',
    example: 'filter = id<500 AND color="red"',
    defaultValue: '',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'feature_id_element',
    description:
      'For a KMZ geospatial lookup, the XML path from the placemark down to its name.',
    example: 'feature_id_element = /Placemark/name',
    defaultValue: '/Placemark/name',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'string',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'check_permission',
    description:
      'Whether write permission on a CSV lookup file is verified before outputlookup ' +
      'modifies it. Only honoured when outputlookup_check_permission is true in ' +
      'limits.conf, and only for CSV lookups.',
    example: 'check_permission = true',
    defaultValue: 'false',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
  {
    key: 'replicate',
    description:
      'Whether a CSV lookup is replicated to indexers as well as search heads. True needs ' +
      'the lookup to be on the replicationAllowlist in distSearch.conf. CSV lookups only.',
    example: 'replicate = false',
    defaultValue: 'true',
    category: 'Lookups',
    appliesTo: 'transforms.conf',
    valueType: 'boolean',
    isClassBased: false,
    phase: 'search-time',
  },
];

/**
 * The registry as everything else reads it: each definition with its support
 * classification attached. An unclassified key defaults to `simulated` and is
 * caught by `directiveSupport.test.ts`, which is what stops the boundary from
 * quietly widening as directives are added.
 */
const DIRECTIVES: DirectiveInfo[] = DIRECTIVE_DEFINITIONS.map((d) => {
  const entry = getDirectiveSupport(d.key);
  return {
    ...d,
    support: entry?.support ?? 'simulated',
    supportNote: entry?.note,
    supportIssue: entry?.issue,
  };
});

// ---------------------------------------------------------------------------
// Build lookup maps for fast access
// ---------------------------------------------------------------------------

/**
 * Canonical map of all directives, keyed by their base key name.
 * When a key exists in both props.conf and transforms.conf (e.g. MATCH_LIMIT)
 * we keep both entries, so the lookup helpers filter by file at runtime.
 */
const directivesByKey = new Map<string, DirectiveInfo[]>();
// Same directives keyed by lowercased name, for case-insensitive lookups that
// detect case typos (Splunk attribute names are case-sensitive).
const directivesByLowerKey = new Map<string, DirectiveInfo[]>();

for (const d of DIRECTIVES) {
  const existing = directivesByKey.get(d.key);
  if (existing) {
    existing.push(d);
  } else {
    directivesByKey.set(d.key, [d]);
  }
  const lower = d.key.toLowerCase();
  const existingLower = directivesByLowerKey.get(lower);
  if (existingLower) {
    existingLower.push(d);
  } else {
    directivesByLowerKey.set(lower, [d]);
  }
}

// ---------------------------------------------------------------------------
// Class-based directive prefixes -- e.g. EXTRACT, REPORT, etc.
// ---------------------------------------------------------------------------

const CLASS_BASED_PREFIXES: string[] = DIRECTIVES
  .filter((d) => d.isClassBased)
  .map((d) => d.key);

// ---------------------------------------------------------------------------
// Exported helper functions
// ---------------------------------------------------------------------------

/**
 * Look up a directive by its key, scoped to a given configuration file.
 *
 * For class-based directives (e.g. "EXTRACT-myfield") the lookup uses the
 * base prefix ("EXTRACT").
 */
export function getDirectiveInfo(
  key: string,
  file: 'props.conf' | 'transforms.conf',
): DirectiveInfo | undefined {
  // Try an exact match first.
  const exact = directivesByKey.get(key);
  if (exact) {
    return exact.find((d) => d.appliesTo === file || d.appliesTo === 'both');
  }

  // Try matching a class-based prefix (e.g. "EXTRACT-myfield" -> "EXTRACT").
  const parsed = getClassBasedDirectiveBase(key);
  if (parsed) {
    const byBase = directivesByKey.get(parsed.base);
    if (byBase) {
      return byBase.find((d) => d.appliesTo === file || d.appliesTo === 'both');
    }
  }

  return undefined;
}

/**
 * Return all directives that apply to the given configuration file.
 */
export function getDirectivesForFile(
  file: 'props.conf' | 'transforms.conf',
): DirectiveInfo[] {
  return DIRECTIVES.filter((d) => d.appliesTo === file || d.appliesTo === 'both');
}

/**
 * Return directives grouped by category for the given configuration file.
 */
export function getDirectivesByCategory(
  file: 'props.conf' | 'transforms.conf',
): Map<string, DirectiveInfo[]> {
  const result = new Map<string, DirectiveInfo[]>();
  for (const d of DIRECTIVES) {
    if (d.appliesTo !== file && d.appliesTo !== 'both') {
      continue;
    }
    const group = result.get(d.category);
    if (group) {
      group.push(d);
    } else {
      result.set(d.category, [d]);
    }
  }
  return result;
}

/**
 * Parse a class-based directive key like "EXTRACT-myfield" into its base
 * prefix and class name.  Returns null if the key is not class-based.
 */
export function getClassBasedDirectiveBase(
  key: string,
): { base: string; className: string } | null {
  const dashIndex = key.indexOf('-');
  if (dashIndex === -1) {
    return null;
  }

  const base = key.substring(0, dashIndex);
  const className = key.substring(dashIndex + 1);

  if (CLASS_BASED_PREFIXES.includes(base) && className.length > 0) {
    return { base, className };
  }

  return null;
}

/**
 * Return the full list of registered directives.  Useful for iteration in
 * autocomplete providers and documentation generators.
 */
export function getAllDirectives(): DirectiveInfo[] {
  return [...DIRECTIVES];
}

/**
 * Case-insensitive lookup → the canonical (correctly-cased) directive key, scoped
 * to a file. Returns undefined if no known directive matches case-insensitively.
 * Used to detect case typos: Splunk attribute names are case-sensitive, so a
 * mis-cased name (e.g. `kv_mode`) is silently ignored and the default applies.
 */
export function getCanonicalDirectiveKey(
  key: string,
  file: 'props.conf' | 'transforms.conf',
): string | undefined {
  const matches = directivesByLowerKey.get(key.toLowerCase());
  return matches?.find((d) => d.appliesTo === file || d.appliesTo === 'both')?.key;
}
