// ---------------------------------------------------------------------------
// corpus.ts
// The fidelity corpus: minimal, self-contained cases whose ground truth was
// recorded from a real Splunk instance and committed under
// `splunk-<version>/`. `splunkFidelity.test.ts` replays each case through the
// engine and asserts it reproduces the recorded output. The corpus is closed
// to new cases — README.md in this directory says why — so a new case here
// with no fixture fails the suite.
//
// Every case is deliberately small. A case that exercises one directive and
// fails tells you which directive is wrong; a realistic multi-directive log
// sample that fails tells you nothing.
// ---------------------------------------------------------------------------

export interface FixtureCase {
  /**
   * Stable, filename-safe identifier. Used for the fixture filename, the
   * generated stanza name, and the sourcetype at capture time -- so renaming a
   * case orphans its fixture. Don't rename; retire and add.
   */
  id: string;
  /**
   * Registry keys (see `directiveRegistry.ts`) this case is ground truth for.
   * Drives the coverage report against the `simulated` surface declared in #153.
   */
  directives: string[];
  /**
   * Index-time cases must be re-ingested for a config change to take effect, so
   * the capture script restarts splunkd when any are present. Search-time cases
   * apply at query time against already-indexed events.
   */
  phase: 'index-time' | 'search-time';
  /**
   * props.conf body -- directives only, no stanza header. Capture wraps this in
   * `[fx_<run>_<id>]`; the test wraps it in `[fx_<id>]` and runs the engine with
   * a matching sourcetype. Neither side hardcodes a stanza name.
   */
  props: string;
  /** Full transforms.conf text, stanza headers included. Names must be unique corpus-wide. */
  transforms?: string;
  /**
   * Additional props.conf stanzas addressed by something other than this case's
   * sourcetype -- `source::...`, `host::...`, or a wildcarded sourcetype. Used
   * by the precedence cases, where the whole point is which of several matching
   * stanzas wins.
   *
   * Written verbatim, so the stanza name must match the `ingestSource` /
   * `ingestHost` the case declares. Names must begin `fx_` or contain `::fx_`
   * so the capture script can clean them up without touching anything else.
   */
  extraProps?: Array<{ stanza: string; body: string }>;
  /**
   * Ingest metadata. Defaults to `fixture-capture` for both. Override only when
   * a stanza needs to address them: these values are captured into the fixture,
   * so they must be literals chosen here and never anything instance-derived.
   */
  ingestSource?: string;
  ingestHost?: string;
  /** Raw input, exactly as fed to Splunk. Trailing newline is significant to line breaking. */
  input: string;
  /**
   * Set when the engine is known to disagree with Splunk. The suite asserts the
   * disagreement still looks exactly as recorded, so the case guards against
   * drift instead of blocking the branch -- and fails loudly once the engine is
   * fixed, prompting removal. Value is the tracking issue.
   */
  knownMismatch?: string;
  /**
   * Record and compare the `punct` field for this case. punct is excluded from
   * every fixture by default (ANNOTATE_PUNCT is on everywhere, so recording it
   * globally would make every case a punct assertion); the cases that exist to
   * pin the signature opt back in with this.
   */
  comparePunct?: boolean;
  /** Why this case exists, when that isn't obvious from the directives alone. */
  note?: string;
}

/**
 * `TZ = UTC` appears in every case that parses a timestamp. Without it the
 * captured `_time` depends on the capturing instance's timezone, and the
 * fixture stops reproducing anywhere else. Every timestamp is fully qualified
 * (explicit year) for the same reason: Splunk infers a missing year from the
 * clock at ingest, so a fixture built on inferred values expires silently.
 */
export const CORPUS: FixtureCase[] = [
  {
    id: 'linebreak-should-linemerge-false',
    directives: ['SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z alpha\n' +
      '2026-01-15T10:00:01Z beta\n' +
      '2026-01-15T10:00:02Z gamma\n',
    note: 'One event per line, no merging. The baseline every other breaking case is measured against.',
  },
  {
    id: 'linebreak-break-only-before-date',
    directives: ['SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE_DATE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z first line\n' +
      '  continuation without a date\n' +
      '  another continuation\n' +
      '2026-01-15T10:00:05Z second line\n',
    note: 'Merging continuation lines into the preceding dated line -- the default Splunk behaviour most tools get wrong.',
  },
  {
    id: 'linebreak-custom-line-breaker',
    directives: ['LINE_BREAKER', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nLINE_BREAKER = (=====\\r?\\n)\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z record one\nspanning two lines\n' +
      '=====\n2026-01-15T10:00:01Z record two\n' +
      '=====\n2026-01-15T10:00:02Z record three\n',
    note:
      'The capturing group is consumed, not retained. Asserts the engine drops the delimiter ' +
      'rather than prefixing it to the next event. Every record carries a timestamp purely so ' +
      '_time is deterministic -- without one Splunk stamps the event with the time of ingest, ' +
      'and the fixture stops reproducing the moment it is captured.',
  },
  {
    id: 'truncate-hard-cap',
    directives: ['TRUNCATE', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTRUNCATE = 40\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z ' + 'A'.repeat(100) + '\n' +
      '2026-01-15T10:00:01Z short\n',
    note: 'Truncation is by bytes at the breaker stage, before timestamping. Checks the cut point and that the remainder is discarded rather than emitted as a second event.',
  },
  {
    id: 'timestamp-prefix-and-format',
    directives: ['TIME_PREFIX', 'TIME_FORMAT', 'MAX_TIMESTAMP_LOOKAHEAD', 'TZ'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\n' +
      'TIME_PREFIX = ts=\n' +
      'TIME_FORMAT = %Y-%m-%d %H:%M:%S\n' +
      'MAX_TIMESTAMP_LOOKAHEAD = 25\n' +
      'TZ = UTC\n',
    input:
      'server=web01 ts=2026-01-15 10:00:00 msg=started\n' +
      'server=web02 ts=2026-01-15 11:30:45 msg=stopped\n',
    note:
      'Timestamp located after a prefix rather than at the start of the event, which is where ' +
      'TIME_PREFIX/lookahead interactions go wrong. Uses `server=` rather than `host=` ' +
      'deliberately: `host` is excluded from every fixture as instance-identifying metadata, ' +
      'so an extracted field of that name would be silently dropped rather than compared.',
  },
  {
    id: 'sedcmd-replace',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\n' +
      'TZ = UTC\n' +
      'SEDCMD-mask = s/password=\\w+/password=REDACTED/g\n',
    input:
      '2026-01-15T10:00:00Z user=alice password=hunter2 action=login\n' +
      '2026-01-15T10:00:01Z user=bob password=swordfish action=login\n',
    note: 'SEDCMD rewrites _raw at index time, so the recorded _raw is the mutated form. Asserts the engine mutates rather than merely annotating.',
  },
  {
    id: 'extract-search-time-named-groups',
    directives: ['EXTRACT-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\n' +
      'TZ = UTC\n' +
      'EXTRACT-kv = user=(?<user>\\w+)\\s+action=(?<action>\\w+)\n',
    input:
      '2026-01-15T10:00:00Z user=alice action=login\n' +
      '2026-01-15T10:00:01Z user=bob action=logout\n',
    note: 'Named-capture extraction against _raw, the most common search-time path.',
  },
  {
    id: 'kvmode-auto',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input:
      '2026-01-15T10:00:00Z user=alice status=200 bytes=1024\n' +
      '2026-01-15T10:00:01Z user=bob status=404 bytes=0 note="not found"\n',
    note: 'Automatic key=value extraction, including the quoted value. Splunk\'s auto-KV rules are subtle and entirely undocumented at the edges.',
  },
  {
    id: 'report-transform-search-time',
    directives: ['REPORT-', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nREPORT-pairs = fx_report_pairs\n',
    transforms:
      '[fx_report_pairs]\n' +
      'REGEX = (\\w+)::(\\w+)\n' +
      'FORMAT = $1::$2\n' +
      'MV_ADD = true\n',
    input:
      '2026-01-15T10:00:00Z env::prod region::eu tier::web\n' +
      '2026-01-15T10:00:01Z env::dev region::us\n',
    note: 'Dynamic field naming through FORMAT with MV_ADD -- multiple matches per event, field names taken from the data.',
  },
  // -------------------------------------------------------------------------
  // Line breaking
  // -------------------------------------------------------------------------
  {
    id: 'linebreak-max-events',
    directives: ['MAX_EVENTS', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nMAX_EVENTS = 3\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z start\n' +
      'cont one\ncont two\ncont three\ncont four\ncont five\n',
    note: 'MAX_EVENTS caps how many input lines merge into one event, forcing a break mid-continuation.',
  },
  {
    id: 'linebreak-break-only-before',
    directives: ['BREAK_ONLY_BEFORE', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^EVENT\nTZ = UTC\n',
    input:
      'EVENT 2026-01-15T10:00:00Z first\n  detail line\n' +
      'EVENT 2026-01-15T10:00:01Z second\n  detail line\n',
    note: 'An explicit break regex rather than date detection.',
  },
  {
    id: 'linebreak-must-break-after',
    directives: ['MUST_BREAK_AFTER', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = false\nMUST_BREAK_AFTER = END\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z alpha\nmiddle\nEND\n' +
      '2026-01-15T10:00:01Z beta\nmiddle\nEND\n',
    note: 'Break is forced after the matching line, not before it -- the off-by-one that MUST_BREAK_AFTER invites.',
  },

  // -------------------------------------------------------------------------
  // Truncation
  // -------------------------------------------------------------------------
  {
    id: 'truncate-disabled',
    directives: ['TRUNCATE', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTRUNCATE = 0\nTZ = UTC\n',
    input: '2026-01-15T10:00:00Z ' + 'B'.repeat(300) + '\n',
    note: 'TRUNCATE = 0 disables truncation entirely rather than truncating to zero bytes.',
  },
  {
    id: 'truncate-multibyte-boundary',
    directives: ['TRUNCATE', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTRUNCATE = 30\nTZ = UTC\n',
    input: '2026-01-15T10:00:00Z ' + 'é'.repeat(40) + '\n',
    note:
      'TRUNCATE counts bytes, not characters, and each "é" is two bytes in UTF-8. ' +
      'props.conf.spec: "Although this is in bytes, line length is rounded down when this would ' +
      'otherwise land mid-character for multi-byte characters." This pins that rounding-down ' +
      'rule, which a JavaScript implementation working in UTF-16 code units is likely to miss.',
  },

  // -------------------------------------------------------------------------
  // Timestamps
  // -------------------------------------------------------------------------
  {
    id: 'timestamp-epoch-seconds',
    directives: ['TIME_FORMAT', 'TIME_PREFIX'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTIME_PREFIX = at=\nTIME_FORMAT = %s\nTZ = UTC\n',
    input: 'at=1768471200 msg=first\nat=1768471260 msg=second\n',
    note: 'Epoch input, where TZ must not shift the result.',
  },
  {
    id: 'timestamp-subsecond',
    directives: ['TIME_FORMAT', 'TIME_PREFIX'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTIME_PREFIX = ts=\n' +
      'TIME_FORMAT = %Y-%m-%dT%H:%M:%S.%3N\nTZ = UTC\n',
    input: 'ts=2026-01-15T10:00:00.123 a\nts=2026-01-15T10:00:00.999 b\n',
    note: 'Millisecond precision survives into _time, which epoch-second rounding would silently drop.',
  },
  {
    id: 'timestamp-month-name',
    directives: ['TIME_FORMAT', 'TIME_PREFIX'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTIME_PREFIX = \\[\n' +
      'TIME_FORMAT = %d/%b/%Y:%H:%M:%S\nTZ = UTC\n',
    input:
      '10.0.0.1 [15/Jan/2026:10:00:00] "GET /a"\n' +
      '10.0.0.2 [15/Jan/2026:11:30:45] "GET /b"\n',
    note: 'Abbreviated month names in the Apache access-log shape, with a regex TIME_PREFIX.',
  },
  {
    id: 'timestamp-lookahead-too-short',
    directives: ['MAX_TIMESTAMP_LOOKAHEAD', 'TIME_FORMAT'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTIME_FORMAT = %Y-%m-%d\n' +
      'MAX_TIMESTAMP_LOOKAHEAD = 10\nTZ = UTC\n',
    input: '2026-01-15 10:00:00 lookahead stops after the date\n',
    note:
      'The lookahead admits the date but not the time, so only the date parses and _time lands at ' +
      'midnight. Deliberately still parseable: a lookahead that cuts mid-timestamp makes Splunk ' +
      'fall back to the time of ingest, which cannot be a fixture -- it would encode the moment ' +
      'of capture and never reproduce.',
  },
  {
    id: 'timestamp-named-timezone',
    directives: ['TZ', 'TIME_FORMAT', 'TIME_PREFIX'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTIME_PREFIX = ts=\n' +
      'TIME_FORMAT = %Y-%m-%d %H:%M:%S\nTZ = America/New_York\n',
    input: 'ts=2026-01-15 10:00:00 winter\n',
    note:
      'A named zone rather than UTC, on a January date so the offset is EST (-05:00) and not ' +
      'subject to a DST boundary. Asserts the engine applies the zone rather than assuming UTC.',
  },

  // -------------------------------------------------------------------------
  // SEDCMD
  // -------------------------------------------------------------------------
  {
    id: 'sedcmd-backreference',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\n' +
      'SEDCMD-swap = s/(\\w+)=(\\w+)/\\2=\\1/g\n',
    input: '2026-01-15T10:00:00Z a=1 b=2\n',
    note: 'Capture-group backreferences in the replacement.',
  },
  {
    id: 'sedcmd-transliterate',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nSEDCMD-upper = y/abc/ABC/\n',
    input: '2026-01-15T10:00:00Z abcdef abc\n',
    note: 'The y/// transliterate form, which is not a regex substitution and is easy to omit entirely.',
  },
  {
    id: 'sedcmd-ordering',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\n' +
      'SEDCMD-a-first = s/one/two/g\n' +
      'SEDCMD-b-second = s/two/three/g\n',
    input: '2026-01-15T10:00:00Z one\n',
    note:
      'Two SEDCMDs where the second rewrites the first\'s output. Pins both the ordering rule ' +
      '(lexicographic by class name) and that they chain rather than both seeing the original.',
  },

  // -------------------------------------------------------------------------
  // Index-time transforms
  // -------------------------------------------------------------------------
  {
    id: 'transforms-dest-key-raw',
    directives: ['TRANSFORMS-', 'DEST_KEY', 'REGEX', 'FORMAT'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-rw = fx_rewrite_raw\n',
    transforms:
      '[fx_rewrite_raw]\nREGEX = secret=(\\S+)\nDEST_KEY = _raw\nFORMAT = redacted=yes\n',
    input:
      '2026-01-15T10:00:00Z secret=abc123 msg=one\n' +
      '2026-01-15T10:00:01Z msg=two\n',
    note:
      'An index-time transform replacing _raw wholesale via DEST_KEY. The second event does not ' +
      'match the REGEX, pinning that a non-matching event is left alone rather than blanked.',
  },
  {
    id: 'transforms-write-meta',
    directives: ['TRANSFORMS-', 'WRITE_META', 'REGEX', 'FORMAT'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-meta = fx_write_meta\n',
    transforms:
      '[fx_write_meta]\nREGEX = zone=(\\w+)\nFORMAT = zone::$1\nWRITE_META = true\n',
    input: '2026-01-15T10:00:00Z zone=dmz msg=hello\n',
    note: 'WRITE_META creates an indexed field, which behaves differently from a search-time extraction.',
  },
  {
    id: 'indexed-extractions-json',
    directives: ['INDEXED_EXTRACTIONS'],
    phase: 'index-time',
    props:
      'INDEXED_EXTRACTIONS = JSON\nKV_MODE = none\nTZ = UTC\n' +
      'TIME_PREFIX = "ts":"\nTIME_FORMAT = %Y-%m-%dT%H:%M:%SZ\n',
    input:
      '{"ts":"2026-01-15T10:00:00Z","user":"alice","status":200}\n' +
      '{"ts":"2026-01-15T10:00:01Z","user":"bob","status":404}\n',
    note:
      'Structured ingest, where field extraction happens at index time. KV_MODE = none is ' +
      'required to isolate it: left at the default, search-time auto-KV extracts the same keys a ' +
      'second time and every value comes back as a two-element multivalue.',
  },
  {
    id: 'ingest-eval',
    directives: ['INGEST_EVAL'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-ie = fx_ingest_eval\n',
    transforms: '[fx_ingest_eval]\nINGEST_EVAL = size_kb = round(bytes/1024, 2)\n',
    input: '2026-01-15T10:00:00Z bytes=2048\n',
    note: 'INGEST_EVAL computes an indexed field at ingest rather than at search time.',
  },

  // -------------------------------------------------------------------------
  // Search-time extraction
  // -------------------------------------------------------------------------
  {
    id: 'extract-in-source-field',
    directives: ['EXTRACT-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'EXTRACT-parts = (?<proto>\\w+)://(?<hostname>[^/]+) in url\n',
    input: '2026-01-15T10:00:00Z url=https://example.com/a status=200\n',
    note: 'The "in <field>" form, which extracts from another field rather than _raw and therefore depends on KV_MODE running first.',
  },
  {
    id: 'report-delims',
    directives: ['REPORT-', 'DELIMS', 'FIELDS'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nREPORT-csv = fx_report_delims\n',
    transforms: '[fx_report_delims]\nDELIMS = ","\nFIELDS = "col_a", "col_b", "col_c"\n',
    input: '2026-01-15T10:00:00Z,alpha,beta\n',
    note: 'Delimiter-based extraction with positional field names rather than a regex.',
  },
  {
    id: 'report-source-key',
    directives: ['REPORT-', 'SOURCE_KEY', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\nREPORT-sk = fx_report_source_key\n',
    transforms:
      '[fx_report_source_key]\nSOURCE_KEY = payload\nREGEX = id:(\\d+)\nFORMAT = payload_id::$1\n',
    input: '2026-01-15T10:00:00Z payload="id:4242" status=200\n',
    note: 'SOURCE_KEY redirects the transform away from _raw onto a previously extracted field.',
  },
  {
    id: 'report-repeat-match',
    directives: ['REPORT-', 'REPEAT_MATCH', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nREPORT-rm = fx_report_repeat\n',
    transforms:
      '[fx_report_repeat]\nREGEX = (\\w+)=(\\d+)\nFORMAT = $1::$2\nREPEAT_MATCH = true\nMV_ADD = true\n',
    input: '2026-01-15T10:00:00Z a=1 b=2 c=3\n',
    note:
      'Multiple matches of the same regex in one event, combined with MV_ADD. REPEAT_MATCH is ' +
      'set but inert here: transforms.conf.spec states it "is only valid for index-time field ' +
      'extractions", and this is a search-time REPORT-. The repeated extraction observed is ' +
      'ordinary search-time behaviour, not REPEAT_MATCH.',
  },
  {
    id: 'kvmode-json',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = json\n',
    input:
      '{"ts":"2026-01-15T10:00:00Z","user":"alice","nested":{"a":1,"b":[2,3]}}\n',
    note: 'JSON extraction at search time, including how nested objects and arrays are flattened and named.',
  },
  {
    id: 'kvmode-none',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\n',
    input: '2026-01-15T10:00:00Z user=alice status=200\n',
    note: 'KV_MODE = none must suppress the automatic extraction that would otherwise happen by default.',
  },
  {
    id: 'eval-functions',
    directives: ['EVAL-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'EVAL-label = case(status < 300, "ok", status < 500, "client", true(), "server")\n' +
      'EVAL-present = coalesce(missing_field, user, "none")\n' +
      'EVAL-len = len(user)\n',
    input:
      '2026-01-15T10:00:00Z user=alice status=200\n' +
      '2026-01-15T10:00:01Z user=bob status=503\n',
    note: 'case, coalesce and len together, covering the multi-branch and null-handling paths in one case.',
  },
  {
    id: 'fieldalias-chained',
    directives: ['FIELDALIAS-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'FIELDALIAS-multi = user AS account_name status AS http_status\n',
    input: '2026-01-15T10:00:00Z user=alice status=200\n',
    note:
      'Several aliases in one directive. Pins whether the original field survives alongside the ' +
      'alias, which determines whether aliasing is a copy or a rename.',
  },
  {
    id: 'transforms-format-static',
    directives: ['REPORT-', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nREPORT-static = fx_report_static\n',
    transforms:
      '[fx_report_static]\nREGEX = (\\d+)\\.(\\d+)\\.(\\d+)\\.(\\d+)\nFORMAT = octet_a::$1 octet_d::$4\n',
    input: '2026-01-15T10:00:00Z client=192.168.10.20\n',
    note: 'Static field names in FORMAT, with a deliberately non-contiguous group selection.',
  },
  // -------------------------------------------------------------------------
  // Second pass: edges where an implementation is most likely to diverge
  // without anyone noticing -- partial matches, absent values, and the
  // "obvious" default of a flag that turns out not to be the default.
  // -------------------------------------------------------------------------
  {
    id: 'sedcmd-first-match-only',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\n' +
      'SEDCMD-once = s/item/ITEM/\n',
    input: '2026-01-15T10:00:00Z item item item\n',
    note:
      'No trailing /g, so only the first occurrence is replaced. A regex engine defaulting to ' +
      'replace-all produces plausible output that is wrong in exactly the cases where SEDCMD is ' +
      'used for redaction.',
  },
  {
    id: 'extract-optional-group-unmatched',
    directives: ['EXTRACT-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\n' +
      'EXTRACT-opt = user=(?<user>\\w+)(?:\\s+role=(?<role>\\w+))?\n',
    input:
      '2026-01-15T10:00:00Z user=alice role=admin\n' +
      '2026-01-15T10:00:01Z user=bob\n',
    note:
      'The second event does not participate in the optional group. Pins whether Splunk omits ' +
      '`role` entirely or sets it to an empty string -- the distinction that decides if a ' +
      'downstream `isnull()` works.',
  },
  {
    id: 'kvmode-auto-quoting-edges',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input:
      '2026-01-15T10:00:00Z empty= quoted="a b" escaped="say \\"hi\\"" trailing=x\n',
    note:
      'Empty values, quoted values containing spaces, and escaped quotes inside a quoted value. ' +
      'The escaped-quote result is documented rather than a quirk: props.conf.spec lists a ' +
      'separate KV_MODE = auto_escaped that honours backslash-escaped quotes within quoted ' +
      'values, so plain `auto` truncating at the backslash is intended. The empty-value result ' +
      'is corroborated by transforms.conf.spec: "autokv ignores field/value pairs with empty ' +
      'values".',
  },
  {
    id: 'kvmode-auto-repeated-key',
    directives: ['KV_MODE', 'MV_ADD'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input: '2026-01-15T10:00:00Z label=a label=b label=c\n',
    note:
      'The same key three times. Pins whether auto-KV produces a multivalue field, keeps the ' +
      'first, or keeps the last. Uses `label` rather than the obvious `tag`, which is excluded ' +
      'from every fixture as Splunk-generated metadata and would be silently dropped.',
  },
  {
    id: 'report-delims-field-and-value',
    directives: ['REPORT-', 'DELIMS', 'CLEAN_KEYS'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-pairs2 = fx_report_delims_pairs\n',
    transforms: '[fx_report_delims_pairs]\nDELIMS = ";", "="\n',
    input: '2026-01-15T10:00:00Z a=1;b=2;c=3\n',
    note:
      'The two-argument DELIMS form, where the first splits records and the second splits key ' +
      'from value -- field names come from the data rather than from FIELDS. Because the names ' +
      'come from the data they are also what pins CLEAN_KEYS: the leading timestamp lands in the ' +
      'first key, and Splunk returns it as `T10_00_00Z_a` -- punctuation rewritten to underscores, ' +
      'then the leading digits and underscores stripped.',
  },
  {
    id: 'report-mv-add-false',
    directives: ['REPORT-', 'MV_ADD', 'REPEAT_MATCH'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-nomv = fx_report_nomv\n',
    transforms:
      '[fx_report_nomv]\nREGEX = label=(\\w+)\nFORMAT = label::$1\nREPEAT_MATCH = true\nMV_ADD = false\n',
    input: '2026-01-15T10:00:00Z label=a label=b label=c\n',
    note:
      'The counterpart to the MV_ADD = true case. transforms.conf.spec: with MV_ADD false ' +
      '(the default) "the newly found value is discarded", so the first match wins -- which is ' +
      'what Splunk does. REPEAT_MATCH is set but inert at search time; it is retained only to ' +
      'keep this case structurally identical to its MV_ADD = true counterpart.',
  },
  {
    id: 'kvmode-xml',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = xml\n' +
      'TIME_PREFIX = <ts>\nTIME_FORMAT = %Y-%m-%dT%H:%M:%SZ\n',
    input:
      '<event><ts>2026-01-15T10:00:00Z</ts><user>alice</user><status>200</status></event>\n',
    note: 'XML extraction, including how element names become field names and whether the wrapper element appears.',
  },
  {
    id: 'auto-kv-json-disabled',
    directives: ['AUTO_KV_JSON', 'KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\nAUTO_KV_JSON = false\n',
    input: '{"ts":"2026-01-15T10:00:00Z","user":"alice","status":200}\n',
    note:
      'KV_MODE = auto normally detects JSON and extracts it. AUTO_KV_JSON = false suppresses only ' +
      'that path, leaving plain key=value detection active -- so this pins that the two are ' +
      'separate mechanisms rather than one.',
  },
  {
    id: 'transforms-chained',
    directives: ['TRANSFORMS-', 'DEST_KEY', 'REGEX', 'FORMAT'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-chain = fx_chain_one, fx_chain_two\n',
    transforms:
      '[fx_chain_one]\nREGEX = stage=start\nDEST_KEY = _raw\nFORMAT = stage=middle\n' +
      '\n[fx_chain_two]\nREGEX = stage=middle\nDEST_KEY = _raw\nFORMAT = stage=end\n',
    input: '2026-01-15T10:00:00Z stage=start\n',
    note:
      'Two transforms in one directive, where the second matches only the first\'s output. Pins ' +
      'both the left-to-right ordering and that each sees the running _raw rather than the original.',
  },
  {
    id: 'linebreak-no-capture-group',
    directives: ['LINE_BREAKER', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nLINE_BREAKER = -----\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z one\n-----\n2026-01-15T10:00:01Z two\n',
    note:
      'LINE_BREAKER is documented as requiring a capture group marking what to consume. This one ' +
      'has none, which is a common config error -- pins whether Splunk breaks anyway, ignores the ' +
      'directive, or consumes the whole match.',
  },
  // -------------------------------------------------------------------------
  // Third pass: no-ops, collisions and null handling. Cases where the correct
  // answer is "nothing happens" are the ones a reimplementation most often gets
  // wrong in the direction of doing something.
  // -------------------------------------------------------------------------
  {
    id: 'timestamp-offset-in-data',
    directives: ['TIME_FORMAT', 'TIME_PREFIX', 'TZ'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = false\nTIME_PREFIX = ts=\n' +
      'TIME_FORMAT = %Y-%m-%dT%H:%M:%S%z\nTZ = America/New_York\n',
    input: 'ts=2026-01-15T10:00:00+0900 tokyo\n',
    note:
      'The event carries its own UTC offset while the stanza also sets TZ. Pins which wins -- the ' +
      'explicit offset should, making TZ a fallback rather than an override.',
  },
  {
    id: 'truncate-shorter-than-timestamp',
    directives: ['TRUNCATE', 'TIME_FORMAT'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTRUNCATE = 10\nTIME_FORMAT = %Y-%m-%d\nTZ = UTC\n',
    input: '2026-01-15T10:00:00Z truncated after the date\n',
    note:
      'TRUNCATE cuts to exactly the date, discarding the time. Truncation runs before ' +
      'timestamping, so _time must land at midnight; if the stages ran the other way round it ' +
      'would be 10:00. Deliberately leaves a *parseable* remnant -- cutting mid-timestamp makes ' +
      'Splunk fall back to the time of ingest, which cannot be a fixture.',
  },
  {
    id: 'sedcmd-no-match',
    directives: ['SEDCMD'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nSEDCMD-nope = s/nonexistent/replacement/g\n',
    input: '2026-01-15T10:00:00Z untouched content\n',
    note: 'A SEDCMD that matches nothing must leave _raw byte-identical rather than normalising it in passing.',
  },
  {
    id: 'extract-no-match',
    directives: ['EXTRACT-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\n' +
      'EXTRACT-none = missing=(?<absent>\\w+)\n',
    input: '2026-01-15T10:00:00Z nothing here matches\n',
    note: 'A non-matching EXTRACT must produce no field at all, not an empty-string field.',
  },
  {
    id: 'eval-overwrites-extracted-field',
    directives: ['EVAL-', 'KV_MODE'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'EVAL-status = "overwritten"\n',
    input: '2026-01-15T10:00:00Z status=200 user=alice\n',
    note:
      'EVAL- targets a field name that auto-KV already extracted. Pins whether eval wins, ' +
      'extraction wins, or the field becomes multivalue.',
  },
  {
    id: 'eval-null-propagation',
    directives: ['EVAL-', 'KV_MODE'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'EVAL-from_missing = absent_field . "-suffix"\n' +
      'EVAL-arith_missing = absent_field + 1\n',
    input: '2026-01-15T10:00:00Z user=alice\n',
    note:
      'Concatenation and arithmetic against a field that does not exist. Splunk propagates null ' +
      'rather than coercing to empty string or zero, so both fields should be absent -- a ' +
      'JavaScript implementation naturally produces "undefined-suffix" and NaN.',
  },
  {
    id: 'kvmode-value-containing-equals',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input: '2026-01-15T10:00:00Z filter=a=b query=x=y=z plain=ok\n',
    note: 'Values containing further "=" characters, where a naive split produces the wrong value or invents fields.',
  },
  {
    id: 'linebreak-blank-lines',
    directives: ['SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE_DATE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z first\n\n\n2026-01-15T10:00:01Z second\n\n',
    note:
      'Blank lines between and after events. Pins whether they are dropped, merged into the ' +
      'preceding event, or emitted as empty events.',
  },
  {
    id: 'report-named-groups-without-format',
    directives: ['REPORT-', 'REGEX'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-named = fx_report_named\n',
    transforms: '[fx_report_named]\nREGEX = user=(?<who>\\w+)\\s+action=(?<what>\\w+)\n',
    input: '2026-01-15T10:00:00Z user=alice action=login\n',
    note:
      'A transforms stanza with named capture groups and no FORMAT. Pins whether the group names ' +
      'are used directly, which is the undocumented shorthand a lot of real configs rely on.',
  },
  {
    id: 'fieldalias-target-exists',
    directives: ['FIELDALIAS-', 'KV_MODE'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n' +
      'FIELDALIAS-clash = user AS status\n',
    input: '2026-01-15T10:00:00Z user=alice status=200\n',
    note:
      'Aliasing onto a field name that already exists. Pins whether the alias overwrites, is ' +
      'ignored, or produces a multivalue field.',
  },
  // -------------------------------------------------------------------------
  // Stanza precedence
  //
  // Splunk resolves a directive by looking across every stanza that matches the
  // event, not just the sourcetype stanza, and the winner is decided by stanza
  // *type* and specificity rather than file order. This is the single largest
  // source of "why is my config being ignored" and is entirely untested by any
  // doc-derived test, because the docs state the ordering without examples.
  // -------------------------------------------------------------------------
  {
    id: 'precedence-source-beats-sourcetype',
    directives: ['SEDCMD'],
    phase: 'index-time',
    ingestSource: 'fx_prec_source_a',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nSEDCMD-who = s/MARKER/from_sourcetype/\n',
    extraProps: [
      {
        stanza: 'source::fx_prec_source_a',
        body: 'SEDCMD-who = s/MARKER/from_source/\n',
      },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'The same directive defined in both a sourcetype stanza and an exactly-matching source:: ' +
      'stanza. The rewritten _raw names the winner, so the assertion needs no interpretation.',
  },
  {
    id: 'precedence-host-vs-sourcetype',
    directives: ['SEDCMD'],
    phase: 'index-time',
    ingestHost: 'fx_prec_host_a',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nSEDCMD-who = s/MARKER/from_sourcetype/\n',
    extraProps: [
      {
        stanza: 'host::fx_prec_host_a',
        body: 'SEDCMD-who = s/MARKER/from_host/\n',
      },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note: 'host:: against the sourcetype stanza, the same shape as the source:: case.',
  },
  {
    id: 'precedence-source-vs-host',
    directives: ['SEDCMD'],
    phase: 'index-time',
    ingestSource: 'fx_prec_both_src',
    ingestHost: 'fx_prec_both_host',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    extraProps: [
      { stanza: 'source::fx_prec_both_src', body: 'SEDCMD-who = s/MARKER/from_source/\n' },
      { stanza: 'host::fx_prec_both_host', body: 'SEDCMD-who = s/MARKER/from_host/\n' },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'source:: against host:: with no sourcetype stanza in play, isolating the ordering between ' +
      'the two addressed forms.',
  },
  {
    id: 'precedence-wildcard-vs-exact-source',
    directives: ['SEDCMD'],
    phase: 'index-time',
    ingestSource: 'fx_prec_wild_exact',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    extraProps: [
      { stanza: 'source::fx_prec_wild_exact', body: 'SEDCMD-who = s/MARKER/from_exact/\n' },
      { stanza: 'source::fx_prec_wild_*', body: 'SEDCMD-who = s/MARKER/from_wildcard/\n' },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'Two source:: stanzas both matching, one exact and one wildcarded; the exact one wins. ' +
      'The mechanism is NOT the one props.conf.spec documents: the spec resolves colliding ' +
      'patterns by ASCII order of the pattern strings, and "*" (0x2A) sorts below "e" (0x65), so ' +
      'the ASCII rule predicts the wildcard. See precedence-ascii-order, which reproduces the ' +
      'spec\'s own worked example and does follow it. The likely reading is that a stanza with ' +
      'no wildcard is matched literally and resolved before pattern collision applies, but the ' +
      'spec does not say so -- this fixture records the behaviour, not an explanation.',
  },
  {
    id: 'precedence-ascii-order',
    directives: ['SEDCMD'],
    phase: 'index-time',
    ingestSource: 'fx_az',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    extraProps: [
      { stanza: 'source::...fx_a...', body: 'SEDCMD-who = s/MARKER/from_pattern_a/\n' },
      { stanza: 'source::...fx_z...', body: 'SEDCMD-who = s/MARKER/from_pattern_z/\n' },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'Two wildcard source:: patterns that both match, differing only in a character that decides ' +
      'their ASCII order. This reproduces the worked example in props.conf.spec, which states ' +
      'that colliding patterns are resolved by the ASCII order of the pattern strings -- not by ' +
      'which is more specific. Recorded because the exact-vs-wildcard case does not obviously ' +
      'follow that rule, and one of the two needs to be the documented mechanism.',
  },
  {
    id: 'precedence-merged-not-replaced',
    directives: ['SEDCMD', 'TRUNCATE'],
    phase: 'index-time',
    ingestSource: 'fx_prec_merge',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRUNCATE = 45\n',
    extraProps: [
      { stanza: 'source::fx_prec_merge', body: 'SEDCMD-who = s/MARKER/from_source/\n' },
    ],
    input: '2026-01-15T10:00:00Z MARKER padding padding padding padding\n',
    note:
      'Each stanza sets a directive the other does not. Pins that matching stanzas are merged ' +
      'attribute by attribute -- a losing stanza still contributes settings the winner is silent ' +
      'about, rather than being discarded wholesale.',
  },

  // -------------------------------------------------------------------------
  // Remaining directive gaps
  // -------------------------------------------------------------------------
  {
    id: 'linebreak-must-not-break-before',
    directives: ['SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE_DATE', 'MUST_NOT_BREAK_BEFORE'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\n' +
      'MUST_NOT_BREAK_BEFORE = ^2026-01-15T10:00:01Z\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z first\n' +
      '2026-01-15T10:00:01Z suppressed break\n' +
      '2026-01-15T10:00:02Z second\n',
    note:
      'props.conf.spec: "When set, and the current line matches the regular expression, Splunk ' +
      'software does not break the last event before the current line." Measured, it does NOT ' +
      'suppress a break driven by BREAK_ONLY_BEFORE_DATE -- all three dated lines became ' +
      'separate events. Recorded as measured; do not read the spec sentence as the whole rule.',
  },
  {
    id: 'indexed-extractions-csv',
    directives: ['INDEXED_EXTRACTIONS', 'FIELD_NAMES'],
    phase: 'index-time',
    props: 'INDEXED_EXTRACTIONS = CSV\nKV_MODE = none\nTZ = UTC\n',
    input: 'ts,user,status\n2026-01-15T10:00:00Z,alice,200\n2026-01-15T10:00:01Z,bob,404\n',
    note:
      'CSV ingest, where the first line is a header defining field names rather than an event. ' +
      'Pins that the header is consumed rather than indexed.',
  },
  {
    id: 'transforms-clean-keys-disabled',
    directives: ['REPORT-', 'CLEAN_KEYS', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-ck = fx_report_clean_keys\n',
    transforms:
      '[fx_report_clean_keys]\nREGEX = ([\\w.\\- ]+)=(\\w+)\nFORMAT = $1::$2\nCLEAN_KEYS = 0\n',
    input: '2026-01-15T10:00:00Z my.odd-key=value\n',
    note:
      'CLEAN_KEYS = 0 suppresses the field-name sanitisation that normally rewrites punctuation ' +
      'to underscores -- the direct counterpart to the sanitisation the DELIMS case exposed.',
  },
  {
    id: 'transforms-keep-empty-vals',
    directives: ['REPORT-', 'KEEP_EMPTY_VALS', 'DELIMS'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-kev = fx_report_keep_empty\n',
    transforms: '[fx_report_keep_empty]\nDELIMS = ";", "="\nKEEP_EMPTY_VALS = true\n',
    input: '2026-01-15T10:00:00Z;a=1;b=;c=3\n',
    note:
      'transforms.conf.spec says KEEP_EMPTY_VALS "controls whether Splunk software keeps ' +
      'field/value pairs when the value is an empty string" (default false), and excludes only ' +
      'autokv-generated pairs -- so a DELIMS extraction with it true should keep `b=`. Measured, ' +
      '`b` is still dropped. This records Splunk disagreeing with its own documentation; the ' +
      'engine matching it is correct behaviour, not a bug.',
  },
  {
    id: 'transforms-format-dollar-zero',
    directives: ['REPORT-', 'REGEX', 'FORMAT'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nREPORT-dz = fx_report_dollar_zero\n',
    transforms:
      '[fx_report_dollar_zero]\nREGEX = code=(\\d+)\nFORMAT = whole::$0 first::$1\n',
    input: '2026-01-15T10:00:00Z code=503\n',
    note:
      '$0 in FORMAT. transforms.conf.spec defines it as "what was in the DEST_KEY before the ' +
      'REGEX was performed" -- NOT the whole match -- and documents it under index-time ' +
      'extraction. This case is a search-time REPORT-, where Splunk produces no field for it at ' +
      'all. Guards against an implementation assuming the group-zero convention.',
  },
  {
    id: 'kvmode-multi',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = multi\n',
    input: '2026-01-15T10:00:00Z user=alice user=bob status=200\n',
    note:
      'KV_MODE = multi is NOT a multivalue mode despite the name -- props.conf.spec defines it as ' +
      '"invokes the multikv search command, which extracts fields from table-formatted events". ' +
      'This input is not table-formatted, so extracting nothing is the correct documented ' +
      'outcome. Kept as a guard against an implementation that guesses from the name.',
  },
  // -------------------------------------------------------------------------
  // Tier 1 engine fixes (#183, #184, #190): the behaviours implemented from
  // the spec rather than from a capture, pinned here so "matches our reading"
  // becomes "matches Splunk".
  // -------------------------------------------------------------------------
  {
    id: 'transforms-lookahead-bound',
    directives: ['TRANSFORMS-', 'LOOKAHEAD', 'REGEX', 'FORMAT', 'DEST_KEY'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-la = fx_lookahead_bound\n',
    transforms:
      '[fx_lookahead_bound]\nREGEX = marker=(\\w+)\nDEST_KEY = _raw\nFORMAT = found=$1\nLOOKAHEAD = 30\n',
    input:
      '2026-01-15T10:00:00Z xxxxxxxxxxxxxxx marker=deep\n' +
      '2026-01-15T10:00:01Z marker=near msg=ok\n',
    note:
      'The first event holds its match beyond the 30-character window, the second inside it. Pins ' +
      'that LOOKAHEAD bounds where an index-time REGEX may match: the first event must pass ' +
      'through untouched, the second is rewritten.',
  },
  {
    id: 'transforms-default-value',
    directives: ['TRANSFORMS-', 'DEFAULT_VALUE', 'REGEX', 'FORMAT', 'DEST_KEY'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-dv = fx_default_value\n',
    transforms:
      '[fx_default_value]\nREGEX = zone=(\\w+)\nDEST_KEY = _raw\nFORMAT = zone_found=$1\nDEFAULT_VALUE = zone_missing\n',
    input:
      '2026-01-15T10:00:00Z zone=dmz\n' +
      '2026-01-15T10:00:01Z nothing here\n',
    note:
      'Per transforms.conf.spec, a failed REGEX makes the transform write its DEFAULT_VALUE into ' +
      'DEST_KEY. The second event does not match, so its _raw should become the default ' +
      'wholesale — the assertion that pins whether DEFAULT_VALUE really writes on failure ' +
      'rather than never.',
  },
  {
    id: 'linebreak-must-not-break-before-explicit',
    directives: ['SHOULD_LINEMERGE', 'BREAK_ONLY_BEFORE', 'MUST_NOT_BREAK_BEFORE'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE = ^EVENT\nBREAK_ONLY_BEFORE_DATE = false\n' +
      'MUST_NOT_BREAK_BEFORE = protected\nTZ = UTC\n',
    input:
      'EVENT 2026-01-15T10:00:00Z one\n  detail\n' +
      'EVENT 2026-01-15T10:00:01Z protected\n' +
      'EVENT 2026-01-15T10:00:02Z two\n',
    note:
      'The companion to linebreak-must-not-break-before, which measured that the veto does NOT ' +
      'defeat a BREAK_ONLY_BEFORE_DATE break. Measured, it does not defeat an explicit ' +
      'BREAK_ONLY_BEFORE break either: all three EVENT lines start events.',
  },
  {
    id: 'linebreak-must-not-break-before-forced',
    directives: ['SHOULD_LINEMERGE', 'MUST_BREAK_AFTER', 'MUST_NOT_BREAK_BEFORE'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = false\n' +
      'MUST_BREAK_AFTER = END$\nMUST_NOT_BREAK_BEFORE = protected\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z alpha\nEND\n' +
      '2026-01-15T10:00:01Z protected\n' +
      '2026-01-15T10:00:02Z omega\nEND\n',
    note:
      'The third veto probe: with date and BREAK_ONLY_BEFORE breaks both measured as immune to ' +
      'MUST_NOT_BREAK_BEFORE, this one puts it against a MUST_BREAK_AFTER-forced break (and the ' +
      'break-every-line fallback that config implies). Measured, the protected line still starts ' +
      'its own event — the setting defeats nothing observable in 10.4.0, and the engine treats ' +
      'it as inert on the strength of all three captures.',
  },
  {
    id: 'linebreak-must-not-break-after-span',
    directives: ['SHOULD_LINEMERGE', 'MUST_NOT_BREAK_AFTER', 'MUST_BREAK_AFTER'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\n' +
      'MUST_NOT_BREAK_AFTER = BEGIN$\nMUST_BREAK_AFTER = END$\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z BEGIN\n' +
      '2026-01-15T10:00:01Z inside\n' +
      '2026-01-15T10:00:02Z END\n' +
      '2026-01-15T10:00:03Z after\n',
    note:
      'props.conf.spec reads MUST_NOT_BREAK_AFTER as stateful: after a matching line, no break ' +
      'until MUST_BREAK_AFTER matches. Every line is dated, so with the suppression honoured the ' +
      'first three lines form one event despite BREAK_ONLY_BEFORE_DATE wanting to break each.',
  },
  {
    id: 'linebreak-max-events-defeats-veto',
    directives: ['SHOULD_LINEMERGE', 'MAX_EVENTS', 'MUST_NOT_BREAK_BEFORE'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nMAX_EVENTS = 3\n' +
      'MUST_NOT_BREAK_BEFORE = .\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z start\n' +
      'cont one\ncont two\ncont three\ncont four\ncont five\n',
    note:
      'The precedence #190 flags as unmeasured: a MUST_NOT_BREAK_BEFORE that matches every line ' +
      'against the MAX_EVENTS cap. Identical input to linebreak-max-events, so if the cap wins ' +
      'the two fixtures record the same events, and if the veto wins this one collapses to a ' +
      'single event.',
  },
  {
    id: 'indexed-extractions-field-delimiter',
    directives: ['INDEXED_EXTRACTIONS', 'FIELD_DELIMITER'],
    phase: 'index-time',
    props: 'INDEXED_EXTRACTIONS = CSV\nFIELD_DELIMITER = |\nKV_MODE = none\nTZ = UTC\n',
    input:
      'ts|user|status\n' +
      '2026-01-15T10:00:00Z|alice|200\n' +
      '2026-01-15T10:00:01Z|bob|404\n',
    note:
      'A pipe-delimited file declared CSV with the delimiter overridden — the common shape #184 ' +
      'calls out. Pins that FIELD_DELIMITER, not the format name, decides the split.',
  },
  {
    id: 'indexed-extractions-field-names',
    directives: ['INDEXED_EXTRACTIONS', 'FIELD_NAMES'],
    phase: 'index-time',
    props: 'INDEXED_EXTRACTIONS = CSV\nFIELD_NAMES = ts, user, status\nKV_MODE = none\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z,alice,200\n' +
      '2026-01-15T10:00:01Z,bob,404\n',
    note:
      'Headerless CSV, the common case for FIELD_NAMES. Both lines are data: nothing may be ' +
      'consumed as a header, and the names come from the config.',
  },
  {
    id: 'indexed-extractions-preamble',
    directives: ['INDEXED_EXTRACTIONS', 'PREAMBLE_REGEX'],
    phase: 'index-time',
    props: 'INDEXED_EXTRACTIONS = CSV\nPREAMBLE_REGEX = ^;\nKV_MODE = none\nTZ = UTC\n',
    input:
      ';exported by tool\n' +
      'ts,user,status\n' +
      '2026-01-15T10:00:00Z,alice,200\n',
    note:
      'A `;` preamble deliberately, not `#`: comment-style lines are skipped by header location ' +
      'anyway, so a `#` preamble would pass with PREAMBLE_REGEX ignored and prove nothing.',
  },
  {
    id: 'indexed-extractions-timestamp-fields',
    directives: ['INDEXED_EXTRACTIONS', 'TIMESTAMP_FIELDS', 'TIME_FORMAT'],
    phase: 'index-time',
    props:
      'INDEXED_EXTRACTIONS = CSV\nTIMESTAMP_FIELDS = date, time\n' +
      'TIME_FORMAT = %Y-%m-%d %H:%M:%S\nKV_MODE = none\nTZ = UTC\n',
    input:
      'date,time,user\n' +
      '2026-01-15,10:00:00,alice\n' +
      '2026-01-15,11:30:45,bob\n',
    note:
      'A timestamp split across two columns, composed via TIMESTAMP_FIELDS. The TIME_FORMAT ' +
      'carries a space between the date and time halves, which pins the join delimiter Splunk ' +
      'uses when concatenating the named fields.',
  },
  // -------------------------------------------------------------------------
  // Full-capture round two (#209 and the behaviours the Tier 1 round left
  // unpinned): auto-KV key sanitization, the punct signature, the remaining
  // delimited overrides, the LOOKAHEAD default, the unterminated no-break
  // span, priority, and the previous-event _time fallback.
  // -------------------------------------------------------------------------
  {
    id: 'autokv-key-punctuation',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input:
      '2026-01-15T10:00:00Z zone-found=dmz user.name=alice ip:port=1.2.3.4 ' +
      'x-forwarded-for="1.2.3.4, 5.6.7.8"\n',
    note:
      'Punctuated keys through both the bare and quoted auto-KV passes. The hyphen case was ' +
      'observed once during the transforms-default-value capture (zone-found became zone_found); ' +
      'this pins it properly along with dot, colon and a quoted key.',
  },
  {
    id: 'autokv-key-edge-names',
    directives: ['KV_MODE'],
    phase: 'search-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = auto\n',
    input: '2026-01-15T10:00:00Z 2fa=on --=x a-b=1 a_b=2 7=lucky\n',
    note:
      'The edges of key sanitization: a digit-leading key (kept, per #166), a key with no ' +
      'alphanumerics, two raw spellings that sanitize to one name (which value wins?), and a ' +
      'purely numeric key (dropped, per #166).',
  },
  {
    id: 'punct-basic',
    directives: ['ANNOTATE_PUNCT'],
    phase: 'index-time',
    comparePunct: true,
    props:
      'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nANNOTATE_PUNCT = true\n' +
      'TIME_PREFIX = \\[\nTIME_FORMAT = %d/%b/%Y:%H:%M:%S %z\n',
    input: '10.0.0.1 - - [15/Jan/2026:10:00:00 +0000] "GET /index.html HTTP/1.1" 200 2326\n',
    note:
      'The punct signature for the access-log shape: which characters survive, that letters and ' +
      'digits are dropped, and how spaces are rewritten. The event is deliberately shorter than ' +
      'any plausible signature cap so this pins only the character rules.',
  },
  {
    id: 'punct-whitespace-and-multiline',
    directives: ['ANNOTATE_PUNCT', 'SHOULD_LINEMERGE'],
    phase: 'index-time',
    comparePunct: true,
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\nTZ = UTC\nKV_MODE = none\n' +
      'ANNOTATE_PUNCT = true\n',
    input:
      '2026-01-15T10:00:00Z error!\n' +
      '\tat com.example.Main(Main.java:42)\n' +
      '2026-01-15T10:00:01Z ok\n',
    note:
      'A merged two-line event whose continuation starts with a tab. Pins how punct encodes the ' +
      'newline and the tab — the community idiom punct="*\\\\t*" for finding stack traces implies ' +
      'two-character escape sequences rather than literal whitespace.',
  },
  {
    id: 'punct-cap',
    directives: ['ANNOTATE_PUNCT'],
    phase: 'index-time',
    comparePunct: true,
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nANNOTATE_PUNCT = true\n',
    input: '2026-01-15T10:00:00Z ' + '.'.repeat(60) + '\n',
    note:
      'Sixty dots after the timestamp. The signature is widely held to cap at 30 characters; ' +
      'this measures the cap (and where it cuts) rather than trusting the folklore.',
  },
  {
    id: 'punct-disabled',
    directives: ['ANNOTATE_PUNCT'],
    phase: 'index-time',
    comparePunct: true,
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nKV_MODE = none\nANNOTATE_PUNCT = false\n',
    input: '2026-01-15T10:00:00Z some punctuation: yes!\n',
    note: 'ANNOTATE_PUNCT = false must suppress the field entirely, not record an empty one.',
  },
  {
    id: 'indexed-extractions-field-quote',
    directives: ['INDEXED_EXTRACTIONS', 'FIELD_QUOTE'],
    phase: 'index-time',
    props: "INDEXED_EXTRACTIONS = CSV\nFIELD_QUOTE = '\nKV_MODE = none\nTZ = UTC\n",
    input:
      'ts,user,note\n' +
      "2026-01-15T10:00:00Z,alice,'hello, world'\n",
    note:
      'A single-quote FIELD_QUOTE protecting a comma inside a value — the quote override the ' +
      'Tier 1 round implemented but did not capture.',
  },
  {
    id: 'indexed-extractions-header-line-number',
    directives: ['INDEXED_EXTRACTIONS', 'HEADER_FIELD_LINE_NUMBER'],
    phase: 'index-time',
    props: 'INDEXED_EXTRACTIONS = CSV\nHEADER_FIELD_LINE_NUMBER = 2\nKV_MODE = none\nTZ = UTC\n',
    input:
      'Report generated 2026-01-15\n' +
      'ts,user,status\n' +
      '2026-01-15T10:00:00Z,alice,200\n',
    note:
      'The header on line 2 behind a banner line. Pins the 1-based interpretation and that the ' +
      'banner is consumed rather than indexed.',
  },
  {
    id: 'transforms-lookahead-default',
    directives: ['TRANSFORMS-', 'LOOKAHEAD', 'REGEX', 'FORMAT', 'DEST_KEY'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\nTRANSFORMS-lad = fx_lookahead_default\n',
    transforms:
      '[fx_lookahead_default]\nREGEX = marker=(\\w+)\nDEST_KEY = _raw\nFORMAT = found=$1\n',
    input:
      '2026-01-15T10:00:00Z ' + 'x'.repeat(4090) + ' marker=deep\n' +
      '2026-01-15T10:00:01Z marker=near\n',
    note:
      'No LOOKAHEAD declared: the documented default window is 4096 characters, and the first ' +
      "event's match sits just beyond it. transforms-lookahead-bound pins the explicit attribute; " +
      'this pins the default.',
  },
  {
    id: 'linebreak-must-not-break-after-unterminated',
    directives: ['SHOULD_LINEMERGE', 'MUST_NOT_BREAK_AFTER'],
    phase: 'index-time',
    props:
      'SHOULD_LINEMERGE = true\nBREAK_ONLY_BEFORE_DATE = true\n' +
      'MUST_NOT_BREAK_AFTER = BEGIN$\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z BEGIN\n' +
      '2026-01-15T10:00:01Z a\n' +
      '2026-01-15T10:00:02Z b\n',
    note:
      'The no-break span with no MUST_BREAK_AFTER to end it. The engine reads the span as running ' +
      'to end of input; nothing had measured what Splunk does without a terminator.',
  },
  {
    id: 'precedence-wildcard-priority-beats-exact',
    directives: ['SEDCMD', 'priority'],
    phase: 'index-time',
    ingestSource: 'fx_prio_wild_exact',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    extraProps: [
      { stanza: 'source::fx_prio_wild_exact', body: 'SEDCMD-who = s/MARKER/from_exact/\n' },
      {
        stanza: 'source::fx_prio_wild_*',
        body: 'priority = 200\nSEDCMD-who = s/MARKER/from_wildcard/\n',
      },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'The README calls priority the one part of stanza resolution asserted only against our ' +
      'reading of the docs. Per that reading, a wildcard stanza defaults to 0 and needs priority ' +
      'above the literal\'s implicit 100 to win — so 200 should flip the ' +
      'precedence-wildcard-vs-exact-source outcome.',
  },
  {
    id: 'precedence-priority-cannot-cross-kinds',
    directives: ['SEDCMD', 'priority'],
    phase: 'index-time',
    ingestSource: 'fx_prio_cross_src',
    ingestHost: 'fx_prio_cross_host',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    extraProps: [
      { stanza: 'source::fx_prio_cross_src', body: 'SEDCMD-who = s/MARKER/from_source/\n' },
      {
        stanza: 'host::fx_prio_cross_host',
        body: 'priority = 1000\nSEDCMD-who = s/MARKER/from_host/\n',
      },
    ],
    input: '2026-01-15T10:00:00Z MARKER\n',
    note:
      'props.conf.spec is read as saying priority orders stanzas within a kind and cannot reach ' +
      'across kinds — source beats host regardless of any declared number. A host:: stanza with ' +
      'priority = 1000 losing to a plain source:: stanza is that claim, measured.',
  },
  {
    id: 'timestamp-fallback-previous-event',
    directives: ['SHOULD_LINEMERGE'],
    phase: 'index-time',
    props: 'SHOULD_LINEMERGE = false\nTZ = UTC\n',
    input:
      '2026-01-15T10:00:00Z first\n' +
      'no date at all here\n' +
      '2026-01-15T10:00:02Z third\n',
    note:
      'A dateless standalone event between two dated ones. Splunk\'s documented fallback gives it ' +
      'the previous event\'s _time — the one step of the #85 fallback chain that is deterministic ' +
      'enough to be a fixture (the later steps depend on ingest wall-clock and cannot reproduce).',
  },
  {
    id: 'fieldalias-and-eval',
    directives: ['FIELDALIAS-', 'EVAL-'],
    phase: 'search-time',
    props:
      'SHOULD_LINEMERGE = false\n' +
      'TZ = UTC\n' +
      'KV_MODE = auto\n' +
      'FIELDALIAS-src = user AS src_user\n' +
      'EVAL-status_class = if(status >= 400, "error", "ok")\n',
    input:
      '2026-01-15T10:00:00Z user=alice status=200\n' +
      '2026-01-15T10:00:01Z user=bob status=503\n',
    note: 'Alias and eval both run after extraction; this pins their ordering relative to KV_MODE as well as their individual results.',
  },
];
