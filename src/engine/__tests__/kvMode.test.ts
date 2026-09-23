import { describe, it, expect } from 'vitest';
import { applyKvMode } from '../processors/kvMode';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';

function event(raw: string): SplunkEvent {
  return {
    _raw: raw,
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function dir(value: string): ConfDirective {
  return { key: 'KV_MODE', value, line: 1, directiveType: 'KV_MODE' };
}

describe('applyKvMode — json', () => {
  it('flattens a whole-event JSON object', () => {
    const r = applyKvMode([event('{"action":"login","user":{"name":"alice"}}')], [dir('json')])[0]!;
    expect(r.fields['action']).toBe('login');
    expect(r.fields['user.name']).toBe('alice');
    expect(r.fields['user']).toBeUndefined();
  });

  it('uses {} multivalue notation for arrays of objects', () => {
    const r = applyKvMode([event('{"items":[{"id":1},{"id":2}]}')], [dir('json')])[0]!;
    expect(r.fields['items{}.id']).toEqual(['1', '2']);
  });

  it('decodes escaped quotes and newlines inside JSON strings', () => {
    const r = applyKvMode([event('{"q":"say \\"hi\\"","m":"a\\nb"}')], [dir('json')])[0]!;
    expect(r.fields['q']).toBe('say "hi"');
    expect(r.fields['m']).toBe('a\nb');
  });

  it('extracts an embedded JSON object from surrounding text', () => {
    const r = applyKvMode([event('level=info payload={"a":1,"b":2}')], [dir('json')])[0]!;
    expect(r.fields['a']).toBe('1');
    expect(r.fields['b']).toBe('2');
  });

  it('extracts a top-level JSON array rather than just its first element', () => {
    const r = applyKvMode([event('[1,2,3]')], [dir('json')])[0]!;
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
    )[0]!;
    expect(r.fields['toString']).toBe('x');
    expect(r.fields['valueOf']).toBe('y');
    expect(r.fields['hasOwnProperty']).toBe('z');
  });

  it('still promotes genuinely repeated prototype-named keys to multivalue', () => {
    const r = applyKvMode([event('{"items":[{"toString":"a"},{"toString":"b"}]}')], [dir('json')])[0]!;
    expect(r.fields['items{}.toString']).toEqual(['a', 'b']);
  });

  it('extracts constructor/prototype keys as real fields (Splunk does)', () => {
    const r = applyKvMode([event('{"constructor":"a","prototype":"b"}')], [dir('json')])[0]!;
    expect(Object.prototype.hasOwnProperty.call(r.fields, 'constructor')).toBe(true);
    expect(r.fields['constructor']).toBe('a');
    expect(r.fields['prototype']).toBe('b');
  });

  it('extracts a __proto__ key as a field without polluting Object.prototype', () => {
    const r = applyKvMode([event('{"__proto__":"pwned","keep":"ok"}')], [dir('json')])[0]!;
    expect(Object.prototype.hasOwnProperty.call(r.fields, '__proto__')).toBe(true);
    expect(r.fields['__proto__']).toBe('pwned');
    expect(r.fields['keep']).toBe('ok');
    // Object.prototype and the bag's own prototype must be untouched.
    expect(Object.getPrototypeOf(r.fields)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['keep']).toBeUndefined();
  });

  it('does NOT scavenge bare leaf fields from a nested object when the outer JSON is malformed', () => {
    // The whole event fails JSON.parse (`<ID>` is not a valid token), but the nested
    // `alert` object is locally well-formed. The old behaviour flattened that inner
    // object without its path prefix, inventing bare `action`/`category` fields that
    // Splunk never produces. It must now extract nothing and report the parse error.
    const malformed =
      '{"firewall_name":"fw","event":{"app_proto":"ntp",' +
      '"alert":{"action":"blocked","signature_id":3,"rev":0,"signature":"s","category":"","severity":3},' +
      '"flow_id":<ID>}}';
    const diagnostics: ValidationDiagnostic[] = [];
    const r = applyKvMode([event(malformed)], [dir('json')], diagnostics)[0]!;

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
    const r = applyKvMode([event(valid)], [dir('json')], diagnostics)[0]!;

    expect(r.fields['firewall_name']).toBe('fw');
    expect(r.fields['event.app_proto']).toBe('ntp');
    expect(r.fields['event.alert.action']).toBe('blocked');
    expect(r.fields['event.flow_id']).toBe('123');
    expect(diagnostics).toHaveLength(0);
  });

  it('warns (without scavenging) when malformed JSON is seen in default auto mode', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const r = applyKvMode([event('{"a":1,"b":<ID>}')], [], diagnostics)[0]!;
    expect(Object.keys(r.fields)).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/KV_MODE = auto/);
  });
});

describe('applyKvMode — a leading [ is not by itself JSON (#289)', () => {
  // Not from a capture: this is about when the simulator's own warning fires,
  // which Splunk has no counterpart for.
  it.each(['json', 'auto'])('does not warn about a bracketed log prefix under KV_MODE = %s', (mode) => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode(
      [event('[INFO] started'), event('[main] worker ready'), event('  [ WARN ] disk low'), event('[')],
      [dir(mode)],
      diagnostics,
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('does not warn about a bracketed timestamp, which starts with a digit', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyKvMode(
      [event('[2026-01-15 10:00:00] started'), event('[1737000000] tick')],
      [dir('json')],
      diagnostics,
    );
    expect(diagnostics).toHaveLength(0);
  });

  it('still extracts key=value pairs after a bracketed prefix', () => {
    const r = applyKvMode([event('[INFO] user=alice status=ok')], [dir('auto')])[0]!;
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
    applyKvMode([event(raw)], [dir('json')], diagnostics);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.message).toMatch(/not valid JSON/);
  });

  it('still flattens a whole-event array', () => {
    const r = applyKvMode([event('[{"id":1},{"id":2}]')], [dir('json')])[0]!;
    expect(r.fields['{}.id']).toEqual(['1', '2']);
  });
});

describe('applyKvMode — auto (AUTO_KV_JSON)', () => {
  it('auto-extracts JSON when the event is JSON and KV_MODE is unset (default auto)', () => {
    const r = applyKvMode([event('{"action":"login","code":200}')], [])[0]!;
    expect(r.fields['action']).toBe('login');
    expect(r.fields['code']).toBe('200');
  });

  it('still extracts key=value pairs alongside auto JSON', () => {
    const r = applyKvMode([event('status=ok count=3')], [dir('auto')])[0]!;
    expect(r.fields['status']).toBe('ok');
    expect(r.fields['count']).toBe('3');
  });

  // #22: a key=value substring inside a quoted value must NOT become a field.
  it('does not extract phantom fields from inside a quoted value', () => {
    const r = applyKvMode([event('msg="error code=42 occurred"')], [dir('auto')])[0]!;
    expect(r.fields['msg']).toBe('error code=42 occurred');
    expect(r.fields['code']).toBeUndefined();
  });

  it('still extracts real bare pairs that follow a quoted value', () => {
    const r = applyKvMode([event('msg="x=1 y=2" status=ok')], [dir('auto')])[0]!;
    expect(r.fields['msg']).toBe('x=1 y=2');
    expect(r.fields['status']).toBe('ok');
    expect(r.fields['x']).toBeUndefined();
    expect(r.fields['y']).toBeUndefined();
  });

  it('does not auto-extract JSON when AUTO_KV_JSON=false', () => {
    const r = applyKvMode(
      [event('{"action":"login"}')],
      [dir('auto'), { key: 'AUTO_KV_JSON', value: 'false', line: 2, directiveType: 'AUTO_KV_JSON' }],
    )[0]!;
    expect(r.fields['action']).toBeUndefined();
  });
});

describe('applyKvMode — auto_escaped', () => {
  it('honours backslash-escaped quotes inside quoted values', () => {
    const r = applyKvMode([event('msg="say \\"hi\\"" user=bob')], [dir('auto_escaped')])[0]!;
    expect(r.fields['msg']).toBe('say "hi"');
    expect(r.fields['user']).toBe('bob');
  });

  it('plain auto stops the value at the first inner quote', () => {
    const r = applyKvMode([event('msg="say \\"hi\\""')], [dir('auto')])[0]!;
    // Without escape handling the value terminates at the first inner quote.
    expect(r.fields['msg']).toBe('say \\');
  });
});

describe('applyKvMode — multi (multikv)', () => {
  it('extracts columns from a space-aligned table as multivalue fields', () => {
    const raw = ['name   age   city', 'alice  30    NYC', 'bob    25    LA'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')])[0]!;
    expect(r.fields['name']).toEqual(['alice', 'bob']);
    expect(r.fields['age']).toEqual(['30', '25']);
    expect(r.fields['city']).toEqual(['NYC', 'LA']);
  });

  it('skips a dashed separator row under the header', () => {
    const raw = ['user   code', '-----  ----', 'alice  200'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')])[0]!;
    expect(r.fields['user']).toBe('alice');
    expect(r.fields['code']).toBe('200');
  });

  it('parses a left-aligned table whose values are narrower than the headers', () => {
    // The header tokens ("NAME"@0, "AGE"@5) are wider than the values, so a
    // fixed-width slice at the header offsets would cut "bob 40" into
    // NAME="bob 4"/AGE="0". Whitespace tokenization recovers the real columns.
    const raw = ['NAME AGE', 'bob 40', 'alice 7'].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')])[0]!;
    expect(r.fields['NAME']).toEqual(['bob', 'alice']);
    expect(r.fields['AGE']).toEqual(['40', '7']);
  });

  it('parses ps-style output where values are not column-aligned', () => {
    const raw = [
      'PID   TTY   STAT',
      '1 ?     Ss',
      '4242 pts/0 R+',
    ].join('\n');
    const r = applyKvMode([event(raw)], [dir('multi')])[0]!;
    expect(r.fields['PID']).toEqual(['1', '4242']);
    expect(r.fields['TTY']).toEqual(['?', 'pts/0']);
    expect(r.fields['STAT']).toEqual(['Ss', 'R+']);
  });
});

// Filed as #64 on the reading that auto-KV accumulates, which is the more
// common intuition and what postfix/Cisco-style logs suggest. The Splunk 10.4.0
// capture `kvmode-auto-repeated-key` says otherwise: the first occurrence wins
// and the rest are discarded (#169). Ground truth beats the reading.
describe('applyKvMode — a repeated key keeps its first value (#169, was #64)', () => {
  it('keeps the first of a repeated bare key', () => {
    const out = applyKvMode([event('user=alice user=bob')], [dir('auto')])[0]!;
    expect(out.fields.user).toBe('alice');
  });

  it('keeps the first of a repeated quoted key', () => {
    const out = applyKvMode([event('msg="first one" msg="second one"')], [dir('auto')])[0]!;
    expect(out.fields.msg).toBe('first one');
  });

  it('reads "first" positionally, not by which quoting style is scanned first', () => {
    // The quoted sweep runs before the bare one so it can blank its spans out
    // of the bare scan; without ordering by position the later quoted pair
    // would beat the earlier bare one.
    const out = applyKvMode([event('user=alice user="bob smith"')], [dir('auto')])[0]!;
    expect(out.fields.user).toBe('alice');
  });

  it('keeps a single occurrence scalar', () => {
    const out = applyKvMode([event('user=alice')], [dir('auto')])[0]!;
    expect(out.fields.user).toBe('alice');
  });

  it('does not append to a field an earlier processor already extracted', () => {
    const ev = { ...event('user=bob'), fields: { user: 'from-indexed-extraction' } };
    const out = applyKvMode([ev], [dir('auto')])[0]!;
    expect(out.fields.user).toBe('from-indexed-extraction');
  });
});

describe('applyKvMode — a value may contain = (#170)', () => {
  it('splits on the first = and keeps the rest of the token', () => {
    const out = applyKvMode([event('filter=a=b query=x=y=z plain=ok')], [dir('auto')])[0]!;
    expect(out.fields.filter).toBe('a=b');
    expect(out.fields.query).toBe('x=y=z');
    expect(out.fields.plain).toBe('ok');
  });

  it('does not invent a field from the text after an inner =', () => {
    const out = applyKvMode([event('filter=a=b')], [dir('auto')])[0]!;
    expect(Object.keys(out.fields)).toEqual(['filter']);
  });

  it('still handles base64, which routinely ends in padding', () => {
    const out = applyKvMode([event('token=aGVsbG8= next=1')], [dir('auto')])[0]!;
    expect(out.fields.token).toBe('aGVsbG8=');
    expect(out.fields.next).toBe('1');
  });
});

describe('applyKvMode — purely numeric field names are rejected (#166)', () => {
  it('extracts nothing from numeric keys', () => {
    // Reached in real data through a SEDCMD backreference that swaps each pair.
    const out = applyKvMode([event('2026-01-15T10:00:00Z 1=a 2=b')], [dir('auto')])[0]!;
    expect(out.fields['1']).toBeUndefined();
    expect(out.fields['2']).toBeUndefined();
  });

  it('strips the leading digits from a name that merely starts with them', () => {
    // Corrected by the autokv-key-edge-names capture (2fa=on is indexed as
    // `fa`): auto-KV applies the same leading-digit strip as transforms key
    // cleaning. This test previously asserted the digits survived.
    const out = applyKvMode([event('1st=first 2nd=second')], [dir('auto')])[0]!;
    expect(out.fields['st']).toBe('first');
    expect(out.fields['nd']).toBe('second');
    expect(out.fields['1st']).toBeUndefined();
  });
});

describe('applyKvMode — extraction never mutates the input event (#63)', () => {
  // multikv, as the other multivalue-accumulating mode; xml has its own file.
  const TABLE = 'NAME  VALUE\na     1\nb     2';

  it('leaves a pre-existing multivalue array on the input untouched', () => {
    const shared = ['zero'];
    const ev = { ...event(TABLE), fields: { NAME: shared } };
    applyKvMode([ev], [dir('multi')]);
    expect(shared).toEqual(['zero']);
    expect(ev.fields.NAME).toEqual(['zero']);
  });

  it('records an append so the result is not discarded', () => {
    const ev = { ...event(TABLE), fields: { NAME: ['zero'] } };
    const out = applyKvMode([ev], [dir('multi')])[0]!;
    expect(out.fields.NAME).toEqual(['zero', 'a', 'b']);
  });
});

describe('applyKvMode — auto-KV key cleaning (#207)', () => {
  // Pinned by the autokv-key-punctuation and autokv-key-edge-names captures
  // from Splunk 10.4.0: keys go through full transforms-style cleaning
  // (punctuation to underscores, leading digits/underscores stripped), except
  // that a colon is not cleaned — it re-anchors the key.
  it('sanitizes a hyphenated key the way Splunk indexes it', () => {
    const r = applyKvMode([event('2026-01-15T10:00:00Z zone-found=dmz')], [dir('auto')])[0]!;
    expect(r.fields['zone_found']).toBe('dmz');
    expect(r.fields['zone-found']).toBeUndefined();
  });

  it('sanitizes a dotted key, and re-anchors at a colon rather than cleaning it', () => {
    const r = applyKvMode([event('user.name=alice ip:port=1.2.3.4')], [dir('auto')])[0]!;
    expect(r.fields['user_name']).toBe('alice');
    expect(r.fields['port']).toBe('1.2.3.4');
    expect(r.fields['ip_port']).toBeUndefined();
  });

  it('cleans quoted-pair keys through the same rule', () => {
    const r = applyKvMode([event('x-forwarded-for="1.2.3.4, 5.6.7.8"')], [dir('auto')])[0]!;
    expect(r.fields['x_forwarded_for']).toBe('1.2.3.4, 5.6.7.8');
  });

  it('strips leading digits, and drops a key that cleans to nothing', () => {
    const r = applyKvMode([event('2fa=on --=x 7=lucky')], [dir('auto')])[0]!;
    expect(r.fields['fa']).toBe('on');
    expect(r.fields['2fa']).toBeUndefined();
    expect(Object.keys(r.fields)).not.toContain('__');
    expect(Object.values(r.fields)).not.toContain('lucky');
  });

  it('applies first-occurrence-wins on the CLEANED name', () => {
    // Two raw spellings that clean to the same field: the first in the event wins.
    const r = applyKvMode([event('a-b=1 a_b=2')], [dir('auto')])[0]!;
    expect(r.fields['a_b']).toBe('1');
  });
});
