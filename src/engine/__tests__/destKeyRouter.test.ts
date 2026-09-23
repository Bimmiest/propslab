import { describe, it, expect } from 'vitest';
import { applyDestKey } from '../transforms/destKeyRouter';
import type { SplunkEvent } from '../types';
import type { TransformResult } from '../transforms/regexTransform';

function baseEvent(): SplunkEvent {
  return {
    _raw: 'raw log line',
    _time: null,
    _meta: {},
    fields: {},
    metadata: { index: 'main', host: 'original-host', source: '/log', sourcetype: 'syslog' },
    lineNumbers: { start: 1, end: 1 },
    processingTrace: [],
  };
}

function result(destKey: string, destValue: string): TransformResult {
  return { fields: {}, destKey, destValue, matched: true };
}

describe('applyDestKey — MetaData:Host prefix enforcement', () => {
  it('updates host when FORMAT value has host:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Host', 'host::new-host'));
    expect(event?.metadata.host).toBe('new-host');
  });

  it('does NOT update host when FORMAT value lacks host:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Host', 'new-host'));
    expect(event?.metadata.host).toBe('original-host');
  });

  it('handles _MetaData:Host alias the same way (leading _ stripped)', () => {
    const event = applyDestKey(baseEvent(), result('_MetaData:Host', 'host::aliased-host'));
    expect(event?.metadata.host).toBe('aliased-host');
  });
});

describe('applyDestKey — MetaData:Sourcetype prefix enforcement', () => {
  it('updates sourcetype when FORMAT has sourcetype:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Sourcetype', 'sourcetype::new_sourcetype'));
    expect(event?.metadata.sourcetype).toBe('new_sourcetype');
  });

  it('does NOT update sourcetype when prefix is absent', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Sourcetype', 'new_sourcetype'));
    expect(event?.metadata.sourcetype).toBe('syslog');
  });
});

describe('applyDestKey — MetaData:Source prefix enforcement', () => {
  it('updates source when FORMAT has source:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Source', 'source::/new/path'));
    expect(event?.metadata.source).toBe('/new/path');
  });

  it('does NOT update source when prefix is absent', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Source', '/new/path'));
    expect(event?.metadata.source).toBe('/log');
  });
});

// Doc-derived (transforms.conf.spec): FORMAT for `_MetaData:Index` is the bare
// index name. The router used to require `index::` and silently skip the update
// without it — the reverse of the spec, which requires the prefix only for
// Host/Source/Sourcetype (#281).
describe('applyDestKey — MetaData:Index takes the bare index name', () => {
  it('routes to the bare FORMAT value', () => {
    const event = applyDestKey(baseEvent(), result('_MetaData:Index', 'security'));
    expect(event.metadata.index).toBe('security');
  });

  it('does not strip an index:: prefix — Splunk would route to that literal name', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Index', 'index::security'));
    expect(event.metadata.index).toBe('index::security');
  });
});

describe('applyDestKey — queue routing (last-wins)', () => {
  it('records nullQueue on _meta._queue rather than dropping the event', () => {
    // DEST_KEY = queue is not a final decision — a later transform can overwrite
    // it — so the value is stored and the event is kept for the rest of the list.
    const event = applyDestKey(baseEvent(), result('queue', 'nullQueue'));
    expect(event._meta._queue).toBe('nullQueue');
  });

  it('records indexQueue on _meta._queue', () => {
    const event = applyDestKey(baseEvent(), result('queue', 'indexQueue'));
    expect(event._meta._queue).toBe('indexQueue');
  });

  it('later queue assignment overwrites an earlier one (last-wins)', () => {
    const dropped = applyDestKey(baseEvent(), result('queue', 'nullQueue'));
    const kept = applyDestKey(dropped, result('queue', 'indexQueue'));
    expect(kept._meta._queue).toBe('indexQueue');
  });
});

describe('applyDestKey — _raw replacement', () => {
  it('replaces _raw when destKey is _raw', () => {
    const event = applyDestKey(baseEvent(), result('_raw', 'replaced content'));
    expect(event?._raw).toBe('replaced content');
  });
});

// #29: an empty FORMAT expansion (destValue === '') must still route, rather
// than being treated as "no routing" by a falsy check.
describe('applyDestKey — empty destValue still routes', () => {
  it('sets a target field to an empty string', () => {
    const event = applyDestKey(baseEvent(), result('anon_field', ''));
    expect(event.fields.anon_field).toBe('');
  });

  it('blanks _raw when FORMAT expands to empty', () => {
    const event = applyDestKey(baseEvent(), result('_raw', ''));
    expect(event._raw).toBe('');
  });
});

describe('applyDestKey — _meta (SEM-11)', () => {
  it('parses space-separated key::value pairs', () => {
    const event = applyDestKey(baseEvent(), result('_meta', 'a::1 b::2'));
    expect(event._meta.a).toBe('1');
    expect(event._meta.b).toBe('2');
  });

  it('keeps a quoted value containing spaces intact', () => {
    const event = applyDestKey(baseEvent(), result('_meta', 'label::"two words" n::5'));
    expect(event._meta.label).toBe('two words');
    expect(event._meta.n).toBe('5');
  });
});

describe('applyDestKey — unsimulated routing keys are not written as fields (#75.3)', () => {
  it('does not invent a field for _TCP_ROUTING', () => {
    const out = applyDestKey(baseEvent(), result('_TCP_ROUTING', 'my_group'));
    expect(out.fields._TCP_ROUTING).toBeUndefined();
  });

  it('does not invent a field for _INDEX_AND_FORWARD_ROUTING', () => {
    const out = applyDestKey(baseEvent(), result('_INDEX_AND_FORWARD_ROUTING', 'local'));
    expect(out.fields._INDEX_AND_FORWARD_ROUTING).toBeUndefined();
  });

  it('still treats a genuinely unknown key as a field name', () => {
    const out = applyDestKey(baseEvent(), result('my_custom_field', 'v'));
    expect(out.fields.my_custom_field).toBe('v');
  });
});
