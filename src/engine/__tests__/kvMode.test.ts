import { describe, it, expect } from 'vitest';
import { applyKvMode } from '../processors/kvMode';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string): SplunkEvent {
  return makeEvent(raw);
}

function dir(value: string): ConfDirective {
  return { key: 'KV_MODE', value, line: 1, directiveType: 'KV_MODE' };
}

describe('applyKvMode — json', () => {
  it('flattens a whole-event JSON object', () => {
    const r = applyKvMode([event('{"action":"login","user":{"name":"alice"}}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['action']).toBe('login');
    expect(r.fields['user.name']).toBe('alice');
    expect(r.fields['user']).toBeUndefined();
  });

  it('uses {} multivalue notation for arrays of objects', () => {
    const r = applyKvMode([event('{"items":[{"id":1},{"id":2}]}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['items{}.id']).toEqual(['1', '2']);
  });

  it('decodes escaped quotes and newlines inside JSON strings', () => {
    const r = applyKvMode([event('{"q":"say \\"hi\\"","m":"a\\nb"}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['q']).toBe('say "hi"');
    expect(r.fields['m']).toBe('a\nb');
  });

  it('extracts an embedded JSON object from surrounding text', () => {
    const r = applyKvMode([event('level=info payload={"a":1,"b":2}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['a']).toBe('1');
    expect(r.fields['b']).toBe('2');
  });

  it('extracts a top-level JSON array rather than just its first element', () => {
    const r = applyKvMode([event('[1,2,3]')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['{}']).toEqual(['1', '2', '3']);
  });

  it('extracts keys named after Object.prototype members without corruption', () => {
    // `fields` is a plain object that inherits Object.prototype, so a naive
    // `fields[name] === undefined` check would read back the inherited function
    // for keys like `toString`/`valueOf`, mangle the value into a multivalue,
    // and silently drop the field from the extracted list.
    const r = applyKvMode(
      [event('{"toString":"x","valueOf":"y","hasOwnProperty":"z"}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(r.fields['toString']).toBe('x');
    expect(r.fields['valueOf']).toBe('y');
    expect(r.fields['hasOwnProperty']).toBe('z');
  });

  it('still promotes genuinely repeated prototype-named keys to multivalue', () => {
    const r = applyKvMode(
      [event('{"items":[{"toString":"a"},{"toString":"b"}]}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(r.fields['items{}.toString']).toEqual(['a', 'b']);
  });

  it('extracts constructor/prototype keys as real fields (Splunk does)', () => {
    const r = applyKvMode([event('{"constructor":"a","prototype":"b"}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(Object.prototype.hasOwnProperty.call(r.fields, 'constructor')).toBe(true);
    expect(r.fields['constructor']).toBe('a');
    expect(r.fields['prototype']).toBe('b');
  });

  it('extracts a __proto__ key as a field without polluting Object.prototype', () => {
    const r = applyKvMode([event('{"__proto__":"pwned","keep":"ok"}')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(Object.prototype.hasOwnProperty.call(r.fields, '__proto__')).toBe(true);
    expect(r.fields['__proto__']).toBe('pwned');
    expect(r.fields['keep']).toBe('ok');
    // Object.prototype and the bag's own prototype must be untouched.
    expect(Object.getPrototypeOf(r.fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['keep']).toBeUndefined();
  });

  it('does NOT scavenge bare leaf fields from a nested object when the outer JSON is malformed', () => {
    // The whole event fails JSON.parse (`<ID>` is not a valid token), but the nested
    // `alert` object is locally well-formed. Flattening that inner object without
    // its path prefix would invent bare `action`/`category` fields that Splunk
    // never produces, so it extracts nothing and reports the parse error.
    const malformed =
      '{"firewall_name":"fw","event":{"app_proto":"ntp",' +
      '"alert":{"action":"blocked","signature_id":3,"rev":0,"signature":"s","category":"","severity":3},' +
      '"flow_id":<ID>}}';
    const diagnostics: ValidationDiagnostic[] = [];
    const r = applyKvMode([event(malformed)], [dir('json')], runCtx(FIXED_NOW, diagnostics))[0]!;

    expect(r.fields['action']).toBeUndefined();
    expect(r.fields['category']).toBeUndefined();
    expect(r.fields['event.alert.action']).toBeUndefined();
    expect(Object.keys(r.fields)).toHaveLength(0);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.level).toBe('warning');
    expect(diagnostics[0]!.message).toMatch(/not valid JSON/);
    // The warning is a data problem: it targets the Raw Log panel, not props.conf,
    // and points at the offending input line.
    expect(diagnostics[0]!.file).toBe('raw');
    expect(diagnostics[0]!.line).toBe(1);
  });

  it('extracts the full dotted field set once the malformed JSON is valid', () => {
    const valid =
      '{"firewall_name":"fw","event":{"app_proto":"ntp",' +
      '"alert":{"action":"blocked","signature_id":3},"flow_id":123}}';
    const diagnostics: ValidationDiagnostic[] = [];
    const r = applyKvMode([event(valid)], [dir('json')], runCtx(FIXED_NOW, diagnostics))[0]!;

    expect(r.fields['firewall_name']).toBe('fw');
    expect(r.fields['event.app_proto']).toBe('ntp');
    expect(r.fields['event.alert.action']).toBe('blocked');
    expect(r.fields['event.flow_id']).toBe('123');
    expect(diagnostics).toHaveLength(0);
  });

  it('warns (without scavenging) when malformed JSON is seen in default auto mode', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const r = applyKvMode([event('{"a":1,"b":<ID>}')], [], runCtx(FIXED_NOW, diagnostics))[0]!;
    expect(Object.keys(r.fields)).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/KV_MODE = auto/);
  });
});

describe('applyKvMode — a leading [ is not by itself JSON (#289)', () => {
  // Not a claim about Splunk: this is about when the simulator's own warning fires,
  // which Splunk has no counterpart for.
  it.each(['json', 'auto'])('does not warn about a bracketed log prefix under KV_MODE = %s', (mode) => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode(
      [event('[INFO] started'), event('[main] worker ready'), event('  [ WARN ] disk low'), event('[')],
      [dir(mode)],
      runCtx(FIXED_NOW, diagnostics),
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('does not warn about a bracketed timestamp, which starts with a digit', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode(
      [event('[2026-01-15 10:00:00] started'), event('[1737000000] tick')],
      [dir('json')],
      runCtx(FIXED_NOW, diagnostics),
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('still extracts key=value pairs after a bracketed prefix', () => {
    const r = applyKvMode([event('[INFO] user=alice status=ok')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['user']).toBe('alice');
    expect(r.fields['status']).toBe('ok');
  });

  it.each([
    ['an object', '[{"a":<ID>}]'],
    ['a nested array', '[[1,2]'],
    ['a string', '["a",]'],
    ['a number', '[1,]'],
    ['a negative number', '[-1,]'],
    ['true', '[true,]'],
    ['false', '[ false,]'],
    ['null', '[\n null,]'],
    ['an empty array', '[ ],]'],
  ])('warns when a malformed array starts with %s', (_label, raw) => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode([event(raw)], [dir('json')], runCtx(FIXED_NOW, diagnostics));
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/not valid JSON/);
  });

  it('still flattens a whole-event array', () => {
    const r = applyKvMode([event('[{"id":1},{"id":2}]')], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['{}.id']).toEqual(['1', '2']);
  });
});

describe('applyKvMode — auto (AUTO_KV_JSON)', () => {
  it('auto-extracts JSON when the event is JSON and KV_MODE is unset (default auto)', () => {
    const r = applyKvMode([event('{"action":"login","code":200}')], [], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['action']).toBe('login');
    expect(r.fields['code']).toBe('200');
  });

  it('still extracts key=value pairs alongside auto JSON', () => {
    const r = applyKvMode([event('status=ok count=3')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['status']).toBe('ok');
    expect(r.fields['count']).toBe('3');
  });

  // A key=value substring inside a quoted value must NOT become a field.
  it('does not extract phantom fields from inside a quoted value', () => {
    const r = applyKvMode([event('msg="error code=42 occurred"')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe('error code=42 occurred');
    expect(r.fields['code']).toBeUndefined();
  });

  it('still extracts real bare pairs that follow a quoted value', () => {
    const r = applyKvMode([event('msg="x=1 y=2" status=ok')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe('x=1 y=2');
    expect(r.fields['status']).toBe('ok');
    expect(r.fields['x']).toBeUndefined();
    expect(r.fields['y']).toBeUndefined();
  });

  it('does not auto-extract JSON when AUTO_KV_JSON=false', () => {
    const r = applyKvMode(
      [event('{"action":"login"}')],
      [dir('auto'), { key: 'AUTO_KV_JSON', value: 'false', line: 2, directiveType: 'AUTO_KV_JSON' }],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(r.fields['action']).toBeUndefined();
  });
});

describe('applyKvMode — auto_escaped', () => {
  it('honours backslash-escaped quotes inside quoted values', () => {
    const r = applyKvMode([event('msg="say \\"hi\\"" user=bob')], [dir('auto_escaped')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['msg']).toBe('say "hi"');
    expect(r.fields['user']).toBe('bob');
  });

  it('plain auto stops the value at the first inner quote', () => {
    const r = applyKvMode([event('msg="say \\"hi\\""')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    // Without escape handling the value terminates at the first inner quote.
    expect(r.fields['msg']).toBe('say \\');
  });
});

describe('applyKvMode — multi (multikv)', () => {
  it('extracts columns from a space-aligned table as multivalue fields', () => {
    const raw = ['name   age   city', 'alice  30    NYC', 'bob    25    LA'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['name']).toEqual(['alice', 'bob']);
    expect(r.fields['age']).toEqual(['30', '25']);
    expect(r.fields['city']).toEqual(['NYC', 'LA']);
  });

  it('skips a dashed separator row under the header', () => {
    const raw = ['user   code', '-----  ----', 'alice  200'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['user']).toBe('alice');
    expect(r.fields['code']).toBe('200');
  });

  it('parses a left-aligned table whose values are narrower than the headers', () => {
    // The header tokens ("NAME"@0, "AGE"@5) are wider than the values, so a
    // fixed-width slice at the header offsets would cut "bob 40" into
    // NAME="bob 4"/AGE="0". Whitespace tokenization recovers the real columns.
    const raw = ['NAME AGE', 'bob 40', 'alice 7'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['NAME']).toEqual(['bob', 'alice']);
    expect(r.fields['AGE']).toEqual(['40', '7']);
  });

  it('parses ps-style output where values are not column-aligned', () => {
    const raw = ['PID   TTY   STAT', '1 ?     Ss', '4242 pts/0 R+'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['PID']).toEqual(['1', '4242']);
    expect(r.fields['TTY']).toEqual(['?', 'pts/0']);
    expect(r.fields['STAT']).toEqual(['Ss', 'R+']);
  });
});

describe('applyKvMode — a value may contain = (#170)', () => {
  it('splits on the first = and keeps the rest of the token', () => {
    const out = applyKvMode([event('filter=a=b query=x=y=z plain=ok')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(out.fields['filter']).toBe('a=b');
    expect(out.fields['query']).toBe('x=y=z');
    expect(out.fields['plain']).toBe('ok');
  });

  it('does not invent a field from the text after an inner =', () => {
    const out = applyKvMode([event('filter=a=b')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(Object.keys(out.fields)).toEqual(['filter']);
  });

  it('still handles base64, which routinely ends in padding', () => {
    const out = applyKvMode([event('token=aGVsbG8= next=1')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(out.fields['token']).toBe('aGVsbG8=');
    expect(out.fields['next']).toBe('1');
  });
});

describe('applyKvMode — purely numeric field names are rejected (#166)', () => {
  it('extracts nothing from numeric keys', () => {
    // Reached in real data through a SEDCMD backreference that swaps each pair.
    const out = applyKvMode([event('2026-01-15T10:00:00Z 1=a 2=b')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(out.fields['1']).toBeUndefined();
    expect(out.fields['2']).toBeUndefined();
  });
});

describe('applyKvMode — extraction never mutates the input event (#63)', () => {
  // multikv, as the other multivalue-accumulating mode; xml has its own file.
  const TABLE = 'NAME  VALUE\na     1\nb     2';

  it('leaves a pre-existing multivalue array on the input untouched', () => {
    const shared = ['zero'];
    const ev = { ...event(TABLE), fields: { NAME: shared } };
    applyKvMode([ev], [dir('multi')], runCtx(FIXED_NOW));
    expect(shared).toEqual(['zero']);
    expect(ev.fields.NAME).toEqual(['zero']);
  });

  it('records an append so the result is not discarded', () => {
    const ev = { ...event(TABLE), fields: { NAME: ['zero'] } };
    const out = applyKvMode([ev], [dir('multi')], runCtx(FIXED_NOW))[0]!;
    expect(out.fields['NAME']).toEqual(['zero', 'a', 'b']);
  });
});

describe('applyKvMode — KV_TRIM_SPACES (#274)', () => {
  // Doc-derived: props.conf.spec 10.4.3, KV_TRIM_SPACES. Default true strips the outer spaces
  // from an automatic key=value value, false keeps them, tabs are never
  // trimmed, and it applies to KV_MODE auto and auto_escaped.
  const trim = (value: string): ConfDirective => ({
    key: 'KV_TRIM_SPACES',
    value,
    line: 2,
    directiveType: 'KV_TRIM_SPACES',
  });

  it('strips outer spaces by default, as in the spec example', () => {
    const r = applyKvMode([event('myfield=" apples "')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['myfield']).toBe('apples');
  });

  it('keeps the inner spaces', () => {
    const r = applyKvMode([event("note='  not found  '")], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['note']).toBe('not found');
  });

  it('keeps outer spaces when false', () => {
    const r = applyKvMode([event('myfield=" apples "')], [dir('auto'), trim('false')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['myfield']).toBe(' apples ');
  });

  it('trims spaces only, never tabs', () => {
    const r = applyKvMode([event('myfield="\t apples \t"')], [dir('auto')], runCtx(FIXED_NOW))[0]!;
    expect(r.fields['myfield']).toBe('\t apples \t');
  });

  it('applies to auto_escaped too', () => {
    const on = applyKvMode([event('msg=" say \\"hi\\" "')], [dir('auto_escaped')], runCtx(FIXED_NOW))[0]!;
    const off = applyKvMode(
      [event('msg=" say \\"hi\\" "')],
      [dir('auto_escaped'), trim('false')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(on.fields['msg']).toBe('say "hi"');
    expect(off.fields['msg']).toBe(' say "hi" ');
  });

  it('is read from the props.conf stanza by the pipeline', () => {
    const at = (body: string) =>
      runPipeline(
        'myfield=" apples "',
        { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
        `[st]\nSHOULD_LINEMERGE = false\nKV_MODE = auto\n${body}`,
        '',
        { perEventPipeline: false, captureOffsets: false },
      ).result.events[0]!.fields['myfield'];
    expect(at('')).toBe('apples');
    expect(at('KV_TRIM_SPACES = false\n')).toBe(' apples ');
  });
});

describe('applyKvMode — json depth limit skips only the deep subtree (#357)', () => {
  // Not doc-derived: the depth limit is this simulator's own guard, so the
  // assertion is only that it costs nothing beyond the subtree it cuts off.
  const nest = (levels: number): string =>
    levels === 0 ? '"bottom"' : `{"v":"level${levels}","n":${nest(levels - 1)}}`;

  it('keeps shallow siblings that follow an over-deep object', () => {
    const r = applyKvMode(
      [event(`{"a":"first","deep":${nest(12)},"status":"ok"}`)],
      [dir('json')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(r.fields['a']).toBe('first');
    expect(r.fields['status']).toBe('ok');
    // Shallow parts of the deep branch survive too; only past the limit is lost.
    expect(r.fields['deep.v']).toBe('level12');
    expect(Object.values(r.fields)).not.toContain('bottom');
    expect(r.processingTrace.at(-1)?.description).toMatch(/depth limit reached/);
  });

  it('keeps later array elements after an over-deep one', () => {
    const r = applyKvMode(
      [event(`{"items":[${nest(12)},{"id":"2"}],"status":"ok"}`)],
      [dir('json')],
      runCtx(FIXED_NOW),
    )[0]!;
    expect(r.fields['items{}.id']).toBe('2');
    expect(r.fields['status']).toBe('ok');
  });

  it('does not report the limit when nothing was cut off', () => {
    const r = applyKvMode([event(`{"a":"first","deep":${nest(3)}}`)], [dir('json')], runCtx(FIXED_NOW))[0]!;
    expect(r.processingTrace.at(-1)?.description).not.toMatch(/depth limit/);
  });
});
