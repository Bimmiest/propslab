// The props.conf.spec 10.4.3 completeness sweep (#178): every attribute the
// spec defines that the hand-written sections in propsDirectives.ts did not.

import type { DirectiveDefinition } from './types';

/** props.conf.spec attributes added by the #178 sweep. */
export const PROPS_SPEC_COMPLETENESS: DirectiveDefinition[] = [
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
];
