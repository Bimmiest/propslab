// Tests written against mutants that survived `npm run test:mutation` (#370):
// each one pins a behaviour of EXTRACT- that the suite ran but never asserted,
// so a change that broke it would have passed. Grouped by the branch they hold.
import { describe, it, expect } from 'vitest';
import { extractFields, parseExtractValue } from '../processors/fieldExtractor';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
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

function dir(className: string, value: string, line = 1): ConfDirective {
  return { key: `EXTRACT-${className}`, value, line, directiveType: 'EXTRACT', className };
}

describe('EXTRACT — a pattern that cannot be compiled', () => {
  it('warns once, names the class, and records a regex-invalid no-op on every event', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const out = extractFields([event('a'), event('b')], [dir('broken', '(?<x>unclosed', 7)], runCtx(diagnostics));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', file: 'props.conf', line: 7, directiveKey: 'EXTRACT-broken' });
    expect(diagnostics[0]!.message).toMatch(/^EXTRACT-broken was skipped/);

    for (const e of out) {
      expect(e.noOps).toHaveLength(1);
      expect(e.noOps![0]).toMatchObject({ directive: 'EXTRACT-broken', line: 7, phase: 'search-time' });
      expect(e.noOps![0]!.reason.kind).toBe('regex-invalid');
      const reason = e.noOps![0]!.reason as { kind: 'regex-invalid'; error: string };
      expect(reason.error.length).toBeGreaterThan(0);
    }
  });

  it('does not warn about a pattern that compiled', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractFields([event('a=1')], [dir('ok', 'a=(?<a>\\d)')], runCtx(diagnostics));
    expect(diagnostics).toEqual([]);
  });
});

describe('EXTRACT — "in <field>" naming an underscore-prefixed source', () => {
  it('warns once that the leading underscore will be stripped, and suggests the fix', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const events = [event('x', { user: 'alice' }), event('y', { user: 'bob' })];
    const out = extractFields(events, [dir('u', '(?<first>\\w) in _user', 4)], runCtx(diagnostics));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', line: 4, directiveKey: 'EXTRACT-u' });
    expect(diagnostics[0]!.message).toContain('"_user"');
    expect(diagnostics[0]!.message).toContain('"user"');
    expect(diagnostics[0]!.suggestion).toBe('Replace "in _user" with "in user"');
    // It still extracted nothing — the warning explains the no-op, it does not fix it.
    expect(out[0]!.fields['first']).toBeUndefined();
    expect(out[0]!.noOps![0]!.reason).toEqual({ kind: 'source-key-empty', sourceKey: '_user' });
  });

  it('strips every leading underscore when naming the field Splunk will resolve', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractFields([event('x', { user: 'a' })], [dir('u', '(?<f>\\w) in __user')], runCtx(diagnostics));
    expect(diagnostics[0]!.suggestion).toBe('Replace "in __user" with "in user"');
  });

  it('stays quiet when the stripped name is not a field either', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    extractFields([event('x', { other: 'a' })], [dir('u', '(?<f>\\w) in _user')], runCtx(diagnostics));
    expect(diagnostics).toEqual([]);
  });

  it('stays quiet for a name without a leading underscore', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    // `user_` ends with one — that is not the case the warning is about.
    extractFields([event('x', { user: 'a' })], [dir('u', '(?<f>\\w) in user_')], runCtx(diagnostics));
    expect(diagnostics).toEqual([]);
  });
});

describe('EXTRACT — what a match leaves behind', () => {
  it('records a trace step naming the class and the fields it added', () => {
    const e = extractFields([event('a=1 b=2')], [dir('ab', 'a=(?<a>\\d) b=(?<b>\\d)')], runCtx())[0]!;
    expect(e.processingTrace).toEqual([
      {
        processor: 'EXTRACT-ab',
        phase: 'search-time',
        description: 'Extracted fields: a, b',
        fieldsAdded: ['a', 'b'],
      },
    ]);
    expect(e.noOps).toBeUndefined();
  });

  it('skips an optional group that did not participate rather than writing it', () => {
    const e = extractFields([event('a=1')], [dir('opt', 'a=(?<a>\\d)(?: b=(?<b>\\d))?')], runCtx())[0]!;
    expect(e.fields).toEqual({ a: '1' });
    expect('b' in e.fields).toBe(false);
    expect(e.processingTrace[0]!.fieldsAdded).toEqual(['a']);
  });

  it('explains a match that added nothing because every field was already set', () => {
    const e = extractFields([event('status=500', { status: '200' })], [dir('s', 'status=(?<status>\\d+)')], runCtx())[0]!;
    expect(e.processingTrace).toEqual([]);
    expect(e.noOps).toEqual([
      {
        directive: 'EXTRACT-s',
        file: 'props.conf',
        line: 1,
        phase: 'search-time',
        reason: { kind: 'fields-already-set', fields: ['status'] },
      },
    ]);
  });

  it('reports only the fields that collided when some were new', () => {
    const e = extractFields([event('a=1 b=2', { a: 'x' })], [dir('ab', 'a=(?<a>\\d) b=(?<b>\\d)')], runCtx())[0]!;
    expect(e.fields).toEqual({ a: 'x', b: '2' });
    // A match that added something is not a no-op, even if part of it collided.
    expect(e.noOps).toBeUndefined();
    expect(e.processingTrace[0]!.fieldsAdded).toEqual(['b']);
  });

  it('records a plain no-match when nothing of the pattern matched', () => {
    const e = extractFields([event('zzz')], [dir('n', 'q=(?<q>\\d)')], runCtx())[0]!;
    expect(e.noOps![0]!.reason.kind).toBe('no-match');
  });

  it('appends to no-ops already on the event rather than replacing them', () => {
    const prior = { directive: 'X', file: 'props.conf' as const, line: 9, phase: 'search-time' as const, reason: { kind: 'no-match' as const } };
    const ev = { ...event('zzz'), noOps: [prior] };
    const e = extractFields([ev], [dir('n', 'q=(?<q>\\d)')], runCtx())[0]!;
    expect(e.noOps).toHaveLength(2);
    expect(e.noOps![0]).toBe(prior);
  });

  it('keeps offsets recorded earlier when it adds its own', () => {
    const ev = { ...event('a=1'), fieldOffsets: { earlier: [[0, 1]] as Array<[number, number]> } };
    const e = extractFields([ev], [dir('a', 'a=(?<a>\\d)')], runCtx())[0]!;
    expect(e.fieldOffsets).toEqual({ earlier: [[0, 1]], a: [[2, 3]] });
  });

  it('leaves fieldOffsets absent when nothing positional was captured', () => {
    const e = extractFields([event('zzz')], [dir('n', 'q=(?<q>\\d)')], runCtx())[0]!;
    expect(e.fieldOffsets).toBeUndefined();
  });

  it('returns the input untouched when there is no EXTRACT at all', () => {
    const events = [event('a=1')];
    const other: ConfDirective = { key: 'KV_MODE', value: 'none', line: 1, directiveType: 'KV_MODE' };
    expect(extractFields(events, [other], runCtx())).toBe(events);
  });

  it('ignores directives that are not EXTRACT', () => {
    const report: ConfDirective = { key: 'REPORT-a', value: 'a=(?<a>\\d)', line: 1, directiveType: 'REPORT', className: 'a' };
    const e = extractFields([event('a=1')], [report, dir('b', 'a=(?<b>\\d)')], runCtx())[0]!;
    expect(e.fields).toEqual({ b: '1' });
  });
});

describe('EXTRACT — reading from a named source field', () => {
  it('reads the first value of a multivalue source field', () => {
    const e = extractFields([event('', { tags: ['id-7', 'id-9'] })], [dir('t', 'id-(?<n>\\d) in tags')], runCtx())[0]!;
    expect(e.fields['n']).toBe('7');
  });

  it('treats "in _raw" as the event text', () => {
    const e = extractFields([event('k=v')], [dir('r', 'k=(?<k>\\w) in _raw')], runCtx())[0]!;
    expect(e.fields['k']).toBe('v');
  });

  it('records no offsets for a value read from a field, whose positions are not _raw positions', () => {
    const e = extractFields([event('zzz', { src: 'k=v' })], [dir('r', 'k=(?<k>\\w) in src')], runCtx())[0]!;
    expect(e.fields['k']).toBe('v');
    expect(e.fieldOffsets).toBeUndefined();
  });
});

describe('parseExtractValue', () => {
  it('accepts any run of whitespace between "in" and the field', () => {
    expect(parseExtractValue('(?<a>\\w+) in \t src')).toEqual({ pattern: '(?<a>\\w+)', sourceField: 'src' });
  });

  it('trims the value first, so a trailing space does not hide the source field', () => {
    expect(parseExtractValue('  (?<a>\\w+) in src   ')).toEqual({ pattern: '(?<a>\\w+)', sourceField: 'src' });
  });

  it('accepts a double-quoted field name containing a space', () => {
    expect(parseExtractValue('(?<a>\\w+) in "my field"')).toEqual({ pattern: '(?<a>\\w+)', sourceField: 'my field' });
  });

  it('keeps a pattern that spans lines', () => {
    expect(parseExtractValue('a\nb(?<x>\\d) in src')).toEqual({ pattern: 'a\nb(?<x>\\d)', sourceField: 'src' });
  });

  it('does not treat an "in" in the middle of the pattern as the suffix', () => {
    expect(parseExtractValue('login in (?<u>\\w+) now')).toEqual({ pattern: 'login in (?<u>\\w+) now' });
  });

  it('needs whitespace after "in": "in(" is part of the pattern', () => {
    expect(parseExtractValue('x in(?<a>\\w)')).toEqual({ pattern: 'x in(?<a>\\w)' });
  });
});
