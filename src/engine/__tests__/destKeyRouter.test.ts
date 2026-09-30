import { describe, it, expect } from 'vitest';
import { applyDestKey } from '../transforms/destKeyRouter';
import { runPipeline } from '../pipeline';
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
    expect(event.metadata.host).toBe('new-host');
  });

  it('does NOT update host when FORMAT value lacks host:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Host', 'new-host'));
    expect(event.metadata.host).toBe('original-host');
  });

  it('handles _MetaData:Host alias the same way (leading _ stripped)', () => {
    const event = applyDestKey(baseEvent(), result('_MetaData:Host', 'host::aliased-host'));
    expect(event.metadata.host).toBe('aliased-host');
  });
});

describe('applyDestKey — MetaData:Sourcetype prefix enforcement', () => {
  it('updates sourcetype when FORMAT has sourcetype:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Sourcetype', 'sourcetype::new_sourcetype'));
    expect(event.metadata.sourcetype).toBe('new_sourcetype');
  });

  it('does NOT update sourcetype when prefix is absent', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Sourcetype', 'new_sourcetype'));
    expect(event.metadata.sourcetype).toBe('syslog');
  });
});

describe('applyDestKey — MetaData:Source prefix enforcement', () => {
  it('updates source when FORMAT has source:: prefix', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Source', 'source::/new/path'));
    expect(event.metadata.source).toBe('/new/path');
  });

  it('does NOT update source when prefix is absent', () => {
    const event = applyDestKey(baseEvent(), result('MetaData:Source', '/new/path'));
    expect(event.metadata.source).toBe('/log');
  });
});

// Doc-derived (transforms.conf.spec): FORMAT for `_MetaData:Index` is the bare
// index name; the prefix is required only for Host/Source/Sourcetype.
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
    expect(event._raw).toBe('replaced content');
  });
});

// An empty FORMAT expansion (destValue === '') must still route, rather
// than being treated as "no routing" by a falsy check.
describe('applyDestKey — empty destValue still routes', () => {
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

  it('keeps every value of a repeated key, since indexed fields are multivalue (#359)', () => {
    const event = applyDestKey(baseEvent(), result('_meta', 'tag::a tag::b'));
    expect(event._meta.tag).toEqual(['a', 'b']);
    const again = applyDestKey(event, result('_meta', 'tag::c'));
    expect(again._meta.tag).toEqual(['a', 'b', 'c']);
    expect(event._meta.tag).toEqual(['a', 'b']); // the input event is not mutated
  });

  it('never writes a _queue:: pair into the single-valued routing slot (#478)', () => {
    // Only DEST_KEY = queue routes; `_queue` stays a string (types.ts), so a
    // `=== 'nullQueue'` check downstream still reads it.
    const queued = applyDestKey(baseEvent(), result('queue', 'nullQueue'));
    const event = applyDestKey(queued, result('_meta', 'a::1 _queue::indexQueue b::2'));
    expect(event._meta).toEqual({ _queue: 'nullQueue', a: '1', b: '2' });
    expect(applyDestKey(baseEvent(), result('_meta', '_queue::indexQueue'))._meta).toEqual({});
  });

  it('keeps _queue a string through the pipeline when a _meta FORMAT names it (#478)', () => {
    const props = '[syslog]\nSHOULD_LINEMERGE = false\nTRANSFORMS-q = drop, meta\n';
    const transforms = [
      '[drop]', 'REGEX = .', 'DEST_KEY = queue', 'FORMAT = nullQueue', '',
      '[meta]', 'REGEX = (\\w+)', 'DEST_KEY = _meta', 'FORMAT = _queue::indexQueue word::$1', '',
    ].join('\n');
    const meta = { index: 'main', host: 'h', source: '/log', sourcetype: 'syslog' };
    const { result: out } = runPipeline('hello', meta, props, transforms);
    // Routed to nullQueue by DEST_KEY = queue; a _meta pair cannot undo that.
    expect(out.events.map((e) => e._meta)).toEqual([{ _queue: 'nullQueue', word: 'hello' }]);
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

  // Doc-derived: transforms.conf.spec lists the DEST_KEY values Splunk accepts,
  // and gives an unlisted key no effect. Writing the value into a field named
  // after the key would show a field Splunk never creates (#477). The extracted
  // fields of the transform still apply.
  it('leaves the event alone for a key outside the documented set', () => {
    const before = baseEvent();
    const out = applyDestKey(before, { ...result('my_custom_field', 'v'), fields: { kept: 'k' } });
    expect(out.fields.my_custom_field).toBeUndefined();
    expect(out.fields.kept).toBe('k');
    expect(out._raw).toBe(before._raw);
    expect(out.metadata).toEqual(before.metadata);
    expect(out._meta).toEqual(before._meta);
  });

  it('leaves the event alone for an empty value under an unknown key too', () => {
    expect(applyDestKey(baseEvent(), result('anon_field', '')).fields.anon_field).toBeUndefined();
  });
});

describe('applyDestKey — _time out of the Date range (#417)', () => {
  const at = new Date('2026-01-02T03:04:05Z');

  it.each(['100000000000000', '1e20', '-1e300', '1e400'])('keeps the previous _time for %s', (value) => {
    const seen: string[] = [];
    const out = applyDestKey({ ...baseEvent(), _time: at }, result('_time', value), (v) => seen.push(v));
    expect(out._time).toBe(at);
    expect(seen).toEqual([value]);
  });

  it('sets an in-range epoch and reports nothing', () => {
    const seen: string[] = [];
    const out = applyDestKey(baseEvent(), result('_time', '1767323045'), (v) => seen.push(v));
    expect(out._time?.toISOString()).toBe('2026-01-02T03:04:05.000Z');
    expect(seen).toEqual([]);
  });

  it('ignores a non-numeric value silently, as before', () => {
    const seen: string[] = [];
    const out = applyDestKey({ ...baseEvent(), _time: at }, result('_time', 'soon'), (v) => seen.push(v));
    expect(out._time).toBe(at);
    expect(seen).toEqual([]);
  });

  it('warns once per transform through the pipeline, keeping the extracted _time', () => {
    const meta = { index: 'main', host: 'h', source: '/a.log', sourcetype: 'st' };
    const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-t = t\n';
    const transforms = '[t]\nREGEX = (\\d+)$\nFORMAT = $1\nDEST_KEY = _time\n';
    const { result: out, diagnostics } = runPipeline(
      '2026-01-02 03:04:05 100000000000000\n2026-01-02 03:04:06 100000000000001',
      meta,
      props,
      transforms,
    );
    for (const ev of out.events) expect(ev._time?.toISOString()).toMatch(/^2026-01-02T/);
    const warnings = diagnostics.filter((d) => d.message.includes('out of range'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ level: 'warning', file: 'transforms.conf', line: 4 });
    expect(warnings[0]!.message).toBe(
      'DEST_KEY = _time in transform "t": timestamp 100000000000000 is out of range; ' +
        'the event keeps its previous _time',
    );
  });
});
