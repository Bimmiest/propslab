import { describe, it, expect } from 'vitest';
import { applyIndexedExtractions } from '../processors/indexedExtractions';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ValidationDiagnostic } from '../types';
import { runCtx, FIXED_NOW } from './runCtx';
import { makeEvent } from '../../test/makeEvent';

function event(raw: string): SplunkEvent {
  return makeEvent(raw);
}

function dir(value: string): ConfDirective {
  return { key: 'INDEXED_EXTRACTIONS', value, line: 1, directiveType: 'INDEXED_EXTRACTIONS' };
}

describe('applyIndexedExtractions — JSON', () => {
  it('extracts top-level JSON fields', () => {
    const events = applyIndexedExtractions(
      [event('{"action":"login","user":"alice","status":200}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['action']).toBe('login');
    expect(events[0]!.fields['user']).toBe('alice');
    // Numeric JSON values are stringified when stored in SplunkEvent.fields
    expect(events[0]!.fields['status']).toBe('200');
  });

  it('flattens nested JSON with dot notation', () => {
    const events = applyIndexedExtractions(
      [event('{"request":{"method":"GET","path":"/api"}}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['request.method']).toBe('GET');
    expect(events[0]!.fields['request.path']).toBe('/api');
  });

  it('keeps shallow siblings of an over-deep subtree (#357)', () => {
    // Not doc-derived: the depth limit is the simulator's own guard; it must
    // cost only the subtree past it, not the keys that follow.
    let deep = '"bottom"';
    for (let i = 0; i < 12; i++) deep = `{"n":${deep}}`;
    const events = applyIndexedExtractions(
      [event(`{"a":"first","deep":${deep},"status":"ok"}`)],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['a']).toBe('first');
    expect(events[0]!.fields['status']).toBe('ok');
    expect(events[0]!.processingTrace.at(-1)?.description).toMatch(/depth limit reached/);
  });

  it('returns event unchanged for invalid JSON', () => {
    const events = applyIndexedExtractions([event('not json')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields).toEqual({});
  });

  // A file saved as "UTF-8 with BOM" starts its first line with U+FEFF, which
  // is not part of the JSON document (RFC 8259 section 8.1 lets a parser
  // ignore it), and Splunk reads such a file's first event normally.
  it('reads JSON that starts with a byte order mark or has surrounding whitespace (#482)', () => {
    const events = applyIndexedExtractions([event('﻿{"a":1}'), event('  {"b":2}\n')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['a']).toBe('1');
    expect(events[1]!.fields['b']).toBe('2');
  });

  it('reports events that are not valid JSON instead of skipping them silently (#482)', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const bad = event('{"a":1,}');
    bad.lineNumbers = { start: 3, end: 3 };
    const events = applyIndexedExtractions(
      [event('{"ok":1}'), bad, event('not json')],
      [dir('json')],
      runCtx(FIXED_NOW, diagnostics),
    );
    expect(events[0]!.fields['ok']).toBe('1');
    expect(events[1]!.fields).toEqual({});
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ level: 'warning', file: 'raw', line: 3 });
    expect(diagnostics[0]!.message).toMatch(/INDEXED_EXTRACTIONS = json: 2 events not valid JSON/);
  });

  it('reports nothing for valid JSON, including a scalar', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyIndexedExtractions([event('{"a":1}'), event('42')], [dir('json')], runCtx(FIXED_NOW, diagnostics));
    expect(diagnostics).toEqual([]);
  });

  it('extracts a key named after a prototype member instead of mangling it', () => {
    const events = applyIndexedExtractions([event('{"toString":"v"}')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['toString']).toBe('v');
  });

  it('extracts prototype-colliding keys as real fields after underscore stripping', () => {
    // INDEXED_EXTRACTIONS strips leading underscores, so `_constructor` becomes
    // `constructor`. Splunk's spath/KV_MODE=json extract such keys verbatim, so
    // the value must land as an *own* data property (not the inherited function).
    const events = applyIndexedExtractions(
      [event('{"_constructor":"good","keep":"ok"}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(Object.prototype.hasOwnProperty.call(events[0]!.fields, 'constructor')).toBe(true);
    expect(events[0]!.fields['constructor']).toBe('good');
    expect(events[0]!.fields['keep']).toBe('ok');
  });

  it('names array-of-object fields with {} multivalue notation (not positional)', () => {
    const events = applyIndexedExtractions(
      [event('{"items":[{"id":1,"n":"a"},{"id":2,"n":"b"}]}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['items{}.id']).toEqual(['1', '2']);
    expect(events[0]!.fields['items{}.n']).toEqual(['a', 'b']);
    // Positional and stringified-parent forms must NOT appear.
    expect(events[0]!.fields['items.0.id']).toBeUndefined();
    expect(events[0]!.fields['items']).toBeUndefined();
  });

  it('names primitive arrays with {} as a multivalue field', () => {
    const events = applyIndexedExtractions([event('{"tags":["x","y","z"]}')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['tags{}']).toEqual(['x', 'y', 'z']);
    expect(events[0]!.fields['tags']).toBeUndefined();
  });

  it('does not emit a stringified container field for nested objects', () => {
    const events = applyIndexedExtractions(
      [event('{"user":{"name":"alice","id":5}}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['user.name']).toBe('alice');
    expect(events[0]!.fields['user.id']).toBe('5');
    expect(events[0]!.fields['user']).toBeUndefined();
  });

  it('decodes escaped characters via JSON.parse', () => {
    const events = applyIndexedExtractions(
      [event('{"msg":"line1\\nline2","q":"say \\"hi\\"","path":"C:\\\\tmp"}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['msg']).toBe('line1\nline2');
    expect(events[0]!.fields['q']).toBe('say "hi"');
    expect(events[0]!.fields['path']).toBe('C:\\tmp');
  });

  it('extracts a top-level JSON array', () => {
    const events = applyIndexedExtractions([event('[{"id":1},{"id":2}]')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['{}.id']).toEqual(['1', '2']);
  });

  it('populates fieldSourceKeys for underscore-stripped JSON keys', () => {
    const events = applyIndexedExtractions(
      [event('{"_GID":"100","_UID":"1000","normalKey":"value"}')],
      [dir('json')],
      runCtx(FIXED_NOW),
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
      [dir('json')],
      runCtx(FIXED_NOW),
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

    const events = applyIndexedExtractions([header, row1, row2], [dir('csv')], runCtx(FIXED_NOW));

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
    const events = applyIndexedExtractions([header, row], [dir('csv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['name']).toBe('Smith, John');
    expect(events[0]!.fields['description']).toBe('A "quoted" value');
  });
});

describe('applyIndexedExtractions — CSV quoting', () => {
  it('preserves interior whitespace of quoted fields but trims unquoted ones', () => {
    const header = event('name,note');
    const row = event('  bob  ,"  spaced value  "');
    const events = applyIndexedExtractions([header, row], [dir('csv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['name']).toBe('bob');
    expect(events[0]!.fields['note']).toBe('  spaced value  ');
  });
});

describe('applyIndexedExtractions — W3C quoting', () => {
  it('keeps a quoted field containing spaces as a single value', () => {
    const header = event('#Fields: cs-method cs(User-Agent) sc-status');
    const row = event('GET "Mozilla/5.0 (Windows NT 10.0)" 200');
    const events = applyIndexedExtractions([header, row], [dir('w3c')], runCtx(FIXED_NOW));
    // Header tokens are sanitized to the names Splunk indexes: the IIS
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
    const events = applyIndexedExtractions([header, row], [dir('tsv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['host']).toBe('myhost');
    expect(events[0]!.fields['source']).toBe('/var/log/app');
  });
});

describe('applyIndexedExtractions — leading underscore stripping', () => {
  it('strips leading _ from top-level JSON keys', () => {
    const events = applyIndexedExtractions(
      [event('{"_AUDIT_TYPE_NAME":"SYSCALL","user":"alice"}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['AUDIT_TYPE_NAME']).toBe('SYSCALL');
    expect(events[0]!.fields['_AUDIT_TYPE_NAME']).toBeUndefined();
    expect(events[0]!.fields['user']).toBe('alice');
  });

  it('strips leading _ from nested JSON keys at every depth', () => {
    const events = applyIndexedExtractions(
      [event('{"outer":{"_inner":"value","normal":"v2"}}')],
      [dir('json')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['outer.inner']).toBe('value');
    expect(events[0]!.fields['outer.normal']).toBe('v2');
    expect(events[0]!.fields['outer._inner']).toBeUndefined();
  });

  it('strips multiple leading underscores', () => {
    const events = applyIndexedExtractions([event('{"__double":"v"}')], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['double']).toBe('v');
  });

  it('strips leading _ from CSV headers', () => {
    const header = event('_ts,_user,action');
    const row = event('2024-01-15,alice,login');
    const events = applyIndexedExtractions([header, row], [dir('csv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['ts']).toBe('2024-01-15');
    expect(events[0]!.fields['user']).toBe('alice');
    expect(events[0]!.fields['action']).toBe('login');
    expect(events[0]!.fields['_ts']).toBeUndefined();
  });

  it('strips leading _ from W3C #Fields headers', () => {
    const header = event('#Fields: _cs-method uri status');
    const row = event('GET /api 200');
    const events = applyIndexedExtractions([header, row], [dir('w3c')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['cs_method']).toBe('GET');
    expect(events[0]!.fields['uri']).toBe('/api');
    expect(events[0]!.fields['status']).toBe('200');
    expect(events[0]!.fields['_cs_method']).toBeUndefined();
  });
});

describe('applyIndexedExtractions — no directive', () => {
  it('returns events unchanged when no INDEXED_EXTRACTIONS directive', () => {
    const ev = event('some raw data');
    const events = applyIndexedExtractions([ev], [], runCtx(FIXED_NOW));
    expect(events[0]!.fields).toEqual({});
  });
});

describe('applyIndexedExtractions — header is the first content line (#14)', () => {
  it('skips a leading blank line', () => {
    const events = applyIndexedExtractions(
      [event(''), event('ts,host'), event('2024-01-15,myhost')],
      [dir('csv')],
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields['host']).toBe('myhost');
  });

  it('skips a leading comment line', () => {
    const events = applyIndexedExtractions(
      [event('# exported 2024-01-15'), event('ts,host'), event('2024-01-15,myhost')],
      [dir('csv')],
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields['host']).toBe('myhost');
    expect(events[0]!.fields['#_exported_2024_01_15']).toBeUndefined();
  });

  it('returns events unchanged when there is no content line at all', () => {
    const events = applyIndexedExtractions([event(''), event('   ')], [dir('csv')], runCtx(FIXED_NOW));
    expect(events).toHaveLength(2);
  });
});

describe('applyIndexedExtractions — header names are sanitized (#68)', () => {
  it('rewrites W3C hyphens to underscores', () => {
    const events = applyIndexedExtractions(
      [event('#Fields: date time c-ip cs-uri-stem sc-status'), event('2024-01-15 10:00:00 10.0.0.1 /index.html 200')],
      [dir('w3c')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['c_ip']).toBe('10.0.0.1');
    expect(events[0]!.fields['cs_uri_stem']).toBe('/index.html');
    expect(events[0]!.fields['sc_status']).toBe('200');
    expect(events[0]!.fields['cs-uri-stem']).toBeUndefined();
  });

  it('rewrites delimited header names too', () => {
    const events = applyIndexedExtractions(
      [event('req-id,user.name,status'), event('abc,alice,200')],
      [dir('csv')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['req_id']).toBe('abc');
    expect(events[0]!.fields['user_name']).toBe('alice');
  });

  it('drops a W3C directive line that is not the first event', () => {
    const events = applyIndexedExtractions(
      [event('#Software: IIS'), event('#Fields: cs-method sc-status'), event('GET 200')],
      [dir('w3c')],
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields['cs_method']).toBe('GET');
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
// Delimited override attributes. These apply to csv/tsv/psv; W3C keeps
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
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('decodes the named tokens (space)', () => {
    const events = applyIndexedExtractions(
      [event('a b'), event('1 2')],
      [dir('csv'), dirOf('FIELD_DELIMITER', 'space')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('treats whitespace as a run separator in ws mode', () => {
    const events = applyIndexedExtractions(
      [event('a  b\tc'), event('1   2\t\t3')],
      [dir('csv'), dirOf('FIELD_DELIMITER', 'whitespace')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2', c: '3' });
  });
});

describe('applyIndexedExtractions — FIELD_QUOTE (#184)', () => {
  it('honours a non-default quote character', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event("'1,5',2")],
      [dir('csv'), dirOf('FIELD_QUOTE', "'")],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1,5', b: '2' });
  });

  it('disables quote handling with FIELD_QUOTE = none', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event('"1,2')],
      [dir('csv'), dirOf('FIELD_QUOTE', 'none')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '"1', b: '2' });
  });
});

describe('applyIndexedExtractions — FIELD_NAMES (#184)', () => {
  it('names fields directly for headerless data, consuming no header line', () => {
    const events = applyIndexedExtractions(
      [event('2026-01-15T10:00:00Z,alice,200'), event('2026-01-15T10:00:01Z,bob,404')],
      [dir('csv'), dirOf('FIELD_NAMES', 'ts, user, status')],
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(2);
    expect(events[0]!.fields).toMatchObject({ user: 'alice', status: '200' });
    expect(events[1]!.fields).toMatchObject({ user: 'bob', status: '404' });
  });

  it('accepts quoted names and sanitizes them like a header line', () => {
    const events = applyIndexedExtractions(
      [event('1,2')],
      [dir('csv'), dirOf('FIELD_NAMES', '"col a", "col-b"')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ col_a: '1', col_b: '2' });
  });
});

describe('applyIndexedExtractions — HEADER_FIELD_LINE_NUMBER (#184)', () => {
  it('takes the header from the declared 1-based line', () => {
    const events = applyIndexedExtractions(
      [event('Report for January'), event('a,b'), event('1,2')],
      [dir('csv'), dirOf('HEADER_FIELD_LINE_NUMBER', '2')],
      runCtx(FIXED_NOW),
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
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('warns when the pattern cannot be compiled, and skips nothing', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyIndexedExtractions(
      [event('a,b'), event('1,2')],
      [dir('csv'), dirOf('PREAMBLE_REGEX', '(')],
      runCtx(FIXED_NOW, diagnostics),
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
      runCtx(FIXED_NOW),
    );
    expect(events[0]!._time?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });

  // #444 corrected this. It read that a row whose named fields are missing
  // kept the _time the timestamp stage gave it; Splunk treats missing fields
  // like a value that does not parse, and the first row then gets the time of
  // indexing.
  it('gives the first row the time of indexing when the named fields are absent', () => {
    const events = applyIndexedExtractions(
      [event('a,b'), event('1,2')],
      [dir('csv'), dirOf('TIMESTAMP_FIELDS', 'nope'), dirOf('TIME_FORMAT', '%Y-%m-%d')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!._time?.getTime()).toBe(FIXED_NOW);
  });

  // #444 corrected this. It read that a value which does not parse left the
  // timestamp stage's _time in place, which that stage may have read from
  // anywhere in the row; Splunk does not search the row, and the first row
  // gets the time of indexing.
  it('gives the first row the time of indexing when its value does not parse', () => {
    const prior = new Date('2020-05-01T00:00:00Z');
    const [e] = applyIndexedExtractions(
      [event('ts,user'), { ...event('not-a-time,alice'), _time: prior }],
      [dir('csv'), dirOf('TIMESTAMP_FIELDS', 'ts'), dirOf('TIME_FORMAT', '%Y-%m-%d'), dirOf('TZ', 'UTC')],
      runCtx(new Date('2020-05-02T00:00:00Z')),
    );
    expect(e!._time?.toISOString()).toBe('2020-05-02T00:00:00.000Z');
    expect(e!.processingTrace.at(-1)).toMatchObject({
      processor: 'INDEXED_EXTRACTIONS(TIMESTAMP_FIELDS)',
      timeSource: 'current-time',
    });
    expect(e!.processingTrace.some((s) => s.description.includes('parsed from'))).toBe(false);
  });

  it('measures MAX_DAYS_AGO from PipelineOptions.now', () => {
    const { result } = runPipeline(
      'ts,user\n2019-03-04 05:06:07,alice\n',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nINDEXED_EXTRACTIONS = csv\nTIMESTAMP_FIELDS = ts\nTIME_FORMAT = %Y-%m-%d %H:%M:%S\nTZ = UTC\n',
      '',
      { perEventPipeline: false, captureOffsets: false, now: Date.parse('2019-03-05T00:00:00Z') },
    );
    const e = result.events[0]!;
    expect(e._time?.toISOString()).toBe('2019-03-04T05:06:07.000Z');
    expect(e.processingTrace.some((s) => s.description.startsWith('_time parsed from ts'))).toBe(true);
  });

  it('reports an out-of-bounds stamp once, not once per row', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    applyIndexedExtractions(
      [event('ts'), event('2010-01-01'), event('2010-01-02')],
      [dir('csv'), dirOf('TIMESTAMP_FIELDS', 'ts'), dirOf('TIME_FORMAT', '%Y-%m-%d'), dirOf('TZ', 'UTC')],
      runCtx(new Date('2020-01-01T00:00:00Z'), diagnostics),
    );
    expect(diagnostics.filter((d) => d.message.includes('so it was not used'))).toHaveLength(1);
  });
});

// TIMESTAMP_FIELDS for every structured format, and what happens when its
// value does not parse (#444).
describe('TIMESTAMP_FIELDS beyond the delimited formats, and its fallback (#444)', () => {
  /** Events for one `[st]` stanza, judged against a clock later than every stamp below. */
  const run = (raw: string, props: string) =>
    runPipeline(raw, { index: 'main', host: 'h', source: 's', sourcetype: 'st' }, `[st]\n${props}`, '', {
      perEventPipeline: false,
      captureOffsets: false,
      now: Date.parse('2026-10-01T00:00:00Z'),
    }).result.events;
  const times = (events: SplunkEvent[]) => events.map((e) => e._time?.toISOString());
  const step = (e: SplunkEvent | undefined) =>
    e?.processingTrace.find((s) => s.processor === 'INDEXED_EXTRACTIONS(TIMESTAMP_FIELDS)');

  const json = '{"created":"2026-01-01T00:00:00","when":"2026-01-15T10:00:00","user":"alice"}';

  it('is honoured for json, which otherwise takes the first timestamp in the event', () => {
    expect(times(run(json, 'INDEXED_EXTRACTIONS = json\nTZ = UTC\nTIMESTAMP_FIELDS = when\n'))).toEqual([
      '2026-01-15T10:00:00.000Z',
    ]);
    expect(times(run(json, 'INDEXED_EXTRACTIONS = json\nTZ = UTC\n'))).toEqual(['2026-01-01T00:00:00.000Z']);
  });

  it('reads a nested json value by its flattened name', () => {
    const nested = '{"created":"2026-01-01T00:00:00","meta":{"when":"2026-01-15T10:00:00"},"user":"alice"}';
    expect(times(run(nested, 'INDEXED_EXTRACTIONS = json\nTZ = UTC\nTIMESTAMP_FIELDS = meta.when\n'))).toEqual([
      '2026-01-15T10:00:00.000Z',
    ]);
  });

  it('is honoured for w3c', () => {
    const w3c = '#Version: 1.0\n#Fields: created when user\n2026-01-01T00:00:00 2026-01-15T10:00:00 alice';
    const events = run(w3c, 'INDEXED_EXTRACTIONS = w3c\nTZ = UTC\nTIMESTAMP_FIELDS = when\n');
    expect(times(events)).toEqual(['2026-01-15T10:00:00.000Z']);
    expect(events[0]!.fields['user']).toBe('alice');
  });

  const csv = 'when,user,created\n2026-01-15T10:00:00,alice,2026-03-01T00:00:00\ngarbage,bob,2026-02-01T00:00:00\n';

  it.each([
    ['without TIME_FORMAT', '', 'auto-recognition'],
    ['with TIME_FORMAT', 'TIME_FORMAT = %Y-%m-%dT%H:%M:%S\n', 'TIME_FORMAT'],
  ])(
    "gives a value that does not parse the previous event's _time, %s, and searches the row no further",
    (_, timeFormat, source) => {
      const events = run(csv, `INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n${timeFormat}`);
      expect(times(events)).toEqual(['2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z']);
      expect(step(events[1])?.timeSource).toBe('previous-event');
      expect(step(events[1])?.description).toMatch(/^No timestamp read from when \("garbage"\): /);
      expect(step(events[0])).toMatchObject({
        timeSource: source,
        description: '_time parsed from when ("2026-01-15T10:00:00")',
      });
    },
  );

  it('names the fields and the value it read, leaving out a field that is missing or empty', () => {
    const [e] = run(
      '{"date":"2026-01-15","time":""}',
      'INDEXED_EXTRACTIONS = json\nTZ = UTC\nTIMESTAMP_FIELDS = date, nope, time\nTIME_FORMAT = %Y-%m-%d\n',
    );
    expect(e!._time?.toISOString()).toBe('2026-01-15T00:00:00.000Z');
    expect(step(e)).toEqual({
      processor: 'INDEXED_EXTRACTIONS(TIMESTAMP_FIELDS)',
      phase: 'index-time',
      description: '_time parsed from date, nope, time ("2026-01-15")',
      timeSource: 'TIME_FORMAT',
      fieldsAdded: [],
      fieldsModified: ['_time'],
    });
  });

  // TIME_PREFIX and MAX_TIMESTAMP_LOOKAHEAD say where a timestamp sits in the
  // raw event; the value TIMESTAMP_FIELDS names is the timestamp itself.
  it.each([['TIME_PREFIX = nowhere\n'], ['MAX_TIMESTAMP_LOOKAHEAD = 4\n']])('ignores %s', (setting) => {
    const events = run(
      'user,when\nalice,2026-01-15T10:00:00\n',
      `INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n${setting}`,
    );
    expect(times(events)).toEqual(['2026-01-15T10:00:00.000Z']);
  });

  it('gives the first row the time of indexing when its value does not parse', () => {
    const events = run(
      'when,user,created\ngarbage,bob,2026-02-01T00:00:00\n',
      'INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n',
    );
    expect(times(events)).toEqual(['2026-10-01T00:00:00.000Z']);
    expect(step(events[0])?.timeSource).toBe('current-time');
  });

  it('treats a row with none of the fields as one whose value does not parse', () => {
    const events = run(
      'when,user,created\n2026-01-15T10:00:00,alice,2026-03-01T00:00:00\n,bob,2026-02-01T00:00:00\n',
      'INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n',
    );
    expect(times(events)).toEqual(['2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z']);
  });

  // Doc-derived: the ADD_EXTRA_TIME_FIELDS conventions in props.conf.spec. An
  // event whose _time was not read from its text has timestamp=none and no
  // date_* fields, so a row that fell back loses the ones the timestamp stage
  // wrote for the stamp it found elsewhere in the row.
  it('replaces the time fields of a row that fell back', () => {
    const [read, fellBack] = run(csv, 'INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n');
    expect(read!.fields['date_month']).toBe('january');
    expect(read!.fields['timestamp']).toBeUndefined();
    expect(fellBack!.fields['timestamp']).toBe('none');
    for (const name of ['date_month', 'date_mday', 'timestartpos', 'timeendpos']) {
      expect(fellBack!.fields[name]).toBeUndefined();
    }
    expect(fellBack!.fields).toMatchObject({ user: 'bob', created: '2026-02-01T00:00:00' });
  });

  it('keeps a column that shares a time field name', () => {
    const [e] = run(
      'timestamp,date_year,when,created\nfoo,1999,garbage,2026-02-01T00:00:00\n',
      'INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\n',
    );
    expect(e!.fields).toMatchObject({ timestamp: 'foo', date_year: '1999' });
    expect(e!.fields['date_month']).toBeUndefined();
  });

  it('adds no timestamp field to a row that fell back when ADD_EXTRA_TIME_FIELDS = none', () => {
    const [, fellBack] = run(
      csv,
      'INDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = when\nADD_EXTRA_TIME_FIELDS = none\n',
    );
    expect(fellBack!.fields['timestamp']).toBeUndefined();
    expect(fellBack!._time?.toISOString()).toBe('2026-01-15T10:00:00.000Z');
  });

  it('does not repeat a warning the timestamp stage already gave', () => {
    const { diagnostics } = runPipeline(
      'ts\n2010-01-01\n',
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      '[st]\nINDEXED_EXTRACTIONS = csv\nTZ = UTC\nTIMESTAMP_FIELDS = ts\nTIME_FORMAT = %Y-%m-%d\n',
      '',
      { perEventPipeline: false, captureOffsets: false, now: Date.parse('2020-01-01T00:00:00Z') },
    );
    expect(diagnostics.filter((d) => d.message.includes('so it was not used'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Header-side delimited overrides. Doc-derived: every assertion below
// is read from the props.conf.spec 10.4.3 text for the attribute, for all
// five: FIELD_HEADER_REGEX, HEADER_FIELD_DELIMITER,
// HEADER_FIELD_QUOTE, HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS and
// MISSING_VALUE_REGEX. The last describe of the group drives them through the
// pipeline from a props.conf stanza.
// ---------------------------------------------------------------------------

describe('applyIndexedExtractions — FIELD_HEADER_REGEX (#272)', () => {
  it('takes the header from the line the regex matches, after the match', () => {
    const events = applyIndexedExtractions(
      [event('#Version: 1'), event('#Fields: a,b'), event('1,2')],
      [dir('csv'), dirOf('FIELD_HEADER_REGEX', '^#Fields:\\s')],
      runCtx(FIXED_NOW),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
    expect(events[0]!.fields['Fields']).toBeUndefined();
  });

  it('strips the prefix from the line HEADER_FIELD_LINE_NUMBER names', () => {
    const events = applyIndexedExtractions(
      [event('banner'), event('>> a,b'), event('1,2')],
      [dir('csv'), dirOf('HEADER_FIELD_LINE_NUMBER', '2'), dirOf('FIELD_HEADER_REGEX', '^>>\\s*')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('extracts nothing when no line matches', () => {
    const input = [event('a,b'), event('1,2')];
    const events = applyIndexedExtractions(
      input,
      [dir('csv'), dirOf('FIELD_HEADER_REGEX', '^#Fields:')],
      runCtx(FIXED_NOW),
    );
    expect(events).toBe(input);
  });

  it('warns when the pattern cannot be compiled', () => {
    const diagnostics: ValidationDiagnostic[] = [];
    const events = applyIndexedExtractions(
      [event('a,b'), event('1,2')],
      [dir('csv'), dirOf('FIELD_HEADER_REGEX', '(')],
      runCtx(FIXED_NOW, diagnostics),
    );
    expect(diagnostics.some((d) => d.directiveKey === 'FIELD_HEADER_REGEX')).toBe(true);
    // …and falls back to locating the header as though it were unset.
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });
});

describe('applyIndexedExtractions — HEADER_FIELD_DELIMITER / HEADER_FIELD_QUOTE (#272)', () => {
  it('splits the header on its own delimiter and the body on the body one', () => {
    const events = applyIndexedExtractions(
      [event('a\tb\tc'), event('1,2,3')],
      [dir('csv'), dirOf('HEADER_FIELD_DELIMITER', 'tab')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('inherits FIELD_DELIMITER for the header when no header delimiter is set', () => {
    const events = applyIndexedExtractions(
      [event('a;b'), event('1;2')],
      [dir('csv'), dirOf('FIELD_DELIMITER', ';')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });

  it('honours a header-only quote character', () => {
    const events = applyIndexedExtractions(
      [event("'x,y',z"), event('1,2')],
      [dir('csv'), dirOf('HEADER_FIELD_QUOTE', "'")],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ x_y: '1', z: '2' });
  });

  it('HEADER_FIELD_QUOTE = none disables quoting in the header only', () => {
    const events = applyIndexedExtractions(
      [event('"a,b'), event('"1,5",2')],
      [dir('csv'), dirOf('HEADER_FIELD_QUOTE', 'none')],
      runCtx(FIXED_NOW),
    );
    // The header's `"a` cleans to `a`; the body still reads `"1,5"` as one value.
    expect(events[0]!.fields).toMatchObject({ a: '1,5', b: '2' });
  });

  it('HEADER_FIELD_DELIMITER = whitespace splits the header on runs', () => {
    const events = applyIndexedExtractions(
      [event('a   b'), event('1,2')],
      [dir('csv'), dirOf('HEADER_FIELD_DELIMITER', 'whitespace')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields).toMatchObject({ a: '1', b: '2' });
  });
});

describe('applyIndexedExtractions — HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS (#272)', () => {
  it('cleans field.name to field_name by default, as the spec example says', () => {
    const events = applyIndexedExtractions([event('field.name'), event('v')], [dir('csv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['field_name']).toBe('v');
  });

  it('keeps the characters it names', () => {
    const events = applyIndexedExtractions(
      [event('field.name,a-b'), event('v,w')],
      [dir('csv'), dirOf('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS', '.')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['field.name']).toBe('v');
    // Only the named characters are exempt.
    expect(events[0]!.fields['a_b']).toBe('w');
  });

  it('applies to FIELD_NAMES too, which go through the same cleaning', () => {
    const events = applyIndexedExtractions(
      [event('v')],
      [dir('csv'), dirOf('FIELD_NAMES', 'x.y'), dirOf('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS', '.')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['x.y']).toBe('v');
  });

  it('ignores characters outside ASCII, which the spec does not allow', () => {
    const events = applyIndexedExtractions(
      [event('café'), event('v')],
      [dir('csv'), dirOf('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS', 'é')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['caf_']).toBe('v');
  });
});

describe('applyIndexedExtractions — MISSING_VALUE_REGEX (#272)', () => {
  it('extracts no field for a value matching the placeholder', () => {
    const events = applyIndexedExtractions(
      [event('a,b,c'), event('1,-,NULL')],
      [dir('csv'), dirOf('MISSING_VALUE_REGEX', '^(-|NULL)$')],
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['a']).toBe('1');
    expect(events[0]!.fields['b']).toBeUndefined();
    expect(events[0]!.fields['c']).toBeUndefined();
  });

  it('keeps a literal dash when unset', () => {
    const events = applyIndexedExtractions([event('a'), event('-')], [dir('csv')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['a']).toBe('-');
  });
});

// Doc-derived (props.conf.spec 10.4.3, JSON_TRIM_BRACES_IN_ARRAY_NAMES): the
// assertions stay close to the spec's own example and the default.
describe('applyIndexedExtractions — JSON_TRIM_BRACES_IN_ARRAY_NAMES (#274)', () => {
  const raw = '{"data":{"mount_point":["/","/home"]}}';

  it('keeps the {} marker by default', () => {
    const events = applyIndexedExtractions([event(raw)], [dir('json')], runCtx(FIXED_NOW));
    expect(events[0]!.fields['data.mount_point{}']).toEqual(['/', '/home']);
    expect(events[0]!.fields['data.mount_point']).toBeUndefined();
  });

  it('strips it when true, as the spec example shows', () => {
    const events = applyIndexedExtractions(
      [event(raw)],
      [dir('json'), dirOf('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'true')],
      runCtx(FIXED_NOW),
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
      runCtx(FIXED_NOW),
    );
    expect(events[0]!.fields['items.id']).toEqual(['1', '2']);
  });

  it('keeps a top-level array as {}, having no name to trim back to', () => {
    const events = applyIndexedExtractions(
      [event('["a","b"]')],
      [dir('json'), dirOf('JSON_TRIM_BRACES_IN_ARRAY_NAMES', 'true')],
      runCtx(FIXED_NOW),
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

describe('header-side delimited overrides through the pipeline (#272)', () => {
  /** A csv stanza with `body` appended; every event's fields, header line consumed. */
  const fieldsOf = (raw: string, body: string) =>
    runPipeline(
      raw,
      { index: 'main', host: 'h', source: 's', sourcetype: 'st' },
      `[st]\nINDEXED_EXTRACTIONS = csv\n${body}`,
      '',
      { perEventPipeline: false, captureOffsets: false },
    ).result.events.map((e) => e.fields);

  it('FIELD_HEADER_REGEX takes the header from the line it matches', () => {
    const [f] = fieldsOf('#Version: 1\n#Fields: a,b\n1,2\n', 'FIELD_HEADER_REGEX = ^#Fields:\\s\n');
    expect(f).toMatchObject({ a: '1', b: '2' });
  });

  it('HEADER_FIELD_DELIMITER splits the header on its own delimiter', () => {
    const [f] = fieldsOf('a\tb\tc\n1,2,3\n', 'HEADER_FIELD_DELIMITER = tab\n');
    expect(f).toMatchObject({ a: '1', b: '2', c: '3' });
  });

  it('HEADER_FIELD_QUOTE gives the header its own quote character', () => {
    const [f] = fieldsOf("'x,y',z\n1,2\n", "HEADER_FIELD_QUOTE = '\n");
    expect(f).toMatchObject({ x_y: '1', z: '2' });
  });

  it('HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS keeps the characters it names in field names', () => {
    expect(fieldsOf('field.name\nv\n', '')[0]?.['field_name']).toBe('v');
    expect(fieldsOf('field.name\nv\n', 'HEADER_FIELD_ACCEPTABLE_SPECIAL_CHARACTERS = .\n')[0]?.['field.name']).toBe(
      'v',
    );
  });

  it('MISSING_VALUE_REGEX extracts no field for a placeholder value', () => {
    const [f] = fieldsOf('a,b\n1,-\n', 'MISSING_VALUE_REGEX = ^-$\n');
    expect(f?.['a']).toBe('1');
    expect(f?.['b']).toBeUndefined();
  });
});
