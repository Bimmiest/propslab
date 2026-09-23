import { describe, it, expect } from 'vitest';
import { applyRegexTransform } from '../transforms/regexTransform';
import type { SplunkEvent, ConfStanza } from '../types';

function event(raw: string, fields: Record<string, string> = {}): SplunkEvent {
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

function stanza(name: string, directives: Record<string, string>): ConfStanza {
  return {
    name,
    type: 'sourcetype',
    lineRange: { start: 1, end: 1 },
    directives: Object.entries(directives).map(([key, value]) => ({
      key,
      value,
      line: 1,
      directiveType: key,
    })),
  };
}

/**
 * DELIMS, FIELDS, MV_ADD, CLEAN_KEYS and KEEP_EMPTY_VALS are documented as valid
 * only for search-time field extractions, and the engine now honours that — so a
 * test for any of them has to say which pass it is exercising. `applyRegexTransform`
 * defaults to index-time, which is right for DEST_KEY/WRITE_META routing.
 */
function searchTime(ev: SplunkEvent, s: ConfStanza) {
  return applyRegexTransform(ev, s, undefined, 'search-time');
}

describe('applyRegexTransform — zero-length match guard', () => {
  it('terminates on a DEST_KEY=<field> regex that can match the empty string', () => {
    // `(.*)` matches the whole line then an empty string at the end — without a
    // lastIndex guard the global match loop would spin forever and hang the worker.
    // REPEAT_MATCH, or the REGEX runs once and the loop never reaches the empty match.
    const s = stanza('grab', { REGEX: '(.*)', FORMAT: '$1', DEST_KEY: 'myfield', REPEAT_MATCH: 'true' });
    const result = applyRegexTransform(event('hello world'), s);
    expect(result.matched).toBe(true);
    expect(result.destKey).toBe('myfield');
    expect(result.destValue).toContain('hello world');
  });
});

describe('applyRegexTransform — repeated keys are last-wins (#59.2)', () => {
  it('uses the last REGEX when a stanza repeats it', () => {
    const s = stanza('t', {});
    s.directives = [
      { key: 'REGEX', value: '(?<first>\\w+)', line: 1, directiveType: 'REGEX' },
      { key: 'REGEX', value: '(?<second>\\w+)', line: 2, directiveType: 'REGEX' },
    ];
    const result = applyRegexTransform(event('hello'), s);
    expect(result.fields['second']).toBe('hello');
    expect(result.fields['first']).toBeUndefined();
  });

  it('uses the last FORMAT when a stanza repeats it', () => {
    const s = stanza('t', {});
    s.directives = [
      { key: 'REGEX', value: '(\\w+)', line: 1, directiveType: 'REGEX' },
      { key: 'DEST_KEY', value: '_raw', line: 2, directiveType: 'DEST_KEY' },
      { key: 'FORMAT', value: 'A$1', line: 3, directiveType: 'FORMAT' },
      { key: 'FORMAT', value: 'B$1', line: 4, directiveType: 'FORMAT' },
    ];
    const result = applyRegexTransform(event('hi'), s);
    expect(result.destValue).toBe('Bhi');
  });
});

describe('applyRegexTransform — _KEY_/_VAL_ dynamic KV (#61.1)', () => {
  it('maps a _KEY_n group to the field name and _VAL_n to its value', () => {
    const s = stanza('kv', {
      REGEX: '(?<_KEY_1>\\w+)=(?<_VAL_1>\\w+)',
      WRITE_META: 'true',
    });
    const result = applyRegexTransform(event('user=alice'), s);
    expect(result.fields['user']).toBe('alice');
    // The machinery groups themselves must NOT surface as fields.
    expect(result.fields['KEY_1']).toBeUndefined();
    expect(result.fields['VAL_1']).toBeUndefined();
    expect(result.fields['_KEY_1']).toBeUndefined();
  });

  it('handles multiple _KEY_/_VAL_ pairs across REPEAT_MATCH', () => {
    const s = stanza('kv', {
      REGEX: '(?<_KEY_1>\\w+):(?<_VAL_1>\\w+)',
      REPEAT_MATCH: 'true',
    });
    const result = applyRegexTransform(event('a:1 b:2'), s);
    expect(result.fields['a']).toBe('1');
    expect(result.fields['b']).toBe('2');
  });
});

describe('applyRegexTransform — default index-time FORMAT (#61.2)', () => {
  it('defaults FORMAT to <stanza-name>::$1 for numbered groups without a FORMAT', () => {
    const s = stanza('myextract', {
      REGEX: '^(\\w+)',
      WRITE_META: 'true',
    });
    const result = applyRegexTransform(event('hello world'), s);
    expect(result.fields['myextract']).toBe('hello');
  });

  it('applies the default FORMAT to every match (multivalue) under REPEAT_MATCH', () => {
    // Previously asserted every match without REPEAT_MATCH. Corrected in #285
    // (doc-derived): at index time the REGEX runs once unless REPEAT_MATCH is set.
    const s = stanza('word', { REGEX: '(\\w+)', WRITE_META: 'true', REPEAT_MATCH: 'true' });
    const result = applyRegexTransform(event('hello world'), s);
    expect(result.fields['word']).toEqual(['hello', 'world']);
  });

  it('applies the default FORMAT to the first match only without REPEAT_MATCH', () => {
    const s = stanza('word', { REGEX: '(\\w+)', WRITE_META: 'true' });
    const result = applyRegexTransform(event('hello world'), s);
    expect(result.fields['word']).toBe('hello');
  });

  it('leaves a group-less REGEX with no FORMAT extracting nothing', () => {
    const s = stanza('noop', { REGEX: '\\w+@\\w+', WRITE_META: 'true' });
    const result = applyRegexTransform(event('user@host'), s);
    expect(result.matched).toBe(true);
    expect(Object.keys(result.fields)).toHaveLength(0);
  });
});

describe('applyRegexTransform — named capture groups', () => {
  it('extracts named groups into fields when no FORMAT', () => {
    const s = stanza('test', { REGEX: '(?<user>\\w+) (?<action>\\w+)' });
    const result = applyRegexTransform(event('alice login'), s);
    expect(result.matched).toBe(true);
    expect(result.fields['user']).toBe('alice');
    expect(result.fields['action']).toBe('login');
  });

  it('extracts a named group colliding with an Object.prototype member', () => {
    // A `(?<toString>…)` group must not read back the inherited function via a
    // `fields[name] === undefined` guard (which would drop the value with the
    // default MV_ADD=false, or leak the function with MV_ADD=true).
    const s = stanza('test', { REGEX: '(?<toString>\\w+)' });
    const result = applyRegexTransform(event('hello'), s);
    expect(result.matched).toBe(true);
    expect(result.fields['toString']).toBe('hello');
  });

  it('accumulates a repeated prototype-named group into a multivalue with MV_ADD', () => {
    const s = stanza('test', {
      REGEX: '(?<toString>\\w+)',
      REPEAT_MATCH: 'true',
      MV_ADD: 'true',
    });
    const result = searchTime(event('a b c'), s);
    expect(result.fields['toString']).toEqual(['a', 'b', 'c']);
  });

  it('expands named ${name} back-references in FORMAT', () => {
    const s = stanza('test', {
      REGEX: '(?<user>\\w+) (?<action>\\w+)',
      FORMAT: 'user::$1 action::$2',
    });
    const result = applyRegexTransform(event('alice login'), s);
    expect(result.matched).toBe(true);
    expect(result.fields['user']).toBe('alice');
    expect(result.fields['action']).toBe('login');
  });
});

describe('applyRegexTransform — REPEAT_MATCH / MV_ADD', () => {
  it('defaults to the first match only (single value)', () => {
    const s = stanza('nums', { REGEX: '(?<num>\\d+)' });
    const result = searchTime(event('1 2 3'), s);
    expect(result.fields['num']).toBe('1');
  });

  it('REPEAT_MATCH + MV_ADD collects every match into a multivalue field', () => {
    const s = stanza('nums', { REGEX: '(?<num>\\d+)', REPEAT_MATCH: 'true', MV_ADD: 'true' });
    const result = searchTime(event('1 2 3'), s);
    expect(result.fields['num']).toEqual(['1', '2', '3']);
  });

  it('REPEAT_MATCH without MV_ADD keeps the first value and discards the rest', () => {
    const s = stanza('nums', { REGEX: '(?<num>\\d+)', REPEAT_MATCH: 'true' });
    const result = searchTime(event('1 2 3'), s);
    expect(result.fields['num']).toBe('1');
  });

  it('MV_ADD without REPEAT_MATCH still sees every match at search time', () => {
    // Previously asserted '1' (first match only). Corrected in #285: REPEAT_MATCH
    // is inert at search time — the report-transform-search-time capture
    // (10.4.0) extracts repeated matches with MV_ADD and no REPEAT_MATCH — so
    // named groups now scan the same matches the FORMAT path always did.
    const s = stanza('nums', { REGEX: '(?<num>\\d+)', MV_ADD: 'true' });
    const result = searchTime(event('1 2 3'), s);
    expect(result.fields['num']).toEqual(['1', '2', '3']);
  });

  it('REPEAT_MATCH + MV_ADD builds multivalue across multiple named groups', () => {
    const s = stanza('kv', { REGEX: '(?<k>\\w+)=(?<v>\\d+)', REPEAT_MATCH: 'true', MV_ADD: 'true' });
    const result = searchTime(event('a=1 b=2 c=3'), s);
    expect(result.fields['k']).toEqual(['a', 'b', 'c']);
    expect(result.fields['v']).toEqual(['1', '2', '3']);
  });
});

describe('applyRegexTransform — DEST_KEY = _raw replaces the whole event', () => {
  it('replaces the ENTIRE _raw with the FORMAT expansion (uncaptured text is lost)', () => {
    // The classic footgun: the regex matches only the IP, so everything else
    // ("connect from", "port 443") is discarded. To keep it you must capture and
    // reproduce it in FORMAT, or use SEDCMD instead.
    const s = stanza('mask', {
      REGEX: '(?<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)',
      FORMAT: '$1 masked',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('connect from 10.0.0.1 port 443'), s);
    expect(result.matched).toBe(true);
    expect(result.destValue).toBe('10.0.0.1 masked');
  });

  it('expands ${name} in FORMAT and discards the rest of the event', () => {
    const s = stanza('mask', {
      REGEX: '(?<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)',
      FORMAT: '${ip} masked',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('connect from 10.0.0.1 port 443'), s);
    expect(result.destValue).toBe('10.0.0.1 masked');
  });

  it('uses the FIRST match only — the whole event becomes the FORMAT output', () => {
    const s = stanza('redact', {
      REGEX: '(\\d{3}-\\d{4})',
      FORMAT: 'XXXX',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('call 555-1234 or 555-5678'), s);
    // Not "call XXXX or XXXX" — DEST_KEY=_raw replaces the entire event.
    expect(result.destValue).toBe('XXXX');
  });

  it('preserves surrounding text only when the regex captures the whole line', () => {
    // The correct masking idiom: capture everything, reproduce it in FORMAT.
    const s = stanza('mask', {
      REGEX: '(.*?)(\\d+\\.\\d+\\.\\d+\\.\\d+)(.*)',
      FORMAT: '$1REDACTED$3',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('connect from 10.0.0.1 port 443'), s);
    expect(result.destValue).toBe('connect from REDACTED port 443');
  });
});

describe('applyRegexTransform — numbered groups with FORMAT', () => {
  // #61.3: `$0` is the prior DEST_KEY contents (here _raw = the whole event),
  // NOT the regex whole-match. With text around the match the two differ.
  it('substitutes $0 with the prior DEST_KEY (_raw) contents, not the match', () => {
    const s = stanza('wrap', {
      REGEX: '(\\w+)@(\\w+)',
      FORMAT: '[$0]',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('connect user@host now'), s);
    expect(result.destValue).toBe('[connect user@host now]');
  });

  it('substitutes $0 with the prior contents of an arbitrary DEST_KEY field', () => {
    const s = stanza('wrap', {
      REGEX: '(\\w+)@(\\w+)',
      FORMAT: '$0!',
      DEST_KEY: 'dest',
    });
    const ev = event('user@host');
    ev.fields['dest'] = 'previous';
    const result = applyRegexTransform(ev, s);
    // $0 is the field's prior value ("previous"), not the match ("user@host").
    expect(result.destValue).toBe('previous!');
  });

  it('substitutes $1 and $2 with capture groups for DEST_KEY = _raw', () => {
    const s = stanza('reformat', {
      REGEX: '(\\w+)@(\\w+)',
      FORMAT: '$2/$1',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('user@host'), s);
    expect(result.destValue).toBe('host/user');
  });

  // #26: with a single group, `$10` is group 1 followed by a literal `0`, not
  // the non-existent group 10 (which used to collapse the whole output to '').
  it('treats a digit after a single-digit group ref as a literal', () => {
    const s = stanza('grab', {
      REGEX: '(AA)',
      FORMAT: '$10',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('AA'), s);
    expect(result.destValue).toBe('AA0');
  });

  // With enough groups present, `$10` still resolves to group 10.
  it('resolves a genuine two-digit group reference when the group exists', () => {
    const s = stanza('grab', {
      // 10 single-char groups; group 10 captures "J".
      REGEX: '(A)(B)(C)(D)(E)(F)(G)(H)(I)(J)',
      FORMAT: '$10',
      DEST_KEY: '_raw',
    });
    const result = applyRegexTransform(event('ABCDEFGHIJ'), s);
    expect(result.destValue).toBe('J');
  });
});

describe('applyRegexTransform — DELIMS / FIELDS', () => {
  it('extracts field/value pairs with two delimiter sets', () => {
    const s = stanza('pipe_eq', { DELIMS: '"|", "="' });
    const result = searchTime(event('user=alice|action=login|status=200'), s);
    expect(result.matched).toBe(true);
    expect(result.fields['user']).toBe('alice');
    expect(result.fields['action']).toBe('login');
    expect(result.fields['status']).toBe('200');
  });

  it('treats each character in a set as its own delimiter', () => {
    const s = stanza('multi', { DELIMS: '"|;", "="' });
    const result = searchTime(event('a=1|b=2;c=3'), s);
    expect(result.fields['a']).toBe('1');
    expect(result.fields['b']).toBe('2');
    expect(result.fields['c']).toBe('3');
  });

  it('splits key/value on the first kv-delimiter occurrence only', () => {
    const s = stanza('kv', { DELIMS: '" ", "="' });
    const result = searchTime(event('url=/path?a=1'), s);
    expect(result.fields['url']).toBe('/path?a=1');
  });

  it('names positional values via FIELDS with a single DELIMS set', () => {
    const s = stanza('csv', { DELIMS: '","', FIELDS: '"ts", "user", "action"' });
    const result = searchTime(event('2026-01-01,alice,login'), s);
    expect(result.fields['ts']).toBe('2026-01-01');
    expect(result.fields['user']).toBe('alice');
    expect(result.fields['action']).toBe('login');
  });

  it('decodes escape sequences in DELIMS (tab/newline)', () => {
    const s = stanza('tabbed', { DELIMS: '"\\n", ":\\t" ' });
    const result = searchTime(event('key1:\tval1\nkey2:\tval2'), s);
    expect(result.fields['key1']).toBe('val1');
    expect(result.fields['key2']).toBe('val2');
  });

  it('accumulates repeated keys into a multivalue field', () => {
    const s = stanza('rep', { DELIMS: '" ", "="' });
    const result = searchTime(event('tag=a tag=b tag=c'), s);
    expect(result.fields['tag']).toEqual(['a', 'b', 'c']);
  });

  it('drops empty values and pairs without a kv delimiter', () => {
    const s = stanza('sparse', { DELIMS: '"|", "="' });
    const result = searchTime(event('a=1|justtext|b='), s);
    expect(result.fields['a']).toBe('1');
    expect(result.fields['b']).toBeUndefined();
    expect(result.fields['justtext']).toBeUndefined();
  });

  it('reads from SOURCE_KEY when set', () => {
    const s = stanza('fromfield', { DELIMS: '"&", "="', SOURCE_KEY: 'query' });
    const result = searchTime(event('ignored', { query: 'x=1&y=2' }), s);
    expect(result.fields['x']).toBe('1');
    expect(result.fields['y']).toBe('2');
  });
});

describe('applyRegexTransform — no match', () => {
  it('returns matched=false when regex does not match', () => {
    const s = stanza('test', { REGEX: 'NO_MATCH_SENTINEL_XYZ' });
    const result = applyRegexTransform(event('hello world'), s);
    expect(result.matched).toBe(false);
  });
});

describe('applyRegexTransform — DEST_KEY single-value metadata slots', () => {
  it('MetaData:Sourcetype uses first match only even when regex matches many times', () => {
    // Permissive regex like "." matches every character — without the fix this
    // produces "sourcetype::auditd\nsourcetype::auditd\n…" × N.
    const s = stanza('set_sourcetype', {
      REGEX: '.',
      FORMAT: 'sourcetype::auditd',
      DEST_KEY: 'MetaData:Sourcetype',
    });
    const result = applyRegexTransform(event('{"type":"SYSCALL","pid":"100"}'), s);
    expect(result.matched).toBe(true);
    expect(result.destKey).toBe('MetaData:Sourcetype');
    expect(result.destValue).toBe('sourcetype::auditd');
  });

  it('MetaData:Sourcetype works with _MetaData:Sourcetype alias', () => {
    const s = stanza('set_sourcetype', {
      REGEX: '.',
      FORMAT: 'sourcetype::auditd',
      DEST_KEY: '_MetaData:Sourcetype',
    });
    const result = applyRegexTransform(event('raw log line'), s);
    expect(result.destValue).toBe('sourcetype::auditd');
  });

  it('MetaData:Host uses first match only', () => {
    const s = stanza('set_host', {
      REGEX: 'host=(\\w+)',
      FORMAT: 'host::$1',
      DEST_KEY: 'MetaData:Host',
    });
    const result = applyRegexTransform(event('host=web01 host=web02'), s);
    expect(result.destValue).toBe('host::web01');
  });

  it('queue=nullQueue not broken by multi-match regex', () => {
    const s = stanza('drop', {
      REGEX: '.',
      FORMAT: 'nullQueue',
      DEST_KEY: 'queue',
    });
    const result = applyRegexTransform(event('drop me'), s);
    expect(result.destValue).toBe('nullQueue');
  });

  it('arbitrary field DEST_KEY still accumulates multi-values', () => {
    // REPEAT_MATCH added in #285: without it the index-time REGEX runs once.
    const s = stanza('extract_words', {
      REGEX: '(\\w+)',
      FORMAT: '$1',
      DEST_KEY: 'words',
      REPEAT_MATCH: 'true',
    });
    const result = applyRegexTransform(event('foo bar baz'), s);
    expect(result.destKey).toBe('words');
    // Should accumulate all three matches
    expect(result.destValue).toBe('foo\nbar\nbaz');
  });
});

describe('applyRegexTransform — FORMAT is tokenized before capture substitution (#52)', () => {
  it('keeps a captured value containing spaces as one value', () => {
    const r = applyRegexTransform(
      event('msg=disk full'),
      stanza('extract_msg', { REGEX: 'msg=(.*)$', FORMAT: 'message::$1' }),
    );
    expect(r.matched).toBe(true);
    expect(r.fields.message).toBe('disk full');
  });

  it('does not synthesize a phantom field from a captured "::"', () => {
    const r = applyRegexTransform(
      event('data=a::b'),
      stanza('t', { REGEX: 'data=(.*)$', FORMAT: 'payload::$1' }),
    );
    expect(r.fields).toEqual({ payload: 'a::b' });
  });

  it('supports $N on both sides of the separator', () => {
    const r = applyRegexTransform(
      event('color=blue'),
      stanza('t', { REGEX: '(\\w+)=(\\w+)', FORMAT: '$1::$2' }),
    );
    expect(r.fields.color).toBe('blue');
  });

  it('parses several pairs and expands each independently', () => {
    const r = applyRegexTransform(
      event('a=one two b=three'),
      stanza('t', { REGEX: 'a=(.*) b=(.*)$', FORMAT: 'first::$1 second::$2' }),
    );
    expect(r.fields.first).toBe('one two');
    expect(r.fields.second).toBe('three');
  });

  it('keeps quoted literal values intact', () => {
    const r = applyRegexTransform(
      event('x=1'),
      stanza('t', { REGEX: 'x=(\\d)', FORMAT: 'tag::"a b" num::$1' }),
    );
    expect(r.fields.tag).toBe('a b');
    expect(r.fields.num).toBe('1');
  });

  it('still accumulates one value per match across repeated matches', () => {
    const r = applyRegexTransform(
      event('k=a b; k=c d;'),
      stanza('t', { REGEX: 'k=([^;]*);', FORMAT: 'k::$1', REPEAT_MATCH: 'true' }),
    );
    expect(r.fields.k).toEqual(['a b', 'c d']);
  });
});

describe('applyRegexTransform — search-time-only attributes are ignored index-time', () => {
  it('extracts nothing from a DELIMS stanza reached through TRANSFORMS-', () => {
    // DELIMS is the alternative to REGEX, so an index-time reference leaves the
    // stanza with no extraction mechanism at all.
    const s = stanza('pairs', { DELIMS: '"|", "="' });
    const result = applyRegexTransform(event('a=1|b=2'), s, undefined, 'index-time');
    expect(result.matched).toBe(false);
    expect(result.fields).toEqual({});
  });

  it('still extracts from the same stanza at search time', () => {
    const s = stanza('pairs', { DELIMS: '"|", "="' });
    expect(searchTime(event('a=1|b=2'), s).fields).toEqual({ a: '1', b: '2' });
  });

  it('ignores MV_ADD index-time: REPEAT_MATCH accumulates either way', () => {
    // Previously asserted '1' (first value only). Changed in #303 (doc-derived):
    // REPEAT_MATCH runs the REGEX once per match and each match writes the
    // field, which is what the FORMAT path already did (#174 test below). Named
    // groups disagreeing with it was the bug. MV_ADD stays inert here — the
    // MV_ADD = false case below produces the same multivalue.
    const s = stanza('nums', { REGEX: '(?<num>\\d+)', REPEAT_MATCH: 'true', MV_ADD: 'true' });
    const result = applyRegexTransform(event('1 2 3'), s, undefined, 'index-time');
    expect(result.fields['num']).toEqual(['1', '2', '3']);
    const withoutMvAdd = stanza('nums', { REGEX: '(?<num>\\d+)', REPEAT_MATCH: 'true', MV_ADD: 'false' });
    expect(applyRegexTransform(event('1 2 3'), withoutMvAdd, undefined, 'index-time').fields['num']).toEqual([
      '1',
      '2',
      '3',
    ]);
  });
});

describe('applyRegexTransform — CLEAN_KEYS', () => {
  it('rewrites punctuation to underscores and strips the leading run', () => {
    // Pinned by the Splunk 10.4.0 capture in report-delims-field-and-value:
    // `2026-01-15T10:00:00Z a` comes back as `T10_00_00Z_a`.
    const s = stanza('pairs', { DELIMS: '";", "="' });
    const result = searchTime(event('2026-01-15T10:00:00Z a=1;b=2'), s);
    expect(Object.keys(result.fields).sort()).toEqual(['T10_00_00Z_a', 'b']);
  });

  it('keeps interior underscores', () => {
    const s = stanza('cols', { DELIMS: '","', FIELDS: '"col_a", "col_b"' });
    expect(Object.keys(searchTime(event('x,y'), s))).toBeTruthy();
    expect(searchTime(event('x,y'), s).fields).toEqual({ col_a: 'x', col_b: 'y' });
  });

  it('is disabled by CLEAN_KEYS = 0', () => {
    const s = stanza('raw', { REGEX: '([\\w.\\- ]+)=(\\w+)', FORMAT: '$1::$2', CLEAN_KEYS: '0' });
    expect(searchTime(event('my.odd-key=value'), s).fields).toEqual({ 'my.odd-key': 'value' });
  });

  it('is disabled by CLEAN_KEYS = false', () => {
    const s = stanza('raw', { REGEX: '([\\w.\\- ]+)=(\\w+)', FORMAT: '$1::$2', CLEAN_KEYS: 'false' });
    expect(searchTime(event('my.odd-key=value'), s).fields).toEqual({ 'my.odd-key': 'value' });
  });

  it('cleans FORMAT-named keys, which come from the data', () => {
    const s = stanza('kv', { REGEX: '([\\w.\\-]+)=(\\w+)', FORMAT: '$1::$2' });
    expect(searchTime(event('odd.key-name=v'), s).fields).toEqual({ odd_key_name: 'v' });
  });

  it('leaves a key that is already clean alone', () => {
    const s = stanza('kv', { REGEX: '(\\w+)=(\\w+)', FORMAT: '$1::$2' });
    expect(searchTime(event('user=alice'), s).fields).toEqual({ user: 'alice' });
  });
});

describe('#175 — $0 in a FORMAT pair names nothing', () => {
  it('creates no field for a pair whose value is $0', () => {
    const r = applyRegexTransform(
      event('2026-01-15T10:00:00Z code=503'),
      stanza('t', { REGEX: 'code=(\\d+)', FORMAT: 'whole::$0 first::$1' }),
      undefined,
      'search-time',
    );
    expect(r.fields.whole).toBeUndefined();
    expect(r.fields.first).toBe('503');
  });

  it('does not mistake $01 or $10 for a $0 reference', () => {
    const r = applyRegexTransform(
      event('code=503'),
      stanza('t', { REGEX: 'code=(\\d+)', FORMAT: 'a::$10' }),
      undefined,
      'search-time',
    );
    // $10 is group 1 followed by a literal 0, and must survive the $0 filter.
    expect(r.fields.a).toBe('5030');
  });
});

describe('#174 — MV_ADD in the FORMAT-pairs path', () => {
  it('keeps only the first match at search time by default', () => {
    const r = applyRegexTransform(
      event('label=a label=b label=c'),
      stanza('t', { REGEX: 'label=(\\w+)', FORMAT: 'label::$1', REPEAT_MATCH: 'true' }),
      undefined,
      'search-time',
    );
    expect(r.fields.label).toBe('a');
  });

  it('accumulates when MV_ADD is true', () => {
    const r = applyRegexTransform(
      event('label=a label=b'),
      stanza('t', { REGEX: 'label=(\\w+)', FORMAT: 'label::$1', MV_ADD: 'true' }),
      undefined,
      'search-time',
    );
    expect(r.fields.label).toEqual(['a', 'b']);
  });

  it('still accumulates at index time, where MV_ADD is inert', () => {
    // REPEAT_MATCH added in #285: at index time the REGEX runs once without it,
    // so there would be nothing to accumulate. The point here is MV_ADD.
    const r = applyRegexTransform(
      event('label=a label=b'),
      stanza('t', { REGEX: 'label=(\\w+)', FORMAT: 'label::$1', MV_ADD: 'false', REPEAT_MATCH: 'true' }),
    );
    expect(r.fields.label).toEqual(['a', 'b']);
  });
});

// Doc-derived (transforms.conf.spec, REPEAT_MATCH): default false, "only valid
// for index-time field extractions". At index time the REGEX therefore runs
// once unless it is set. Search time is pinned by the report-repeat-match and
// report-transform-search-time captures, which show every match extracted
// regardless (#285).
describe('#285 — REPEAT_MATCH gates repeated matching at index time only', () => {
  it('runs a FORMAT-pairs REGEX once at index time without REPEAT_MATCH', () => {
    const r = applyRegexTransform(
      event('label=a label=b'),
      stanza('t', { REGEX: 'label=(\\w+)', FORMAT: 'label::$1', WRITE_META: 'true' }),
    );
    expect(r.fields.label).toBe('a');
  });

  it('runs a DEST_KEY = <field> REGEX once at index time without REPEAT_MATCH', () => {
    const r = applyRegexTransform(
      event('foo bar'),
      stanza('t', { REGEX: '(\\w+)', FORMAT: '$1', DEST_KEY: 'words' }),
    );
    expect(r.destValue).toBe('foo');
  });

  it('still extracts every match at search time, where REPEAT_MATCH is inert', () => {
    const r = searchTime(
      event('label=a label=b'),
      stanza('t', { REGEX: 'label=(\\w+)', FORMAT: 'label::$1', MV_ADD: 'true' }),
    );
    expect(r.fields.label).toEqual(['a', 'b']);
  });
});

// Doc-derived (transforms.conf.spec, CLEAN_KEYS: default true, applies to keys
// extracted at search time). A _KEY_n group names the field from the data, the
// same way a FORMAT `$1::$2` does, so it gets the same cleaning (#285).
describe('#285 — CLEAN_KEYS applies to _KEY_n names', () => {
  const kv = (extra: Record<string, string> = {}) =>
    stanza('kv', { REGEX: '(?<_KEY_1>[\\w-]+)=(?<_VAL_1>\\w+)', ...extra });

  it('cleans the key by default', () => {
    expect(searchTime(event('user-name=bob'), kv()).fields).toEqual({ user_name: 'bob' });
  });

  it('leaves the key alone under CLEAN_KEYS = false', () => {
    expect(searchTime(event('user-name=bob'), kv({ CLEAN_KEYS: 'false' })).fields).toEqual({
      'user-name': 'bob',
    });
  });
});

// Doc-derived: MV_ADD with named groups at search time sees the same matches as
// the FORMAT path does, so the two agree (#285).
describe('#285 — MV_ADD agrees between named groups and FORMAT', () => {
  it('accumulates named groups and FORMAT pairs alike', () => {
    const named = searchTime(event('n=1 n=2'), stanza('t', { REGEX: 'n=(?<n>\\d+)', MV_ADD: 'true' }));
    const format = searchTime(
      event('n=1 n=2'),
      stanza('t', { REGEX: 'n=(\\d+)', FORMAT: 'n::$1', MV_ADD: 'true' }),
    );
    expect(named.fields.n).toEqual(['1', '2']);
    expect(format.fields.n).toEqual(named.fields.n);
  });
});

// Doc-derived (transforms.conf.spec, REPEAT_MATCH: the REGEX is run repeatedly,
// each match writing the field). Index-time named groups and FORMAT pairs used
// to disagree — first value only against every match (#303).
describe('#303 — index-time REPEAT_MATCH agrees between named groups and FORMAT', () => {
  const indexTime = (s: ConfStanza) => applyRegexTransform(event('n=1 n=2 n=3'), s, undefined, 'index-time');

  it('collects every match from named groups, as FORMAT does', () => {
    const named = indexTime(stanza('t', { REGEX: 'n=(?<n>\\d+)', WRITE_META: 'true', REPEAT_MATCH: 'true' }));
    const format = indexTime(
      stanza('t', { REGEX: 'n=(\\d+)', FORMAT: 'n::$1', WRITE_META: 'true', REPEAT_MATCH: 'true' }),
    );
    expect(named.fields.n).toEqual(['1', '2', '3']);
    expect(format.fields.n).toEqual(named.fields.n);
  });

  it('collects every _KEY_/_VAL_ value too', () => {
    const r = indexTime(
      stanza('t', { REGEX: '(?<_KEY_1>n)=(?<_VAL_1>\\d+)', WRITE_META: 'true', REPEAT_MATCH: 'true' }),
    );
    expect(r.fields.n).toEqual(['1', '2', '3']);
  });

  it('still takes the first match only without REPEAT_MATCH', () => {
    const r = indexTime(stanza('t', { REGEX: 'n=(?<n>\\d+)', WRITE_META: 'true' }));
    expect(r.fields.n).toBe('1');
  });
});

describe('applyRegexTransform — LOOKAHEAD (#183)', () => {
  it('does not match beyond the LOOKAHEAD window at index time', () => {
    const s = stanza('t', { REGEX: 'needle', DEST_KEY: 'queue', FORMAT: 'nullQueue', LOOKAHEAD: '10' });
    expect(applyRegexTransform(event('x'.repeat(20) + 'needle'), s).matched).toBe(false);
  });

  it('matches inside the window', () => {
    const s = stanza('t', { REGEX: 'needle', DEST_KEY: 'queue', FORMAT: 'nullQueue', LOOKAHEAD: '30' });
    expect(applyRegexTransform(event('x'.repeat(20) + 'needle'), s).matched).toBe(true);
  });

  it('bounds an undeclared window at 4096 characters', () => {
    const s = stanza('t', { REGEX: 'needle', DEST_KEY: 'queue', FORMAT: 'nullQueue' });
    expect(applyRegexTransform(event('x'.repeat(4096) + 'needle'), s).matched).toBe(false);
    expect(applyRegexTransform(event('x'.repeat(4090) + 'needle'), s).matched).toBe(true);
  });

  it('is ignored at search time, where the whole source is scanned', () => {
    const s = stanza('t', { REGEX: 'user=(?<user>\\w+)', LOOKAHEAD: '5' });
    const r = searchTime(event('x'.repeat(50) + ' user=alice'), s);
    expect(r.fields.user).toBe('alice');
  });
});

describe('applyRegexTransform — DEFAULT_VALUE (#183)', () => {
  const directives = {
    REGEX: 'zone=(\\w+)',
    DEST_KEY: 'MetaData:Sourcetype',
    FORMAT: 'sourcetype::$1',
    DEFAULT_VALUE: 'sourcetype::unknown',
  };

  it('routes the default to DEST_KEY when the REGEX fails at index time', () => {
    const r = applyRegexTransform(event('no zone here'), stanza('t', directives));
    expect(r.matched).toBe(true);
    expect(r.destKey).toBe('MetaData:Sourcetype');
    expect(r.destValue).toBe('sourcetype::unknown');
  });

  it('does not fire when the REGEX matches', () => {
    const r = applyRegexTransform(event('zone=dmz'), stanza('t', directives));
    expect(r.destValue).toBe('sourcetype::dmz');
  });

  it('does nothing at search time, where DEFAULT_VALUE is inert', () => {
    const r = searchTime(event('no zone here'), stanza('t', directives));
    expect(r.matched).toBe(false);
    expect(r.destKey).toBeUndefined();
  });

  it('does nothing without a DEST_KEY to write to', () => {
    const r = applyRegexTransform(
      event('no zone here'),
      stanza('t', { REGEX: 'zone=(?<zone>\\w+)', WRITE_META: 'true', DEFAULT_VALUE: 'unknown' }),
    );
    expect(r.matched).toBe(false);
    expect(Object.keys(r.fields)).toEqual([]);
  });
});
