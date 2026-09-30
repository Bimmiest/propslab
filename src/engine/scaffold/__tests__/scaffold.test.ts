import { describe, it, expect } from 'vitest';
import { detectLineFormat } from '../analyzers/lineFormat';
import { detectTimestamp } from '../analyzers/timestamp';
import { detectTruncate } from '../analyzers/truncate';
import { normalizeSourcetype, detectSourcetypeHygiene } from '../analyzers/sourcetype';
import { renderStanza, appendStanza } from '../serialize';
import { scaffoldConfig } from '../scaffoldConfig';
import { runPipeline } from '../../pipeline';
import type { ScaffoldSuggestion } from '../types';

const splitLines = (s: string) => s.split(/\r?\n/);
const byKey = (sugs: ScaffoldSuggestion[], key: string) => sugs.find((s) => s.key === key);

describe('detectLineFormat', () => {
  it('detects JSON-per-line (incl. explicit LINE_BREAKER)', () => {
    const raw = '{"a":1}\n{"a":2}\n{"a":3}';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'KV_MODE')?.value).toBe('json');
    expect(byKey(out, 'SHOULD_LINEMERGE')?.value).toBe('false');
    expect(byKey(out, 'LINE_BREAKER')?.value).toBe('([\\r\\n]+)');
  });

  it('detects XML', () => {
    const raw = '<?xml version="1.0"?><Event><Data>x</Data></Event>';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'KV_MODE')?.value).toBe('xml');
  });

  it('detects CSV via consistent delimiters', () => {
    const raw = 'ts,user,action\n2024,alice,login\n2025,bob,logout';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'INDEXED_EXTRACTIONS')?.value).toBe('csv');
  });

  it('detects multiple newline-separated multi-line JSON objects', () => {
    const raw = '{\n  "a": 1\n}\n{\n  "a": 2\n}';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'LINE_BREAKER')?.value).toBe('([\\r\\n]+)(?=\\{)');
    expect(byKey(out, 'SHOULD_LINEMERGE')?.value).toBe('false');
    expect(byKey(out, 'KV_MODE')?.value).toBe('json');
  });

  // #438: without a breaker the default line merge splits the object at a date.
  it('a single multi-line JSON object also gets a breaker that keeps it whole', () => {
    const raw = '{\n  "a": 1,\n  "b": 2\n}';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'KV_MODE')?.value).toBe('json');
    expect(byKey(out, 'LINE_BREAKER')?.value).toBe('([\\r\\n]+)(?=\\{)');
    expect(byKey(out, 'SHOULD_LINEMERGE')?.value).toBe('false');
  });

  it('breaks XML before each declaration when every document has one', () => {
    const raw =
      '<?xml version="1.0"?>\n<Event>\n  <a>1</a>\n</Event>\n<?xml version="1.0"?>\n<Event>\n  <a>2</a>\n</Event>';
    expect(byKey(detectLineFormat(raw, splitLines(raw)), 'LINE_BREAKER')?.value).toBe('([\\r\\n]+)(?=<\\?xml\\s)');
  });

  it('breaks XML before each top-level element name', () => {
    const raw =
      '<!-- feed -->\n<Event id="1">\n  <Data a="x/y">1</Data>\n  <Empty/>\n</Event>\n<Alert>\n  <b>2</b>\n</Alert>';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'LINE_BREAKER')?.value).toBe('([\\r\\n]+)(?=<(?:Event|Alert)[\\s/>])');
    expect(byKey(out, 'SHOULD_LINEMERGE')?.value).toBe('false');
    expect(byKey(out, 'KV_MODE')?.value).toBe('xml');
  });

  it('proposes only KV_MODE for XML whose top level it cannot place', () => {
    // A declaration on the first document only: breaking before <Event> would
    // strand the declaration; breaking before <?xml would merge the rest.
    const partial = '<?xml version="1.0"?>\n<Event>\n</Event>\n<Event>\n</Event>';
    const unbalanced = '<Event>\n</Event>\n</Event>';
    for (const raw of [partial, unbalanced]) {
      const out = detectLineFormat(raw, splitLines(raw));
      expect(out.map((s) => s.key)).toEqual(['KV_MODE']);
    }
  });

  it('does not mistake a single comma-containing line for CSV', () => {
    const raw = 'this is a sentence, with commas, but not csv';
    expect(byKey(detectLineFormat(raw, splitLines(raw)), 'INDEXED_EXTRACTIONS')).toBeUndefined();
  });

  it('detects whitespace continuation lines → line merge', () => {
    const raw = 'ERROR something failed\n    at foo()\n    at bar()\nERROR next';
    const out = detectLineFormat(raw, splitLines(raw));
    expect(byKey(out, 'SHOULD_LINEMERGE')?.value).toBe('true');
    expect(byKey(out, 'BREAK_ONLY_BEFORE')?.value).toBe('^\\S');
  });

  it('returns nothing for unstructured single-line text', () => {
    const raw = 'just some plain log message here\nanother plain message';
    expect(detectLineFormat(raw, splitLines(raw))).toEqual([]);
  });
});

describe('detectTimestamp', () => {
  it('recognises ISO 8601 with high confidence', () => {
    const raw = '2024-01-15T10:00:00 a\n2024-01-15T10:00:01 b\n2024-01-15T10:00:02 c';
    const out = detectTimestamp(splitLines(raw));
    const tf = byKey(out, 'TIME_FORMAT');
    expect(tf?.value).toBe('%Y-%m-%dT%H:%M:%S');
    expect(tf?.confidence).toBe('high');
  });

  it('derives TIME_PREFIX from the preceding token', () => {
    const raw = 'id=1 ts=2024-01-15T10:00:00 x\nid=2 ts=2024-01-15T10:00:01 y';
    const out = detectTimestamp(splitLines(raw));
    expect(byKey(out, 'TIME_PREFIX')?.value).toBe('ts=');
  });

  it('recognises Apache-style timestamps with a bracket prefix', () => {
    const raw = '10.0.0.1 - - [15/Jan/2024:10:00:00 +0000] "GET /"';
    const out = detectTimestamp(splitLines(raw));
    expect(byKey(out, 'TIME_FORMAT')?.value).toBe('%d/%b/%Y:%H:%M:%S %z');
    expect(byKey(out, 'TIME_PREFIX')?.value).toBe('\\[');
  });

  it('derives a STABLE key-boundary prefix for JSON (not per-event values)', () => {
    const raw =
      '{"eventVersion":"1.08","userIdentity":{"userName":"Alice"},"eventTime":"2024-01-15T10:00:00Z"}\n' +
      '{"eventVersion":"1.08","userIdentity":{"userName":"Bob"},"eventTime":"2024-01-15T10:00:01Z"}';
    const out = detectTimestamp(splitLines(raw));
    // %z now matches the trailing ISO-8601 'Z' (UTC), so the suggested format
    // captures the timezone rather than dropping it.
    expect(byKey(out, 'TIME_FORMAT')?.value).toBe('%Y-%m-%dT%H:%M:%S%z');
    // The prefix is the eventTime key boundary — not the (per-event) Alice/Bob values.
    expect(byKey(out, 'TIME_PREFIX')?.value).toBe('"eventTime":"');
    expect(byKey(out, 'TIME_PREFIX')?.value).not.toContain('Alice');
    // Lookahead is capped to the timestamp length (20, incl. 'Z') + 1, after the prefix.
    expect(byKey(out, 'MAX_TIMESTAMP_LOOKAHEAD')?.value).toBe('21');
  });

  it('recognises leading epoch as %s', () => {
    const raw = '1705312800 event one\n1705312801 event two';
    const out = detectTimestamp(splitLines(raw));
    expect(byKey(out, 'TIME_FORMAT')?.value).toBe('%s');
  });

  // A 13-digit value is a millisecond epoch; real Splunk's %s reads only whole
  // seconds, so it needs %s%3N.
  it('recognises a 13-digit millisecond epoch as %s%3N', () => {
    const raw = '1705312800123 event one\n1705312801456 event two';
    const out = detectTimestamp(splitLines(raw));
    expect(byKey(out, 'TIME_FORMAT')?.value).toBe('%s%3N');
  });

  it('returns nothing when no timestamp is present', () => {
    expect(detectTimestamp(splitLines('no time here\nstill none'))).toEqual([]);
  });
});

describe('detectTruncate', () => {
  it('suggests raising TRUNCATE only for long events', () => {
    const longLine = 'x'.repeat(12000);
    const out = detectTruncate([longLine, longLine]);
    const t = byKey(out, 'TRUNCATE');
    expect(t).toBeDefined();
    expect(Number(t!.value)).toBeGreaterThan(10000);
  });

  it('measures UTF-8 bytes, as TRUNCATE does', () => {
    // 4000 CJK characters are 12000 bytes: over the default, though only 4000 UTF-16 units.
    const t = byKey(detectTruncate(['日'.repeat(4000)]), 'TRUNCATE');
    expect(Number(t?.value)).toBeGreaterThanOrEqual(12000);
  });

  it('stays silent for short events (default is fine)', () => {
    expect(detectTruncate(['short line', 'another short one'])).toEqual([]);
  });
});

describe('normalizeSourcetype', () => {
  it('normalises a messy sourcetype', () => {
    expect(normalizeSourcetype('MyApp Logs')).toBe('myapp:logs');
  });

  it('leaves an already-hygienic sourcetype alone', () => {
    expect(normalizeSourcetype('cisco:asa')).toBeNull();
    expect(normalizeSourcetype('access_combined')).toBeNull();
  });

  it('detectSourcetypeHygiene emits an opt-in suggestion', () => {
    const s = detectSourcetypeHygiene('MyApp Logs');
    expect(s?.value).toBe('myapp:logs');
    expect(s?.enabledByDefault).toBe(false);
  });
});

describe('serialize', () => {
  it('renders a stanza', () => {
    const stanza = renderStanza('my:st', [
      { key: 'TIME_FORMAT', value: '%Y-%m-%d', confidence: 'high', evidence: '', enabledByDefault: true },
      { key: 'KV_MODE', value: 'json', confidence: 'high', evidence: '', enabledByDefault: true },
    ]);
    expect(stanza).toBe('[my:st]\nTIME_FORMAT = %Y-%m-%d\nKV_MODE = json');
  });

  it('appends to existing config with a blank-line separator', () => {
    expect(appendStanza('[old]\nKV_MODE = none', '[new]\nKV_MODE = json')).toBe(
      '[old]\nKV_MODE = none\n\n[new]\nKV_MODE = json\n',
    );
  });

  it('sets directly when config is empty', () => {
    expect(appendStanza('   ', '[new]\nX = 1')).toBe('[new]\nX = 1\n');
  });
});

describe('scaffoldConfig (integration)', () => {
  it('proposes JSON + timestamp directives and drops KV_MODE when indexed extraction wins', () => {
    const raw = 'ts,msg\n2024-01-15T10:00:00,hello\n2024-01-15T10:00:01,world';
    const result = scaffoldConfig(raw, { index: 'main', host: '', source: '', sourcetype: 'My CSV' });
    // CSV → INDEXED_EXTRACTIONS, and KV_MODE must not coexist with it.
    expect(byKey(result.suggestions, 'INDEXED_EXTRACTIONS')?.value).toBe('csv');
    expect(byKey(result.suggestions, 'KV_MODE')).toBeUndefined();
    // sourcetype hygiene suggestion drives the stanza name.
    expect(result.sourcetype).toBe('my:csv');
    expect(result.sourcetypeSuggestion?.value).toBe('my:csv');
  });

  it('falls back to a placeholder sourcetype when none is set', () => {
    const result = scaffoldConfig('{"a":1}', { index: 'main', host: '', source: '', sourcetype: '' });
    expect(result.sourcetype).toBe('my:sourcetype');
    expect(byKey(result.suggestions, 'KV_MODE')?.value).toBe('json');
  });
});

// #438: the scaffolded stanza, applied as written, must keep each pretty-printed
// object whole. Dates inside the objects are what the default line merge
// (BREAK_ONLY_BEFORE_DATE) would otherwise break on.
describe('scaffoldConfig end to end — one event per multi-line object', () => {
  const META = { index: 'main', host: '', source: '', sourcetype: 'app:doc' };

  const json = (n: number) =>
    `{\n  "id": ${n},\n  "user": "alice",\n  "created": "2024-01-15T10:00:0${n}Z",\n  "detail": {\n    "updated": "2024-01-15 10:05:0${n}"\n  }\n}`;
  const xml = (n: number, declared: boolean) =>
    `${declared ? '<?xml version="1.0"?>\n' : ''}<Event>\n  <Id>${n}</Id>\n  <Created>2024-01-15T10:00:0${n}Z</Created>\n  <Updated>2024-01-15 10:05:0${n}</Updated>\n</Event>`;

  const cases: Array<[string, string[]]> = [
    ['one JSON object', [json(1)]],
    ['three JSON objects', [json(1), json(2), json(3)]],
    ['one XML document', [xml(1, false)]],
    ['three XML documents', [xml(1, false), xml(2, false), xml(3, false)]],
    ['one declared XML document', [xml(1, true)]],
    ['three declared XML documents', [xml(1, true), xml(2, true), xml(3, true)]],
  ];

  it.each(cases)('%s', (_label, objects) => {
    const raw = objects.join('\n');
    const { sourcetype, suggestions } = scaffoldConfig(raw, META);
    const props = renderStanza(
      sourcetype,
      suggestions.filter((s) => s.enabledByDefault),
    );
    const { result } = runPipeline(raw, { ...META, sourcetype }, props, '');
    expect(result.events.map((e) => e._raw)).toEqual(objects);
  });
});

// Follow-up to #438: TRUNCATE caps a LINE_BREAKER segment, and the breaker the
// scaffold proposes keeps a pretty-printed object as one segment, so the
// suggestion must size against the object, not its longest `\n` line.
describe('scaffoldConfig end to end — TRUNCATE sized to the whole object', () => {
  const META = { index: 'main', host: '', source: '', sourcetype: 'app:doc' };

  it('keeps a ~15k-character pretty-printed JSON object whole and untruncated', () => {
    const items = Array.from({ length: 300 }, (_, i) => `    { "i": ${i}, "note": "item ${i} ${'x'.repeat(10)}" }`);
    const raw = `{\n  "created": "2024-01-15T10:00:00Z",\n  "items": [\n${items.join(',\n')}\n  ]\n}`;
    expect(raw.length).toBeGreaterThan(14000);
    expect(raw.length).toBeLessThan(16000);

    const { sourcetype, suggestions } = scaffoldConfig(raw, META);
    expect(Number(byKey(suggestions, 'TRUNCATE')?.value)).toBeGreaterThanOrEqual(raw.length);
    const props = renderStanza(
      sourcetype,
      suggestions.filter((s) => s.enabledByDefault),
    );
    const { result } = runPipeline(raw, { ...META, sourcetype }, props, '');
    expect(result.events.map((e) => e._raw)).toEqual([raw]);
    expect(result.events[0]?.fields['meta']).toBeUndefined();
  });
});
