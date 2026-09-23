// transforms.conf directive definitions, before support classification is
// attached (directiveRegistry.ts does that and builds the lookups). The sweep of
// transforms.conf.spec 10.4.3 lives in transformsSpecDirectives.ts.

import type { DirectiveDefinition } from './types';

/** Field extraction, performance, lookup and event-routing settings. */
export const TRANSFORMS_CORE: DirectiveDefinition[] = [
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
];

/** Settings added after the core sections. */
export const TRANSFORMS_ADDITIONAL: DirectiveDefinition[] = [
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
];
