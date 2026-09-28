import { describe, it, expect } from 'vitest';
import { extractFields, parseExtractValue } from '../processors/fieldExtractor';
import type { SplunkEvent, ConfDirective } from '../types';
import { runCtx } from './runCtx';

function event(raw: string, fields: Record<string, string | string[]> = {}): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields,
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function dir(className: string, value: string): ConfDirective {
  return { key: `EXTRACT-${className}`, value, line: 1, directiveType: 'EXTRACT', className };
}

describe('extractFields — fieldOffsets provenance', () => {
  it('records start/end offsets for positional captures against _raw', () => {
    const raw = '192.168.1.30 - admin [21/Apr/2026:10:00:00] "GET /x HTTP/1.0"';
    const e = extractFields([event(raw)], [dir('user', '^\\S+\\s+-\\s+(?<user>\\S+)\\s')], runCtx())[0]!;
    expect(e.fields['user']).toBe('admin');
    const offsets = e.fieldOffsets?.['user'];
    expect(offsets).toHaveLength(1);
    const [s, end] = offsets![0]!;
    expect(raw.substring(s, end)).toBe('admin');
    // Authoritative position is the first 'admin', not any later repetition
    expect(s).toBe(raw.indexOf('admin'));
  });

  it('extracts only the first match (inline EXTRACT defaults to max_match=1)', () => {
    const raw = 'id=1 id=2 id=3';
    const e = extractFields([event(raw)], [dir('id', 'id=(?<id>\\d+)')], runCtx())[0]!;
    // Inline EXTRACT is first-match-only — not multivalue. Multivalue requires a
    // transforms.conf REGEX with MV_ADD, which EXTRACT does not support.
    expect(e.fields['id']).toBe('1');
    const offsets = e.fieldOffsets?.['id'];
    expect(offsets).toHaveLength(1);
    expect(raw.substring(offsets![0]![0], offsets![0]![1])).toBe('1');
  });

  it('does not overwrite a field already set by an earlier EXTRACT (first wins)', () => {
    const raw = 'a=first a=second';
    // Class names sort alphabetically: aaa runs before bbb.
    const e = extractFields(
      [event(raw)],
      [dir('bbb', 'a=(?<val>\\w+)\\s'), dir('aaa', 'a=second')],
      runCtx(),
    )[0]!;
    // Both directives would set different things, but the key check: a field set
    // by the first-run extraction is not clobbered. Here `val` is set once.
    expect(e.fields['val']).toBe('first');
  });

  it('does not overwrite a pre-existing field value', () => {
    const raw = 'status=500';
    const e = extractFields([event(raw, { status: '200' })], [dir('s', 'status=(?<status>\\d+)')], runCtx())[0]!;
    expect(e.fields['status']).toBe('200');
  });

  it('does not record offsets when EXTRACT targets a non-_raw source field', () => {
    const raw = 'payload: key=value';
    const e = extractFields(
      [event(raw, { message: 'key=value' })],
      [dir('key', '(?<k>\\w+)=(?<v>\\w+) in message')],
      runCtx(),
    )[0]!;
    expect(e.fields['k']).toBe('key');
    // Offsets would be positions inside `message`, not `_raw` — so they must not be recorded.
    expect(e.fieldOffsets?.['k']).toBeUndefined();
    expect(e.fieldOffsets?.['v']).toBeUndefined();
  });

  it('resolves a single-quoted "in" source field (nested JSON name with a period)', () => {
    const e = extractFields(
      [event('raw', { 'event.message': 'key=value' })],
      [dir('key', "(?<k>\\w+)=(?<v>\\w+) in 'event.message'")],
      runCtx(),
    )[0]!;
    expect(e.fields['k']).toBe('key');
    expect(e.fields['v']).toBe('value');
  });

  it('distinguishes repeated identical values by capture position (double-highlight fix)', () => {
    // The reported bug: a regex-extracted value also happens to appear elsewhere in _raw.
    // With offsets, the highlighter targets exactly the capture position — not every indexOf hit.
    const raw = '192.168.1.30 - admin [...] "GET /admin/dashboard HTTP/1.0"';
    const e = extractFields([event(raw)], [dir('user', '^\\S+\\s+-\\s+(?<user>\\S+)\\s')], runCtx())[0]!;
    const offsets = e.fieldOffsets?.['user'];
    expect(offsets).toHaveLength(1);
    // The offset points at the first `admin` (the field value), not `/admin/` in the URL.
    expect(offsets![0]![0]).toBe(raw.indexOf('admin'));
    expect(offsets![0]![0]).toBeLessThan(raw.indexOf('/admin/'));
  });
});

describe('extractFields — captureOffsets (#118)', () => {
  const raw = 'user=admin id=7';
  const dirs = [dir('user', 'user=(?<user>\\w+)')];

  it('captures offsets by default, so the browser keeps its highlighting', () => {
    const e = extractFields([event(raw)], dirs, runCtx())[0]!;
    expect(e.fields['user']).toBe('admin');
    expect(e.fieldOffsets?.['user']).toHaveLength(1);
  });

  it('extracts the same fields with captureOffsets: false, but records no offsets', () => {
    const e = extractFields([event(raw)], dirs, runCtx(undefined, { captureOffsets: false }))[0]!;
    // The point of the option is that ONLY the offsets go away. A caller that
    // renders no highlights must not lose extraction itself.
    expect(e.fields['user']).toBe('admin');
    expect(e.fieldOffsets?.['user']).toBeUndefined();
  });

  it('reports the same offsets PCRE gives, in JS string indices', () => {
    const e = extractFields([event('é😀 user=admin')], dirs, runCtx())[0]!;
    expect(e.fieldOffsets?.['user']).toEqual([[9, 14]]);
  });
});

// Checked on Splunk 10.4.0, not doc-derived (#410). With KV_MODE = none and
// these three EXTRACTs, the input below gave src=abc and after=abc, and no
// `reads`: one pass in class-name order, each extraction reading what the
// earlier ones produced.
describe('extractFields — `in <field>` reads what earlier EXTRACTs produced', () => {
  it('sees a field from an EXTRACT whose class sorts first, and only then', () => {
    const e = extractFields([event('2026-09-28 12:00:00 src="abc"')], [
      dir('a_reads', '(?<reads>\\w+) in src'),
      dir('m_src', 'src="(?<src>[^"]*)"'),
      dir('z_reads_after', '(?<after>\\w+) in src'),
    ], runCtx())[0]!;
    expect(e.fields).toEqual({ src: 'abc', after: 'abc' });
  });
});

// Checked on Splunk 10.4.0, not doc-derived (#411). KV_MODE = none and
// EXTRACT-a_src = src="(?<src>[^"]*)", one event per input line.
describe('extractFields — values are trimmed, and an empty one creates no field', () => {
  const extractSrc = (raw: string) => extractFields([event(raw)], [dir('a_src', 'src="(?<src>[^"]*)"')], runCtx())[0]!;

  it.each([
    ['src="  abc"', 'abc'],
    ['src="abc  "', 'abc'],
    ['src="\tabc\t"', 'abc'],
    ['src=" a b "', 'a b'],
    ['src="abc xyz"', 'abc xyz'],
  ])('%s gives src=%j', (raw, value) => {
    expect(extractSrc(raw).fields['src']).toBe(value);
  });

  it.each(['src="   "', 'src=""'])('%s gives no field, and says why', (raw) => {
    const e = extractSrc(raw);
    expect(e.fields).toEqual({});
    expect(e.noOps?.map((n) => n.reason)).toEqual([{ kind: 'values-empty', fields: ['src'] }]);
  });

  it('highlights the value as stored, without the trimmed whitespace', () => {
    const raw = 'x src="  abc " y';
    const e = extractSrc(raw);
    const [start, end] = e.fieldOffsets!['src']![0]!;
    expect(raw.slice(start, end)).toBe('abc');
  });
});

// Checked on Splunk 10.4.0, not doc-derived (#396). The whitespace before
// `in <field>` separates the two, and exactly one character of it is
// consumed: the rest stays on the end of the pattern. With these EXTRACTs,
// src="abc xyz" (one inner space) gave one and two, and src="abc  xyz" (two)
// gave one, two and three. A tab separates as a space does.
describe('extractFields — whitespace before `in <field>` (#396)', () => {
  const dirs = [
    dir('a_src', 'src="(?<src>[^"]*)"'),
    dir('b_one', '(?<one>\\w+) in src'),
    dir('c_two', '(?<two>\\w+)  in src'),
    dir('d_three', '(?<three>\\w+)   in src'),
    dir('e_tab', '(?<tab>\\w+)\tin src'),
  ];
  const fieldsOf = (raw: string) => extractFields([event(raw)], dirs, runCtx())[0]!.fields;

  it('consumes one whitespace character and keeps the rest in the pattern', () => {
    expect(parseExtractValue('(?<two>\\w+)  in src')).toEqual({ pattern: '(?<two>\\w+) ', sourceField: 'src' });
    expect(parseExtractValue('(?<three>\\w+)   in src')).toEqual({ pattern: '(?<three>\\w+)  ', sourceField: 'src' });
    expect(parseExtractValue('(?<tab>\\w+)\tin src')).toEqual({ pattern: '(?<tab>\\w+)', sourceField: 'src' });
  });

  it('matches what Splunk extracted', () => {
    expect(fieldsOf('src="abc"')).toEqual({ src: 'abc', one: 'abc', tab: 'abc' });
    expect(fieldsOf('src="abc xyz"')).toEqual({ src: 'abc xyz', one: 'abc', two: 'abc', tab: 'abc' });
    expect(fieldsOf('src="abc  xyz"')).toEqual({ src: 'abc  xyz', one: 'abc', two: 'abc', three: 'abc', tab: 'abc' });
  });
});
