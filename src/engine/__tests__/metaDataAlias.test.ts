// The `_MetaData:X` alias of `MetaData:X` is read in four places: the value a
// SOURCE_KEY reads, the `$0` of a DEST_KEY, the single-valued-slot rule of a
// FORMAT write, and the router that applies the write. All four go through
// `normaliseDestKey` (#511), so the alias must behave identically in each.
//
// Doc-derived (transforms.conf.spec, DEST_KEY / SOURCE_KEY): "_MetaData:Index"
// and "MetaData:Index" name the same key; the underscore-prefixed form is the
// spelling Splunk's own default configuration uses.
import { describe, it, expect } from 'vitest';
import { applyRegexTransform } from '../transforms/regexTransform';
import { applyDestKey } from '../transforms/destKeyRouter';
import { normaliseDestKey } from '../transforms/destKeys';
import { getSourceKeyValue } from '../utils/metadataFields';
import type { ConfStanza } from '../types';
import { makeEvent } from '../../test/makeEvent';

const KEYS = [
  { key: 'Host', prior: 'h', read: 'host::h', write: 'host::new', field: 'host', written: 'new' },
  { key: 'Index', prior: 'main', read: 'main', write: 'other', field: 'index', written: 'other' },
  { key: 'Source', prior: 's', read: 'source::s', write: 'source::/new', field: 'source', written: '/new' },
  {
    key: 'Sourcetype',
    prior: 'st',
    read: 'sourcetype::st',
    write: 'sourcetype::newst',
    field: 'sourcetype',
    written: 'newst',
  },
] as const;

function stanza(directives: Record<string, string>): ConfStanza {
  return {
    name: 't',
    type: 'sourcetype',
    lineRange: { start: 1, end: 1 },
    directives: Object.entries(directives).map(([key, value]) => ({ key, value, line: 1, directiveType: key })),
  };
}

describe('normaliseDestKey', () => {
  it.each(KEYS)('folds _MetaData:$key onto MetaData:$key', ({ key }) => {
    expect(normaliseDestKey(`_MetaData:${key}`)).toBe(`MetaData:${key}`);
    expect(normaliseDestKey(`MetaData:${key}`)).toBe(`MetaData:${key}`);
  });

  it.each(['_raw', '_meta', '_time', 'queue', '_MetaDataX', 'my_MetaData:Host'])('leaves %s alone', (key) => {
    expect(normaliseDestKey(key)).toBe(key);
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseDestKey('  _MetaData:Host  ')).toBe('MetaData:Host');
  });
});

describe('the _MetaData: alias reads the same as MetaData: at every site', () => {
  describe.each(KEYS)('$key', ({ key, prior, read, write, field, written }) => {
    it('SOURCE_KEY reads the slot', () => {
      const ev = makeEvent('x');
      expect(getSourceKeyValue(ev, `_MetaData:${key}`)).toBe(read);
      expect(getSourceKeyValue(ev, `MetaData:${key}`)).toBe(read);
    });

    it('$0 in FORMAT is the slot before the REGEX ran', () => {
      const r = applyRegexTransform(
        makeEvent('v=1'),
        stanza({ REGEX: 'v=(\\d)', FORMAT: '$0|$1', DEST_KEY: `_MetaData:${key}` }),
      );
      expect(r.destValue).toBe(`${prior}|1`);
    });

    it('a single-valued slot takes the first match only, even under REPEAT_MATCH', () => {
      const r = applyRegexTransform(
        makeEvent('a1 a2'),
        stanza({ REGEX: 'a(\\d)', FORMAT: 'v$1', DEST_KEY: `_MetaData:${key}`, REPEAT_MATCH: 'true' }),
      );
      expect(r.destValue).toBe('v1');
    });

    it('the router writes the slot', () => {
      const ev = applyDestKey(makeEvent('x'), {
        fields: {},
        matched: true,
        destKey: `_MetaData:${key}`,
        destValue: write,
      });
      expect(ev.metadata[field]).toBe(written);
    });
  });

  it('a built-in key keeps its underscore: DEST_KEY = _raw still replaces the event', () => {
    const ev = applyDestKey(makeEvent('x'), { fields: {}, matched: true, destKey: '_raw', destValue: 'replaced' });
    expect(ev._raw).toBe('replaced');
  });
});
