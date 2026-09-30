// Tests written against mutants that survived `npm run test:mutation` (#370).
// Each pins a behaviour of one transforms.conf stanza applied to one event that
// the suite executed but never asserted.
import { describe, it, expect, vi } from 'vitest';
import { applyRegexTransform } from '../transforms/regexTransform';
import type { SplunkEvent, ConfStanza } from '../types';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string, fields: Record<string, string | string[]> = {}): SplunkEvent {
  return makeEvent(raw, { fields });
}

function stanza(directives: Record<string, string>, name = 't'): ConfStanza {
  return {
    name,
    type: 'sourcetype',
    lineRange: { start: 1, end: 1 },
    directives: Object.entries(directives).map(([key, value]) => ({ key, value, line: 1, directiveType: key })),
  };
}

const searchTime = (ev: SplunkEvent, s: ConfStanza) => applyRegexTransform(ev, s, undefined, 'search-time');

describe('LOOKAHEAD', () => {
  const late = 'x'.repeat(20) + 'id=7';

  it('bounds how far an index-time REGEX looks', () => {
    const r = applyRegexTransform(
      event(late),
      stanza({ REGEX: 'id=(\\d)', FORMAT: 'id::$1', WRITE_META: 'true', LOOKAHEAD: '10' }),
    );
    expect(r.matched).toBe(false);
  });

  it('does not cut a source that already fits', () => {
    const r = applyRegexTransform(event('id=7'), stanza({ REGEX: 'id=(\\d)$', FORMAT: 'id::$1', LOOKAHEAD: '4' }));
    expect(r.matched).toBe(true);
  });

  it.each(['0', '-5', 'lots'])('falls back to the 4096 default for LOOKAHEAD = %s rather than to no limit', (value) => {
    expect(
      applyRegexTransform(event(late), stanza({ REGEX: 'id=(\\d)', FORMAT: 'id::$1', LOOKAHEAD: value })).matched,
    ).toBe(true);
    const far = 'x'.repeat(5000) + 'id=7';
    expect(
      applyRegexTransform(event(far), stanza({ REGEX: 'id=(\\d)', FORMAT: 'id::$1', LOOKAHEAD: value })).matched,
    ).toBe(false);
  });

  it('bounds an index-time REGEX at 4096 characters when LOOKAHEAD is absent', () => {
    const far = 'x'.repeat(5000) + 'id=7';
    expect(applyRegexTransform(event(far), stanza({ REGEX: 'id=(\\d)', FORMAT: 'id::$1' })).matched).toBe(false);
  });

  it('does not apply at search time', () => {
    const r = searchTime(event(late), stanza({ REGEX: 'id=(?<id>\\d)', LOOKAHEAD: '10' }));
    expect(r.fields).toEqual({ id: '7' });
  });
});

describe('why a transform did nothing', () => {
  it('reports a REGEX that will not compile, and tells the caller which', () => {
    const onInvalid = vi.fn();
    const r = applyRegexTransform(event('a'), stanza({ REGEX: '  (unclosed  ' }), onInvalid);
    expect(onInvalid).toHaveBeenCalledWith('(unclosed');
    expect(r.matched).toBe(false);
    expect(r.noOp?.kind).toBe('regex-invalid');
    expect((r.noOp as { error: string }).error.length).toBeGreaterThan(0);
  });

  it('blames an empty SOURCE_KEY rather than the pattern', () => {
    const r = searchTime(event('a=1'), stanza({ REGEX: 'a=(?<a>\\d)', SOURCE_KEY: ' missing ' }));
    expect(r.noOp).toEqual({ kind: 'source-key-empty', sourceKey: 'missing' });
  });

  it('names _raw when there is no SOURCE_KEY and the event is empty', () => {
    const r = searchTime(event(''), stanza({ REGEX: 'a=(?<a>\\d)' }));
    expect(r.noOp).toEqual({ kind: 'source-key-empty', sourceKey: '_raw' });
  });

  it('reports how far a near-miss got', () => {
    const r = searchTime(event('user=bob'), stanza({ REGEX: 'user=(?<u>\\d+)' }));
    expect(r.noOp?.kind).toBe('no-match');
    expect(r.noOp).toHaveProperty('partialEnd');
    expect(r.noOp).toHaveProperty('partialPattern');
  });

  it('trims SOURCE_KEY before reading it', () => {
    const r = searchTime(event('zzz', { src: 'a=1' }), stanza({ REGEX: 'a=(?<a>\\d)', SOURCE_KEY: ' src ' }));
    expect(r.fields).toEqual({ a: '1' });
  });

  it('reads the first value of a multivalue SOURCE_KEY', () => {
    const r = searchTime(event('zzz', { src: ['a=1', 'a=2'] }), stanza({ REGEX: 'a=(?<a>\\d)', SOURCE_KEY: 'src' }));
    expect(r.fields).toEqual({ a: '1' });
  });
});

describe('DEFAULT_VALUE', () => {
  const miss = { REGEX: 'nomatch(\\d)', FORMAT: 'x::$1', DEST_KEY: ' MetaData:Host ', DEFAULT_VALUE: ' fallback ' };

  it('writes the trimmed default to the trimmed DEST_KEY when an index-time REGEX misses', () => {
    const r = applyRegexTransform(event('a'), stanza(miss));
    expect(r).toMatchObject({ matched: true, destKey: 'MetaData:Host', destValue: 'fallback' });
  });

  it('is ignored at search time', () => {
    expect(searchTime(event('a'), stanza(miss)).matched).toBe(false);
  });

  it('is ignored when blank', () => {
    expect(applyRegexTransform(event('a'), stanza({ ...miss, DEFAULT_VALUE: '  ' })).matched).toBe(false);
  });

  it('is ignored without a DEST_KEY', () => {
    const { DEST_KEY: _d, ...noDest } = miss;
    expect(applyRegexTransform(event('a'), stanza(noDest)).matched).toBe(false);
  });
});

describe('$0 — the DEST_KEY value before the REGEX ran', () => {
  it.each([
    ['MetaData:Host', 'h'],
    ['MetaData:Index', 'main'],
    ['MetaData:Source', 's'],
    ['MetaData:Sourcetype', 'st'],
    ['_MetaData:Index', 'main'],
  ])('reads the current %s', (destKey, prior) => {
    const r = applyRegexTransform(event('v=1'), stanza({ REGEX: 'v=(\\d)', FORMAT: '$0-$1', DEST_KEY: destKey }));
    expect(r.destValue).toBe(`${prior}-1`);
  });

  it('reads the current value of a field DEST_KEY', () => {
    const r = applyRegexTransform(
      event('v=1', { f: ['old', 'older'] }),
      stanza({ REGEX: 'v=(\\d)', FORMAT: '$0+$1', DEST_KEY: 'f' }),
    );
    expect(r.destValue).toBe('old+1');
  });

  it('reads _raw for DEST_KEY = _raw', () => {
    const r = applyRegexTransform(event('v=1 rest'), stanza({ REGEX: 'v=(\\d)', FORMAT: '[$0]', DEST_KEY: '_raw' }));
    expect(r.destValue).toBe('[v=1 rest]');
  });

  it('drops a field pair that uses $0 when there is no DEST_KEY, but keeps $01, which is group 1', () => {
    const r = searchTime(event('v=1'), stanza({ REGEX: 'v=(\\d)', FORMAT: 'a::$01 b::$0 c::x$0_y' }));
    expect(r.fields).toEqual({ a: '1' });
  });
});

describe('DEST_KEY', () => {
  it('uses the first match only for a single-valued slot, even under REPEAT_MATCH', () => {
    const r = applyRegexTransform(
      event('h=a h=b'),
      stanza({ REGEX: 'h=(\\w)', FORMAT: 'host::$1', DEST_KEY: '_MetaData:Host', REPEAT_MATCH: 'true' }),
    );
    expect(r.destValue).toBe('host::a');
  });

  it('accumulates one line per match into _meta under REPEAT_MATCH, including adjacent matches', () => {
    const r = applyRegexTransform(
      event('123'),
      stanza({ REGEX: '(\\d)', FORMAT: 'd::$1', DEST_KEY: '_meta', REPEAT_MATCH: 'true' }),
    );
    expect(r.destValue).toBe('d::1\nd::2\nd::3');
  });

  it('writes the first match only into _meta without REPEAT_MATCH', () => {
    const r = applyRegexTransform(event('123'), stanza({ REGEX: '(\\d)', FORMAT: 'd::$1', DEST_KEY: '_meta' }));
    expect(r.destValue).toBe('d::1');
  });

  it('trims DEST_KEY and FORMAT', () => {
    const r = applyRegexTransform(
      event('v=1'),
      stanza({ REGEX: 'v=(\\d)', FORMAT: '  x::$1  ', DEST_KEY: '  _meta  ' }),
    );
    expect(r).toMatchObject({ destKey: '_meta', destValue: 'x::1' });
  });

  it('replaces the whole event with the FORMAT expansion for DEST_KEY = _raw', () => {
    const r = applyRegexTransform(
      event('keep=1 drop'),
      stanza({ REGEX: 'keep=(\\d)', FORMAT: 'k$1', DEST_KEY: '_raw' }),
    );
    expect(r).toMatchObject({ matched: true, destKey: '_raw', destValue: 'k1' });
  });
});

describe('FORMAT without DEST_KEY', () => {
  it('extracts adjacent matches under REPEAT_MATCH at index time', () => {
    const r = applyRegexTransform(
      event('123'),
      stanza({ REGEX: '(\\d)', FORMAT: 'd::$1', REPEAT_MATCH: 'true', WRITE_META: 'true' }),
    );
    expect(r.fields).toEqual({ d: ['1', '2', '3'] });
  });

  it('skips a pair whose name cleans to nothing', () => {
    const r = searchTime(event('123=x'), stanza({ REGEX: '(\\d+)=(\\w)', FORMAT: '$1::$2' }));
    expect(r.fields).toEqual({});
    expect(r.matched).toBe(true);
  });

  it('defaults to <stanza>::$1 at index time when the REGEX has numbered groups', () => {
    const r = applyRegexTransform(event('v=1'), stanza({ REGEX: 'v=(\\d)' }, 'myfield'));
    expect(r.fields).toEqual({ myfield: '1' });
  });
});

describe('named groups', () => {
  it('keeps a leading underscore at index time unless WRITE_META is set', () => {
    expect(applyRegexTransform(event('v=1'), stanza({ REGEX: 'v=(?<_v>\\d)' })).fields).toEqual({ _v: '1' });
    expect(applyRegexTransform(event('v=1'), stanza({ REGEX: 'v=(?<_v>\\d)', WRITE_META: 'true' })).fields).toEqual({
      v: '1',
    });
  });

  it('skips a group that did not participate', () => {
    const r = searchTime(event('a=1'), stanza({ REGEX: 'a=(?<a>\\d)(?: b=(?<b>\\d))?' }));
    expect(r.fields).toEqual({ a: '1' });
  });

  it('skips a name that WRITE_META strips to nothing', () => {
    const r = applyRegexTransform(event('v=1'), stanza({ REGEX: 'v=(?<__>\\d)', WRITE_META: 'true' }));
    expect(r.fields).toEqual({});
  });

  it('pairs _KEY_/_VAL_ groups with a multi-character suffix, and drops a KEY with no VAL', () => {
    const r = searchTime(
      event('user=bob role'),
      stanza({ REGEX: '(?<_KEY_ab>\\w+)=(?<_VAL_ab>\\w+) (?<_KEY_zz>\\w+)' }),
    );
    expect(r.fields).toEqual({ user: 'bob' });
  });

  it('treats _KEY_ or _VAL_ in the middle of a group name as an ordinary name', () => {
    const r = searchTime(event('v=1 w=2'), stanza({ REGEX: 'v=(?<my_KEY_a>\\d) w=(?<my_VAL_b>\\d)' }));
    expect(r.fields).toEqual({ my_KEY_a: '1', my_VAL_b: '2' });
  });
});
