// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins a KV_MODE behaviour the suite executed without asserting.
import { describe, it, expect } from 'vitest';
import { applyKvMode } from '../processors/kvMode';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(raw: string, line = 1): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: line, end: line },
    processingTrace: [],
  };
}

const mode = (value: string): ConfDirective => ({ key: 'KV_MODE', value, line: 1, directiveType: 'KV_MODE' });

describe('KV_MODE = json — JSON embedded in other text', () => {
  it('finds the object behind a prefix even when a string inside it holds a brace and an escaped quote', () => {
    const raw = 'level=info payload={"msg":"a } and \\" here","n":1} trailing';
    const r = applyKvMode([event(raw)], [mode('json')])[0]!;
    expect(r.fields).toEqual({ msg: 'a } and " here', n: '1' });
  });

  it('extracts nothing and reports nothing from an event with no braces', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const ev = event('plain text line');
    const r = applyKvMode([ev], [mode('json')], diagnostics)[0]!;
    expect(r).toBe(ev);
    expect(diagnostics).toEqual([]);
  });

  it('extracts nothing from an object that never closes', () => {
    const r = applyKvMode([event('x {"a":1')], [mode('json')])[0]!;
    expect(r.fields).toEqual({});
  });

  it('does not treat an embedded array as the object it is looking for', () => {
    const r = applyKvMode([event('x [1,2] y')], [mode('json')])[0]!;
    expect(r.fields).toEqual({});
  });

  it('flattens a top-level array of objects', () => {
    const r = applyKvMode([event('[{"a":1},{"a":2}]')], [mode('json')])[0]!;
    expect(r.fields['{}.a']).toEqual(['1', '2']);
  });

  it('extracts nothing from a bare JSON scalar', () => {
    const r = applyKvMode([event('"just a string"')], [mode('json')])[0]!;
    expect(r.fields).toEqual({});
  });
});

describe('KV_MODE — the not-valid-JSON diagnostic', () => {
  it('counts events in the plural and points at the first one', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event('{"a":', 3), event('{"b":', 8)], [mode('json')], diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', file: 'raw', line: 3 });
    expect(diagnostics[0]!.message).toMatch(/^KV_MODE = json: 2 events not valid JSON/);
  });

  it('uses the singular for one event', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event('{"a":')], [mode('json')], diagnostics);
    expect(diagnostics[0]!.message).toMatch(/^KV_MODE = json: 1 event not valid JSON/);
  });

  it('is raised in auto mode for an event that starts like JSON', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event('{"a": oops}')], [], diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/^KV_MODE = auto: 1 event not valid JSON/);
  });

  it('is not raised in auto mode for ordinary text', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event('user=bob action=login')], [], diagnostics);
    expect(diagnostics).toEqual([]);
  });

  it('is not raised for text that merely starts with a bracket and does not end with one', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event('[1] started')], [], diagnostics);
    expect(diagnostics).toEqual([]);
  });

  it('recognises an array with leading whitespace inside the bracket', () => {
    const r = applyKvMode([event('[ {"a":1} ]')], [mode('auto')])[0]!;
    expect(r.fields['{}.a']).toBe('1');
  });

  it('ignores whitespace around a whole-event object', () => {
    const r = applyKvMode([event('  {"a":1}  ')], [mode('auto')])[0]!;
    expect(r.fields['a']).toBe('1');
  });
});

describe('KV_MODE = auto — the trace step', () => {
  it('names the mode and counts the fields', () => {
    const r = applyKvMode([event('a=1 b=2')], [])[0]!;
    expect(r.processingTrace).toEqual([
      { processor: 'KV_MODE(auto)', phase: 'search-time', description: 'Extracted 2 fields via KV_MODE=auto', fieldsAdded: ['a', 'b'] },
    ]);
  });

  it('returns the event itself when nothing was extracted', () => {
    const ev = event('no pairs here');
    expect(applyKvMode([ev], [])[0]).toBe(ev);
  });
});

describe('KV_MODE = auto — quoted values', () => {
  it('extracts every quoted pair, not only one at the start of the event', () => {
    const r = applyKvMode([event('a="x y" b="p q"')], [])[0]!;
    expect(r.fields).toEqual({ a: 'x y', b: 'p q' });
  });

  it('does not unescape backslashes outside auto_escaped', () => {
    const r = applyKvMode([event('path="C:\\\\dir"')], [])[0]!;
    expect(r.fields['path']).toBe('C:\\\\dir');
  });

  it('reads an escaped single-quoted value in auto_escaped mode', () => {
    const r = applyKvMode([event("msg='it\\'s here' n=1")], [mode('auto_escaped')])[0]!;
    expect(r.fields['msg']).toBe("it's here");
    expect(r.fields['n']).toBe('1');
  });

  it('reads an empty single-quoted value in auto_escaped mode', () => {
    const r = applyKvMode([event("a='' b=2")], [mode('auto_escaped')])[0]!;
    expect(r.fields['a']).toBe('');
    expect(r.fields['b']).toBe('2');
  });
});

describe('KV_MODE = xml — what is not a field', () => {
  it('skips an attribute whose value is empty', () => {
    const r = applyKvMode([event('<e id="" kind="x"/>')], [mode('xml')])[0]!;
    expect(r.fields).toEqual({ kind: 'x' });
  });

  it('skips a leaf whose text is only whitespace', () => {
    const r = applyKvMode([event('<e><a>  </a><b>1</b></e>')], [mode('xml')])[0]!;
    expect(r.fields).toEqual({ 'e.b': '1' });
  });

  it('trims the text of a leaf', () => {
    const r = applyKvMode([event('<e><a>  v  </a></e>')], [mode('xml')])[0]!;
    expect(r.fields['e.a']).toBe('v');
  });

  it('names a leaf by its Name attribute when it has one, and by its path when it does not', () => {
    const r = applyKvMode([event('<Data Name="User">bob</Data><Data>plain</Data>')], [mode('xml')])[0]!;
    expect(r.fields['User']).toBe('bob');
    expect(r.fields['Data']).toBe('plain');
    expect(r.fields['Data_Name']).toBe('User');
  });

  it('extracts nothing from text that is not XML', () => {
    const ev = event('<unclosed');
    expect(applyKvMode([ev], [mode('xml')])[0]).toBe(ev);
  });
});

describe('KV_MODE = multi', () => {
  it('ignores blank lines and separator rules between the header and the rows', () => {
    const raw = ['PID   CMD', '', '----- -----', '1     init', '   ', '2     sshd'].join('\n');
    const r = applyKvMode([event(raw)], [mode('multi')])[0]!;
    expect(r.fields).toEqual({ PID: ['1', '2'], CMD: ['init', 'sshd'] });
  });

  it('accepts CRLF line endings', () => {
    const r = applyKvMode([event('A B\r\n1 2')], [mode('multi')])[0]!;
    expect(r.fields).toEqual({ A: '1', B: '2' });
  });

  it('slices by header offsets when a row has more tokens than there are columns', () => {
    const raw = ['USER  COMMAND', 'root  /bin/sh -c x'].join('\n');
    const r = applyKvMode([event(raw)], [mode('multi')])[0]!;
    expect(r.fields).toEqual({ USER: 'root', COMMAND: '/bin/sh -c x' });
  });

  it('leaves a column out of a short row rather than inventing a value', () => {
    const raw = ['USER  NAME  SHELL', 'root'].join('\n');
    const r = applyKvMode([event(raw)], [mode('multi')])[0]!;
    expect(r.fields).toEqual({ USER: 'root' });
  });

  it('needs a header and at least one row', () => {
    const ev = event('PID CMD');
    expect(applyKvMode([ev], [mode('multi')])[0]).toBe(ev);
  });

  it('needs at least two columns', () => {
    const ev = event('ONLY\nvalue');
    expect(applyKvMode([ev], [mode('multi')])[0]).toBe(ev);
  });

  it('treats a row of dashes that also has text as data, not a separator', () => {
    const raw = ['A  B', '-- x'].join('\n');
    const r = applyKvMode([event(raw)], [mode('multi')])[0]!;
    expect(r.fields).toEqual({ A: '--', B: 'x' });
  });
});
