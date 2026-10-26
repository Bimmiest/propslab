// ---------------------------------------------------------------------------
// lineFormat.test.ts
// detectLineFormat's suggestions for each format, whole, and the thresholds
// that decide between them (#758). Each suggestion is asserted entire, as the
// Scaffold shows it: key, value, confidence, evidence and default.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { detectLineFormat } from '../analyzers/lineFormat';
import { runPipeline } from '../../pipeline';
import { AT_FIXED_NOW } from '../../__tests__/runCtx';
import type { ScaffoldSuggestion } from '../types';

const detect = (raw: string) => detectLineFormat(raw, raw.split(/\r?\n/));
const lines = (...l: string[]) => l.join('\n');
const keys = (raw: string) => detect(raw).map((s) => s.key);
const s = (
  key: string,
  value: string,
  confidence: ScaffoldSuggestion['confidence'],
  evidence: string,
): ScaffoldSuggestion => ({ key, value, confidence, evidence, enabledByDefault: true });

const MERGED_BY_BREAKER = s(
  'SHOULD_LINEMERGE',
  'false',
  'medium',
  'Events are delimited by the LINE_BREAKER, not merged',
);

describe('detectLineFormat — nothing to read', () => {
  it('proposes nothing for blank input or unstructured text', () => {
    expect(detect('   \n\n')).toEqual([]);
    expect(detect(lines('hello there', 'nothing to see'))).toEqual([]);
  });
});

describe('detectLineFormat — JSON, one object per line', () => {
  const jsonLines = (ratio: string, confidence: 'high' | 'medium') => [
    s('LINE_BREAKER', '([\\r\\n]+)', 'medium', 'One JSON object per line — break on newlines'),
    s('SHOULD_LINEMERGE', 'false', 'high', 'JSON events are a single line each; do not merge'),
    s(
      'KV_MODE',
      'json',
      confidence,
      `${ratio} lines parse as JSON — search-time KV_MODE preferred over INDEXED_EXTRACTIONS (no index bloat)`,
    ),
  ];

  it('is high confidence when every line is JSON, objects and arrays alike, blank lines aside', () => {
    expect(detect(lines('{"a":1}', '', '[1,2]', '  ', '{"a":2}'))).toEqual(jsonLines('3/3', 'high'));
  });

  it('is medium confidence at exactly 80% of the lines, and is not JSON below it', () => {
    expect(detect(lines('{"a":1}', '{"a":2}', '{"a":3}', '{"a":4}', 'plain'))).toEqual(jsonLines('4/5', 'medium'));
    // Plain text first, so the sample is not read as objects spread over lines either.
    expect(detect(lines('plain', '{"a":1}', '{"a":2}', '{"a":3}'))).toEqual([]);
  });
});

describe('detectLineFormat — JSON spread over lines', () => {
  const spread = (several: boolean) => [
    s(
      'LINE_BREAKER',
      '([\\r\\n]+)(?=\\{)',
      'medium',
      several
        ? 'Multiple newline-separated JSON objects — break before each one'
        : 'Multi-line JSON object — break only before a top-level `{`, so the object stays whole',
    ),
    MERGED_BY_BREAKER,
    s('KV_MODE', 'json', 'medium', 'JSON payload'),
  ];

  it('breaks before each of several objects, whatever spaces sit around the line break', () => {
    expect(detect(lines('{', '"a": 1', '}', '{', '"a": 2', '}'))).toEqual(spread(true));
    expect(detect(lines('{', '"a": 1', '}  ', '{', '"a": 2', '}'))).toEqual(spread(true));
    expect(detect(lines('{', '"a": 1', '}', '  {', '"a": 2', '}'))).toEqual(spread(true));
  });

  it('keeps one object whole, after leading space too', () => {
    expect(detect(lines('{', '"a": 1,', '"b": 2', '}'))).toEqual(spread(false));
    expect(detect(lines('', '  {', '"a": 1', '}'))).toEqual(spread(false));
  });

  it('is not JSON when text starting with { does not parse', () => {
    expect(keys(lines('{ not json', 'more text'))).not.toContain('KV_MODE');
  });
});

describe('detectLineFormat — XML', () => {
  const XML = s('KV_MODE', 'xml', 'high', 'Input looks like XML');
  const broken = (regex: string, evidence: string) => [
    s('LINE_BREAKER', regex, 'medium', evidence),
    MERGED_BY_BREAKER,
    XML,
  ];

  it('breaks before the root element, after leading space too', () => {
    const expected = broken(
      '([\\r\\n]+)(?=<Event[\\s/>])',
      'Top-level XML element <Event> — break only before each one',
    );
    expect(detect(lines('<Event><Id>1</Id></Event>', '<Event><Id>2</Id></Event>'))).toEqual(expected);
    expect(detect(lines('', '  <Event><Id>1</Id></Event>'))).toEqual(expected);
  });

  it('names every root element, and reads none inside a comment or CDATA', () => {
    expect(detect(lines('<!-- a <x> here -->', '<a><![CDATA[<y> z]]></a>', '<b/>'))).toEqual(
      broken('([\\r\\n]+)(?=<(?:a|b)[\\s/>])', 'Top-level XML elements <a>, <b> — break only before each one'),
    );
  });

  it('breaks before each declaration when every document has one, indented or not', () => {
    expect(detect(lines('<?xml version="1.0"?>', '<a/>', '  <?xml version="1.0"?>', '<a/>'))).toEqual(
      broken('([\\r\\n]+)(?=<\\?xml\\s)', 'Each XML document opens with a declaration — break only before each one'),
    );
  });

  it('proposes only KV_MODE when it cannot place the documents', () => {
    // Some documents declared, some not; no root element at all; a close before any open.
    expect(detect(lines('<?xml version="1.0"?>', '<a/>', '<a/>'))).toEqual([XML]);
    expect(detect('<?xml version="1.0"?>')).toEqual([XML]);
    expect(detect(lines('<a></a>', '</b>', '<a/>'))).toEqual([XML]);
  });

  it('is not XML when the first < is not where the text starts', () => {
    expect(keys('level=INFO msg=<b>bold</b>')).not.toContain('KV_MODE');
  });
});

describe('detectLineFormat — delimited files', () => {
  const delimited = (format: string, columns: number, ratio: string, confidence: 'high' | 'medium') => [
    s(
      'INDEXED_EXTRACTIONS',
      format,
      confidence,
      `Consistent ${columns} ${format.toUpperCase()} columns across ${ratio} lines — delimited files use index-time structured extraction`,
    ),
  ];

  it('needs a header and one row', () => {
    expect(detect(lines('a,b,c', '1,2,3'))).toEqual(delimited('csv', 3, '2/2', 'high'));
    expect(detect('a,b,c')).toEqual([]);
  });

  it('names TSV and PSV', () => {
    expect(detect(lines('a\tb', '1\t2'))).toEqual(delimited('tsv', 2, '2/2', 'high'));
    expect(detect(lines('a|b', '1|2'))).toEqual(delimited('psv', 2, '2/2', 'high'));
  });

  it('is high confidence from 95% of the lines, medium down to 70%, and not delimited below', () => {
    const rows = (consistent: number, other: number) => [
      ...Array.from({ length: consistent }, () => 'x,y'),
      ...Array.from({ length: other }, () => 'z'),
    ];
    expect(detect(lines(...rows(19, 1)))).toEqual(delimited('csv', 2, '19/20', 'high'));
    expect(detect(lines(...rows(18, 2)))).toEqual(delimited('csv', 2, '18/20', 'medium'));
    expect(detect(lines(...rows(7, 3)))).toEqual(delimited('csv', 2, '7/10', 'medium'));
    expect(detect(lines(...rows(6, 4)))).toEqual([]);
  });

  it('takes the delimiter with more columns when two are consistent', () => {
    expect(detect(lines('a,b,c\td', '1,2,3\t4'))).toEqual(delimited('csv', 3, '2/2', 'high'));
    expect(detect(lines('a\tb\tc,d', '1\t2\t3,4'))).toEqual(delimited('tsv', 3, '2/2', 'high'));
  });

  it('reads only the first 50 lines', () => {
    const raw = lines(...Array.from({ length: 50 }, () => 'x,y'), ...Array.from({ length: 30 }, () => 'z'));
    expect(detect(raw)).toEqual(delimited('csv', 2, '50/50', 'high'));
  });
});

describe('detectLineFormat — indented continuation lines', () => {
  const merged = (count: number) => [
    s('SHOULD_LINEMERGE', 'true', 'medium', `${count} line(s) start with whitespace (continuations)`),
    s('BREAK_ONLY_BEFORE', '^\\S', 'medium', 'Start a new event only on a non-indented line'),
  ];
  const sample = (indented: number, flush: number) =>
    lines(
      ...Array.from({ length: flush }, (_, i) => `event ${i}`),
      ...Array.from({ length: indented }, () => '  at x'),
    );

  it('merges from 10% of the lines indented, and not below', () => {
    expect(detect(sample(1, 9))).toEqual(merged(1));
    expect(detect(sample(1, 10))).toEqual([]);
    expect(detect(sample(0, 10))).toEqual([]);
  });
});

describe('detectLineFormat — CEF and LEEF headers (#758)', () => {
  const FIELD = String.raw`(?:\\.|[^\\|])*`;
  const CEF_REGEX =
    String.raw`CEF:(?<cef_version>[\d.]+)` +
    ['cef_device_vendor', 'cef_device_product', 'cef_device_version', 'cef_signature_id', 'cef_name', 'cef_severity']
      .map((n) => String.raw`\|(?<${n}>${FIELD})`)
      .join('') +
    String.raw`\|`;
  const header = (format: 'CEF' | 'LEEF', ratio: string, regex: string) => [
    s('LINE_BREAKER', '([\\r\\n]+)', 'high', `${format} writes one event per line`),
    s('SHOULD_LINEMERGE', 'false', 'high', `${format} events are a single line each; do not merge`),
    s(
      `EXTRACT-${format.toLowerCase()}_header`,
      regex,
      'medium',
      `${ratio} lines carry a ${format} header: extract its fields. KV_MODE = auto, the default, reads the extension's pairs after the first`,
    ),
  ];
  const cef = (n: number) => `CEF:0|Vendor|Product|1.0|${n}|Login|5|src=10.0.0.${n} suser=bob`;

  it('proposes one event per line and a header EXTRACT, not INDEXED_EXTRACTIONS = psv', () => {
    expect(detect(lines(cef(1), cef(2)))).toEqual(header('CEF', '2/2', CEF_REGEX));
  });

  it('needs 80% of the lines', () => {
    expect(detect(lines(cef(1), cef(2), cef(3), cef(4), 'a|b|c|d|e|f|g|h'))).toEqual(header('CEF', '4/5', CEF_REGEX));
    expect(keys(lines(cef(1), cef(2), cef(3), 'a|b|c|d|e|f|g|h'))).not.toContain('EXTRACT-cef_header');
  });

  it('extracts the LEEF header fields', () => {
    const regex =
      String.raw`LEEF:(?<leef_version>[\d.]+)` +
      ['leef_vendor', 'leef_product', 'leef_product_version', 'leef_event_id']
        .map((n) => String.raw`\|(?<${n}>${FIELD})`)
        .join('') +
      String.raw`\|`;
    expect(detect(lines('LEEF:1.0|V|P|2.1|4625|src=1', 'LEEF:2.0|V|P|2.1|4624|src=2'))).toEqual(
      header('LEEF', '2/2', regex),
    );
  });

  it('takes CEF when a line carries both headers', () => {
    expect(keys(lines(`${cef(1)} LEEF:1.0|V|P|1|1|`, cef(2)))).toContain('EXTRACT-cef_header');
  });

  it('extracts the fields through the pipeline, a vendor with an escaped pipe and a syslog header included', () => {
    const raw = lines(
      '<134>Oct 26 13:55:36 fw01 CEF:0|Ven\\|dor|Product|1.0|100|Login|5|src=10.0.0.1 suser=bob',
      'CEF:0|Vendor|Product|1.0|101|Logout|3|src=10.0.0.2 suser=amy',
    );
    const props = ['[vendor:cef]', ...detect(raw).map((x) => `${x.key} = ${x.value}`)].join('\n');
    const meta = { index: 'main', host: '', source: '', sourcetype: 'vendor:cef' };
    const { events } = runPipeline(raw, meta, props, '', AT_FIXED_NOW).result;
    expect(events).toHaveLength(2);
    expect(events[0]!.fields).toMatchObject({
      cef_version: '0',
      cef_device_vendor: 'Ven\\|dor',
      cef_device_product: 'Product',
      cef_device_version: '1.0',
      cef_signature_id: '100',
      cef_name: 'Login',
      cef_severity: '5',
      suser: 'bob',
    });
    expect(events[1]!.fields).toMatchObject({ cef_signature_id: '101', cef_name: 'Logout' });
  });
});
