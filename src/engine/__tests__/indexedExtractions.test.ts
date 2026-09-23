import { describe, it, expect } from 'vitest';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { runPipeline } from '../pipeline';
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
  return { key: 'INDEXED_EXTRACTIONS', value, line: 1, directiveType: 'INDEXED_EXTRACTIONS' };
}

describe('applyIndexedExtractions — JSON', () => {
  it('extracts top-level JSON fields', () => {
    const events = applyIndexedExtractions(
      [event('{"action":"login","user":"alice","status":200}')],
      [dir('json')]
    );
    expect(events[0]!.fields['action']).toBe('login');
    expect(events[0]!.fields['user']).toBe('alice');
    // Numeric JSON values are stringified when stored in SplunkEvent.fields
    expect(events[0]!.fields['status']).toBe('200');
  });

  it('flattens nested JSON with dot notation', () => {
    const events = applyIndexedExtractions(
      [event('{"request":{"method":"GET","path":"/api"}}')],
      [dir('json')]
    );
    expect(events[0]!.fields['request.method']).toBe('GET');
    expect(events[0]!.fields['request.path']).toBe('/api');
  });

  it('returns event unchanged for invalid JSON', () => {
    const events = applyIndexedExtractions([event('not json')], [dir('json')]);
    expect(events[0]!.fields).toEqual({});
  });

  it('extracts a key named after a prototype member instead of mangling it', () => {
    const events = applyIndexedExtractions([event('{"toString":"v"}')], [dir('json')]);
    expect(events[0]!.fields['toString']).toBe('v');
  });

  it('extracts prototype-colliding keys as real fields after underscore stripping', () => {
    // INDEXED_EXTRACTIONS strips leading underscores, so `_constructor` becomes
    // `constructor`. Splunk's spath/KV_MODE=json extract such keys verbatim, so
    // the value must land as an *own* data property (not the inherited function).
    const events = applyIndexedExtractions(
      [event('{"_constructor":"good","keep":"ok"}')],
      [dir('json')]
    );
    expect(Object.prototype.hasOwnProperty.call(events[0]!.fields, 'constructor')).toBe(true);
    expect(events[0]!.fields['constructor']).toBe('good');
    expect(events[0]!.fields['keep']).toBe('ok');
  });

  it('names array-of-object fields with {} multivalue notation (not positional)', () => {
    const events = applyIndexedExtractions(
      [event('{"items":[{"id":1,"n":"a"},{"id":2,"n":"b"}]}')],
      [dir('json')]
    );
    expect(events[0]!.fields['items{}.id']).toEqual(['1', '2']);
    expect(events[0]!.fields['items{}.n']).toEqual(['a', 'b']);
    // Positional and stringified-parent forms must NOT appear.
    expect(events[0]!.fields['items.0.id']).toBeUndefined();
    expect(events[0]!.fields['items']).toBeUndefined();
  });

  it('names primitive arrays with {} as a multivalue field', () => {
    const events = applyIndexedExtractions([event('{"tags":["x","y","z"]}')], [dir('json')]);
    expect(events[0]!.fields['tags{}']).toEqual(['x', 'y', 'z']);
    expect(events[0]!.fields['tags']).toBeUndefined();
  });

  it('does not emit a stringified container field for nested objects', () => {
    const events = applyIndexedExtractions(
      [event('{"user":{"name":"alice","id":5}}')],
      [dir('json')]
    );
    expect(events[0]!.fields['user.name']).toBe('alice');
    expect(events[0]!.fields['user.id']).toBe('5');
    expect(events[0]!.fields['user']).toBeUndefined();
  });

  it('decodes escaped characters via JSON.parse', () => {
    const events = applyIndexedExtractions(
      [event('{"msg":"line1\\nline2","q":"say \\"hi\\"","path":"C:\\\\tmp"}')],
      [dir('json')]
    );
    expect(events[0]!.fields['msg']).toBe('line1\nline2');
    expect(events[0]!.fields['q']).toBe('say "hi"');
    expect(events[0]!.fields['path']).toBe('C:\\tmp');
  });

  it('extracts a top-level JSON array', () => {
    const events = applyIndexedExtractions(
      [event('[{"id":1},{"id":2}]')],
      [dir('json')]
    );
    expect(events[0]!.fields['{}.id']).toEqual(['1', '2']);
  });

  it('populates fieldSourceKeys for underscore-stripped JSON keys', () => {
    const events = applyIndexedExtractions(
      [event('{"_GID":"100","_UID":"1000","normalKey":"value"}')],
      [dir('json')]
    );
    const sourceKeys = events[0]!.fieldSourceKeys ?? {};
    expect(sourceKeys['GID']).toBe('_GID');
    expect(sourceKeys['UID']).toBe('_UID');
    // Keys that were not stripped should not appear in fieldSourceKeys
    expect(sourceKeys['normalKey']).toBeUndefined();
  });

  it('fieldSourceKeys maps all _AUDIT_FIELD_* variants correctly', () => {
    const events = applyIndexedExtractions(
      [event('{"_AUDIT_SESSION":"3","_AUDIT_FIELD_EXIT":"0","_AUDIT_TYPE_NAME":"SYSCALL"}')],
      [dir('json')]
    );
    const sourceKeys = events[0]!.fieldSourceKeys ?? {};
    expect(sourceKeys['AUDIT_SESSION']).toBe('_AUDIT_SESSION');
    expect(sourceKeys['AUDIT_FIELD_EXIT']).toBe('_AUDIT_FIELD_EXIT');
    expect(sourceKeys['AUDIT_TYPE_NAME']).toBe('_AUDIT_TYPE_NAME');
  });
});

describe('applyIndexedExtractions — CSV', () => {
  it('header row maps to data rows and is not itself emitted as an event', () => {
    // Simulates LINE_BREAKER having already split the CSV into one event per line
    const header = event('timestamp,action,user');
    const row1 = event('2024-01-15,login,alice');
    const row2 = event('2024-01-16,logout,bob');

    const events = applyIndexedExtractions([header, row1, row2], [dir('csv')]);

    // The header line is consumed as metadata — only the two data rows remain.
    expect(events).toHaveLength(2);

    expect(events[0]!.fields['timestamp']).toBe('2024-01-15');
    expect(events[0]!.fields['action']).toBe('login');
    expect(events[0]!.fields['user']).toBe('alice');

    expect(events[1]!.fields['user']).toBe('bob');
  });

  it('handles quoted CSV fields', () => {
    const header = event('name,description');
    const row = event('"Smith, John","A ""quoted"" value"');
    const events = applyIndexedExtractions([header, row], [dir('csv')]);
    expect(events[0]!.fields['name']).toBe('Smith, John');
    expect(events[0]!.fields['description']).toBe('A "quoted" value');
  });
});

describe('applyIndexedExtractions — CSV quoting', () => {
  it('preserves interior whitespace of quoted fields but trims unquoted ones', () => {
    const header = event('name,note');
    const row = event('  bob  ,"  spaced value  "');
    const events = applyIndexedExtractions([header, row], [dir('csv')]);
    expect(events[0]!.fields['name']).toBe('bob');
    expect(events[0]!.fields['note']).toBe('  spaced value  ');
  });
});

describe('applyIndexedExtractions — W3C quoting', () => {
  it('keeps a quoted field containing spaces as a single value', () => {
    const header = event('#Fields: cs-method cs(User-Agent) sc-status');
    const row = event('GET "Mozilla/5.0 (Windows NT 10.0)" 200');
    const events = applyIndexedExtractions([header, row], [dir('w3c')]);
    // Header tokens are sanitized to the names Splunk indexes (#68): the IIS
    // user-agent column really does surface as `cs_User_Agent_`.
    expect(events[0]!.fields['cs_method']).toBe('GET');
    expect(events[0]!.fields['cs_User_Agent_']).toBe('Mozilla/5.0 (Windows NT 10.0)');
    expect(events[0]!.fields['sc_status']).toBe('200');
  });
});

describe('applyIndexedExtractions — TSV', () => {
  it('splits on tabs', () => {
    const header = event('ts\thost\tsource');
    const row = event('2024-01-15\tmyhost\t/var/log/app');
    const events = applyIndexedExtractions([header, row], [dir('tsv')]);
    expect(events[0]!.fields['host']).toBe('myhost');
    expect(events[0]!.fields['source']).toBe('/var/log/app');
  });
});

describe('applyIndexedExtractions — leading underscore stripping', () => {
  it('strips leading _ from top-level JSON keys', () => {
    const events = applyIndexedExtractions(
      [event('{"_AUDIT_TYPE_NAME":"SYSCALL","user":"alice"}')],
      [dir('json')]
    );
    expect(events[0]!.fields['AUDIT_TYPE_NAME']).toBe('SYSCALL');
    expect(events[0]!.fields['_AUDIT_TYPE_NAME']).toBeUndefined();
    expect(events[0]!.fields['user']).toBe('alice');
  });

  it('strips leading _ from nested JSON keys at every depth', () => {
    const events = applyIndexedExtractions(
      [event('{"outer":{"_inner":"value","normal":"v2"}}')],
      [dir('json')]
    );
    expect(events[0]!.fields['outer.inner']).toBe('value');
    expect(events[0]!.fields['outer.normal']).toBe('v2');
    expect(events[0]!.fields['outer._inner']).toBeUndefined();
  });

  it('strips multiple leading underscores', () => {
    const events = applyIndexedExtractions(
      [event('{"__double":"v"}')],
      [dir('json')]
    );
    expect(events[0]!.fields['double']).toBe('v');
  });

  it('strips leading _ from CSV headers', () => {
    const header = event('_ts,_user,action');
    const row = event('2024-01-15,alice,login');
    const events = applyIndexedExtractions([header, row], [dir('csv')]);
    expect(events[0]!.fields['ts']).toBe('2024-01-15');
    expect(events[0]!.fields['user']).toBe('alice');
    expect(events[0]!.fields['action']).toBe('login');
    expect(events[0]!.fields['_ts']).toBeUndefined();
  });

  it('strips leading _ from W3C #Fields headers', () => {
    const header = event('#Fields: _cs-method uri status');
    const row = event('GET /api 200');
    const events = applyIndexedExtractions([header, row], [dir('w3c')]);
    expect(events[0]!.fields['cs_method']).toBe('GET');
    expect(events[0]!.fields['uri']).toBe('/api');
    expect(events[0]!.fields['status']).toBe('200');
    expect(events[0]!.fields['_cs_method']).toBeUndefined();
  });
});

describe('applyIndexedExtractions — no directive', () => {
  it('returns events unchanged when no INDEXED_EXTRACTIONS directive', () => {
    const ev = event('some raw data');
    const events = applyIndexedExtractions([ev], []);
    expect(events[0]!.fields).toEqual({});
  });
});

describe('applyIndexedExtractions — header is the first content line (#14)', () => {
  it('skips a leading blank line', () => {
    const events = applyIndexedExtractions(
      [event(''), event('ts,host'), event('2024-01-15,myhost')],
      [dir('csv')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields.host).toBe('myhost');
  });

  it('skips a leading comment line', () => {
    const events = applyIndexedExtractions(
      [event('# exported 2024-01-15'), event('ts,host'), event('2024-01-15,myhost')],
      [dir('csv')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields.host).toBe('myhost');
    expect(events[0]!.fields['#_exported_2024_01_15']).toBeUndefined();
  });

  it('returns events unchanged when there is no content line at all', () => {
    const events = applyIndexedExtractions([event(''), event('   ')], [dir('csv')]);
    expect(events).toHaveLength(2);
  });
});

describe('applyIndexedExtractions — header names are sanitized (#68)', () => {
  it('rewrites W3C hyphens to underscores', () => {
    const events = applyIndexedExtractions(
      [event('#Fields: date time c-ip cs-uri-stem sc-status'), event('2024-01-15 10:00:00 10.0.0.1 /index.html 200')],
      [dir('w3c')],
    );
    expect(events[0]!.fields.c_ip).toBe('10.0.0.1');
    expect(events[0]!.fields.cs_uri_stem).toBe('/index.html');
    expect(events[0]!.fields.sc_status).toBe('200');
    expect(events[0]!.fields['cs-uri-stem']).toBeUndefined();
  });

  it('rewrites delimited header names too', () => {
    const events = applyIndexedExtractions(
      [event('req-id,user.name,status'), event('abc,alice,200')],
      [dir('csv')],
    );
    expect(events[0]!.fields.req_id).toBe('abc');
    expect(events[0]!.fields.user_name).toBe('alice');
  });

  it('drops a W3C directive line that is not the first event', () => {
    const events = applyIndexedExtractions(
      [event('#Software: IIS'), event('#Fields: cs-method sc-status'), event('GET 200')],
      [dir('w3c')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields.cs_method).toBe('GET');
  });
});

describe('#164 — INDEXED_EXTRACTIONS turns off line merging by default', () => {
  it('gives one event per JSON object, each with its fields extracted', () => {
    const raw =
      '{"ts":"2026-01-15T10:00:00Z","user":"alice","status":200}\n' +
      '{"ts":"2026-01-15T10:00:01Z","user":"bob","status":404}\n';
    const { result } = runPipeline(
      raw,
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nINDEXED_EXTRACTIONS = JSON\nKV_MODE = none\n',
      '',
      { perEventPipeline: false, captureOffsets: false },
    );
    expect(result.events).toHaveLength(2);
    expect(result.events[0]!.fields).toMatchObject({ user: 'alice', status: '200' });
    expect(result.events[1]!.fields).toMatchObject({ user: 'bob', status: '404' });
  });

  it('still honours an explicit SHOULD_LINEMERGE', () => {
    const { result } = runPipeline(
      '{"a":1}\n{"a":2}\n',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nINDEXED_EXTRACTIONS = JSON\nSHOULD_LINEMERGE = true\nKV_MODE = none\n',
      '',
      { perEventPipeline: false, captureOffsets: false },
    );
    expect(result.events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Delimited override attributes (#184). These apply to csv/tsv/psv; W3C keeps
// its own #Fields header mechanism.
// ---------------------------------------------------------------------------

function dirOf(key: string, value: string): ConfDirective {
  return { key, value, line: 1, directiveType: key };
}

describe('applyIndexedExtractions — FIELD_DELIMITER (#184)', () => {
  it('splits on the declared character instead of the format default', () => {
    const events = applyIndexedExtractions(
      [event('a;b;c'), event('1;2;3')],
      [dir('csv'), dirOf('FIELD_DELIMITER', ';')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('decodes the named tokens (space)', () => {
    const events = applyIndexedExtractions(
      [event('a b'), event('1 2')],
      [dir('csv'), dirOf('FIELD_DELIMITER', 'space')],
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('treats whitespace as a run separator in ws mode', () => {
    const events = applyIndexedExtractions(
      [event('a  b\tc'), event('1   2\t\t3')],
      [dir('csv'), dirOf('FIELD_DELIMITER', 'whitespace')],
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2', c: '3' });
  });
});

describe('applyIndexedExtractions — FIELD_QUOTE (#184)', () => {
  it('honours a non-default quote character', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event("'1,5',2")],
      [dir('csv'), dirOf('FIELD_QUOTE', "'")],
    );
    expect(events[0]!.fields).toMatchObject({ a: '1,5', b: '2' });
  });

  it('disables quote handling with FIELD_QUOTE = none', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event('"1,2')],
      [dir('csv'), dirOf('FIELD_QUOTE', 'none')],
    );
    expect(events[0]!.fields).toMatchObject({ a: '"1', b: '2' });
  });
});

describe('applyIndexedExtractions — FIELD_NAMES (#184)', () => {
  it('names fields directly for headerless data, consuming no header line', () => {
    const events = applyIndexedExtractions(
      [event('2026-01-15T10:00:00Z,alice,200'), event('2026-01-15T10:00:01Z,bob,404')],
      [dir('csv'), dirOf('FIELD_NAMES', 'ts, user, status')],
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.fields).toMatchObject({ user: 'alice', status: '200' });
    expect(events[1]!.fields).toMatchObject({ user: 'bob', status: '404' });
  });

  it('accepts quoted names and sanitizes them like a header line', () => {
    const events = applyIndexedExtractions(
      [event('1,2')],
      [dir('csv'), dirOf('FIELD_NAMES', '"col a", "col-b"')],
    );
    expect(events[0]!.fields).toMatchObject({ col_a: '1', 'col_b': '2' });
  });
});

describe('applyIndexedExtractions — HEADER_FIELD_LINE_NUMBER (#184)', () => {
  it('takes the header from the declared 1-based line', () => {
    const events = applyIndexedExtractions(
      [event('Report for January'), event('a,b'), event('1,2')],
      [dir('csv'), dirOf('HEADER_FIELD_LINE_NUMBER', '2')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });
});

describe('applyIndexedExtractions — PREAMBLE_REGEX (#184)', () => {
  it('skips leading preamble lines before the header', () => {
    const events = applyIndexedExtractions(
      [event('; generated by tool'), event('; do not edit'), event('a,b'), event('1,2')],
      [dir('csv'), dirOf('PREAMBLE_REGEX', '^;')],
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('warns when the pattern cannot be compiled, and skips nothing', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyIndexedExtractions(
      [event('a,b'), event('1,2')],
      [dir('csv'), dirOf('PREAMBLE_REGEX', '(')],
      diagnostics,
    );
    expect(diagnostics.some((d) => d.message.includes('PREAMBLE_REGEX'))).toBe(true);
  });
});

describe('applyIndexedExtractions — TIMESTAMP_FIELDS (#184)', () => {
  it('composes _time from the named fields using TIME_FORMAT', () => {
    const events = applyIndexedExtractions(
      [event('date,time,user'), event('2026-01-15,10:00:00,alice')],
      [
        dir('csv'),
        dirOf('TIMESTAMP_FIELDS', 'date, time'),
        dirOf('TIME_FORMAT', '%Y-%m-%d %H:%M:%S'),
        dirOf('TZ', 'UTC'),
      ],
    );
    expect(events[0]!._time?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });

  it('leaves _time alone when the named fields are absent', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event('1,2')],
      [dir('csv'), dirOf('TIMESTAMP_FIELDS', 'nope'), dirOf('TIME_FORMAT', '%Y-%m-%d')],
    );
    expect(events[0]!._time).toBeNull();
  });
});

// Doc-derived (props.conf.spec 10.4.3, JSON_TRIM_BRACES_IN_ARRAY_NAMES): no
// capture pins this attribute, so the assertions stay close to the spec's own
// example and the default.
describe('applyIndexedExtractions — JSON_TRIM_BRACES_IN_ARRAY_NAMES (#274)', () => {
  const raw = '{"data":{"mount_point":["/","/home"]}}';

  it('keeps the {} marker by default', () => {
    const events = applyIndexedExtractions([event(raw)], [dir('json')]);
    expect(events[0]!.fields['data.mount_point{}']).toEqual(['/', '/home']);
    expect(events[0]!.fields['data.mount_point']).toBeUndefined();
  });

  it('strips it when true, as the spec example shows', () => {
    const events = applyIndexedExtractions(
      [event(raw)],
      [dir('json'), dirOf('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'true')],
    );
    expect(events[0]!.fields['data.mount_point']).toEqual(['/', '/home']);
    expect(events[0]!.fields['data.mount_point{}']).toBeUndefined();
  });

  it('strips the marker inside a path too, since every {} is an array name', () => {
    // Our reading: the spec's example is a leaf array, but `items{}.id` is
    // named through the same array, so its braces go as well.
    const events = applyIndexedExtractions(
      [event('{"items":[{"id":1},{"id":2}]}')],
      [dir('json'), dirOf('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'true')],
    );
    expect(events[0]!.fields['items.id']).toEqual(['1', '2']);
  });

  it('keeps a top-level array as {}, having no name to trim back to', () => {
    const events = applyIndexedExtractions(
      [event('["a","b"]')],
      [dir('json'), dirOf('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'true')],
    );
    expect(events[0]!.fields['{}']).toEqual(['a', 'b']);
  });

  it('does not apply to KV_MODE = json, which the spec does not scope it to', () => {
    const { result } = runPipeline(
      `${raw}\n`,
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nKV_MODE = json\nJSON_TRIM_BRACES_IN_ARRAY_NAMES = true\n',
      '',
      { perEventPipeline: false, captureOffsets: false },
    );
    expect(result.events[0]!.fields['data.mount_point{}']).toEqual(['/', '/home']);
  });
});
