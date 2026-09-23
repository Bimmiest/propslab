// The transforms.conf.spec 10.4.3 completeness sweep (#178): every attribute
// the spec defines that transformsDirectives.ts did not.

import type { DirectiveDefinition } from './types';

/** transforms.conf.spec attributes added by the #178 sweep. */
export const TRANSFORMS_SPEC_COMPLETENESS: DirectiveDefinition[] = [
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
