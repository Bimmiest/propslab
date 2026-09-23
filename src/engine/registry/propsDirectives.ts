// props.conf directive definitions, before support classification is
// attached (directiveRegistry.ts does that and builds the lookups). Split by
// provenance: the hand-written core sections, the later additions, and the
// sweep of props.conf.spec 10.4.3 in propsSpecDirectives.ts.

import type { DirectiveDefinition } from './types';

/** Time, line breaking, field extraction, other and lookup settings. */
export const PROPS_CORE: DirectiveDefinition[] = [
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
      'Note: this simulator models csv, tsv, psv, w3c, json, xml, xmlkv and xmlkv-winevt ' +
      '(the xml values only with XML_INDEXED_EXTRACTIONS_PIPELINE set); hec is accepted ' +
      'as valid config but not simulated.',
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
];

/** Settings added after the core sections. */
export const PROPS_ADDITIONAL: DirectiveDefinition[] = [
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
];

/** Commonly seen settings that fit no other section. Also holds `disabled` (both files) and transforms.conf `DEFAULT_VALUE`, where they were first written: moving them would reorder the registry. */
export const PROPS_MISC: DirectiveDefinition[] = [
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
];
