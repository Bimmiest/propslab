import { CEF_HEADER, LEEF_HEADER, detectLineFormat } from './lineFormat';

/**
 * The format of a raw sample, named for the chip in the Raw Log footer (#742).
 *
 * The formats that each line shows by itself come first: their lines also
 * pass the structural checks (a CEF line has seven `|`, so it reads as PSV),
 * and the specific name is the useful one. Then the structural formats that
 * `detectLineFormat` finds for the Scaffold, with key=value between JSON/XML
 * and the delimited formats: a JSON message may hold `a=1 b=2 c=3`, and a
 * key=value line may hold consistent commas.
 */
export interface LogFormat {
  /** A short name for the chip, for example "JSON" or "Syslog". */
  name: string;
  /** Why, for the chip's tooltip. */
  evidence: string;
}

/** Enough lines to tell, few enough to read again on each edit. */
const SAMPLE_LINES = 200;

/** A line format matches when this share of the lines that start an event show it. */
const MIN_SHARE = 0.8;

const LINE_FORMATS: { name: string; test: (line: string) => boolean; what: string }[] = [
  // Before syslog: CEF and LEEF usually arrive behind a syslog header.
  { name: 'CEF', test: (l) => CEF_HEADER.test(l), what: 'a CEF header' },
  { name: 'LEEF', test: (l) => LEEF_HEADER.test(l), what: 'a LEEF header' },
  {
    name: 'Syslog (RFC 5424)',
    test: (l) => /^<\d{1,3}>\d{1,2} \S+ \S+ \S+ \S+ \S+ /.test(l),
    what: 'an RFC 5424 header',
  },
  {
    name: 'Syslog',
    test: (l) => /^(?:<\d{1,3}>)?[A-Z][a-z]{2} [ \d]\d(?: \d{4})? \d{2}:\d{2}:\d{2} \S+ /.test(l),
    what: 'a BSD syslog header (RFC 3164)',
  },
  {
    name: 'Access log',
    test: (l) => /^\S+ \S+ \S+ \[\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} [+-]\d{4}\] "/.test(l),
    what: 'the Common Log Format',
  },
];

const isKeyValue = (line: string) => (line.match(/(?:^|[\s,;])[\w.-]+=/g)?.length ?? 0) >= 3;

/** The first `n` lines, without splitting the rest of a large paste. */
function firstLines(text: string, n: number): string[] {
  const lines: string[] = [];
  let start = 0;
  while (lines.length < n) {
    const end = text.indexOf('\n', start);
    lines.push(text.slice(start, end === -1 ? undefined : end).replace(/\r$/, ''));
    if (end === -1) break;
    start = end + 1;
  }
  return lines;
}

/** The format the lines that start an event share, or null when fewer than MIN_SHARE of them do. */
function shared(starts: string[], test: (line: string) => boolean): string | null {
  const matching = starts.filter(test).length;
  return matching / starts.length >= MIN_SHARE ? `${matching}/${starts.length} lines` : null;
}

/** The scaffold's evidence without its reason for the directive, which the chip does not show. */
const firstClause = (evidence: string) => evidence.split(' — ')[0] ?? evidence;

export function detectLogFormat(rawData: string): LogFormat | null {
  const lines = firstLines(rawData, SAMPLE_LINES);
  // Indented lines continue an event (a stack trace, say), so they do not count against a header format.
  const starts = lines.filter((l) => /^\S/.test(l));
  if (starts.length === 0) return null;

  if (lines.some((l) => l.startsWith('#Fields:'))) return { name: 'W3C', evidence: 'A #Fields: header line' };

  for (const { name, test, what } of LINE_FORMATS) {
    const share = shared(starts, test);
    if (share) return { name, evidence: `${share} start with ${what}` };
  }

  // Given the whole text: it parses a JSON document that spans lines as a whole.
  const suggestions = detectLineFormat(rawData, lines);
  const find = (key: string) => suggestions.find((s) => s.key === key);
  const kvMode = find('KV_MODE');
  if (kvMode?.value === 'xml') return { name: 'XML', evidence: firstClause(kvMode.evidence) };
  if (kvMode?.value === 'json') {
    // Objects spread over lines: the breaker says so; KV_MODE's evidence is only "JSON payload".
    const breaker = find('LINE_BREAKER');
    const spread = breaker?.value.endsWith('(?=\\{)') ? breaker : kvMode;
    return { name: 'JSON', evidence: firstClause(spread.evidence) };
  }

  const kv = shared(starts, isKeyValue);
  if (kv) return { name: 'Key=value', evidence: `${kv} hold three or more key=value pairs` };

  const delimited = find('INDEXED_EXTRACTIONS');
  if (delimited) return { name: delimited.value.toUpperCase(), evidence: firstClause(delimited.evidence) };
  const merge = find('SHOULD_LINEMERGE');
  if (merge?.value === 'true') return { name: 'Multi-line', evidence: firstClause(merge.evidence) };
  return null;
}
