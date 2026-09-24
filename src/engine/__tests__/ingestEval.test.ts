import { describe, it, expect } from 'vitest';
import { applyIngestEval } from '../transforms/ingestEval';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, EventMetadata } from '../types';

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

function ingestDir(value: string): ConfDirective[] {
  return [{ key: 'INGEST_EVAL', value, line: 1, directiveType: 'INGEST_EVAL' }];
}

describe('applyIngestEval', () => {
  it('assigns a literal value to a field', () => {
    const e = applyIngestEval([event('x')], ingestDir('tag="prod"'))[0]!;
    expect(e.fields.tag).toBe('prod');
  });

  it('splits multiple top-level assignments on commas', () => {
    const e = applyIngestEval([event('x')], ingestDir('a="1", b="2"'))[0]!;
    expect(e.fields.a).toBe('1');
    expect(e.fields.b).toBe('2');
  });

  // #59.2: two INGEST_EVAL lines in a stanza — Splunk applies only the last.
  it('applies only the last INGEST_EVAL when the key is repeated (last-wins)', () => {
    const dirs: ConfDirective[] = [
      { key: 'INGEST_EVAL', value: 'tag="first"', line: 1, directiveType: 'INGEST_EVAL' },
      { key: 'INGEST_EVAL', value: 'tag="second"', line: 2, directiveType: 'INGEST_EVAL' },
    ];
    const e = applyIngestEval([event('x')], dirs)[0]!;
    expect(e.fields.tag).toBe('second');
  });

  // BUG-3: a comma inside a string literal must not split the assignment.
  it('does not split on a comma inside a quoted string', () => {
    const e = applyIngestEval([event('x')], ingestDir('msg="a,b"'))[0]!;
    expect(e.fields.msg).toBe('a,b');
  });

  it('does not split on a comma inside parentheses', () => {
    const e = applyIngestEval([event('x')], ingestDir('n=if(1==1,"yes","no")'))[0]!;
    expect(e.fields.n).toBe('yes');
  });

  // #25: a value ending in an escaped backslash (\\) closes the quote — the
  // following top-level comma must still split, not be swallowed.
  it('closes a literal ending in an escaped backslash and splits the next assignment', () => {
    // a = the Windows path `c:\` (written `c:\\` in the config), then b=2.
    const e = applyIngestEval([event('x')], ingestDir('a="c:\\\\", b=2'))[0]!;
    expect(e.fields.a).toBe('c:\\');
    expect(e.fields.b).toBe('2');
  });
});

describe('applyIngestEval — queue assignment routes the event (#58)', () => {
  it('routes to nullQueue rather than writing a plain field', () => {
    const out = applyIngestEval(
      [event('DEBUG connection retry')],
      ingestDir('queue=if(match(_raw,"DEBUG"), "nullQueue", "indexQueue")'),
    )[0]!;
    expect(out._meta._queue).toBe('nullQueue');
    expect(out.fields.queue).toBeUndefined();
  });

  it('routes a non-matching event to indexQueue', () => {
    const out = applyIngestEval(
      [event('INFO all good')],
      ingestDir('queue=if(match(_raw,"DEBUG"), "nullQueue", "indexQueue")'),
    )[0]!;
    expect(out._meta._queue).toBe('indexQueue');
    expect(out.fields.queue).toBeUndefined();
  });

  it('does not mutate the input event', () => {
    const input = event('DEBUG x');
    applyIngestEval([input], ingestDir('queue="nullQueue"'));
    expect(input._meta._queue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #327: INGEST_EVAL only special-cased _time, _raw and queue, so
// `INGEST_EVAL = index="security"` wrote an indexed field called `index` and
// left the event in its original index; and `x := expr` was split at the `=`,
// writing a field literally named `x:`.
//
// Doc-derived (transforms.conf.spec, INGEST_EVAL): assignments may use `=` or
// `:=`, several may be comma-separated, and assigning to index, host, source or
// sourcetype sets that metadata on the event rather than adding a field — the
// same effect DEST_KEY = MetaData:<Key> has, with the bare value (no `host::`
// prefix). `:=` replaces any existing value of the field.
//
// Uncertain, and deliberately not asserted: the spec describes `=` on an
// indexed field that already exists as ADDING a value (making it multivalue)
// rather than replacing it. The simulator still replaces on `=`, as it did
// before #327; no fidelity fixture covers INGEST_EVAL to settle it.
// ---------------------------------------------------------------------------

describe('applyIngestEval — metadata keys rewrite the event metadata (#327)', () => {
  it.each([
    ['index', 'index="security"', 'security'],
    ['host', 'host="web01"', 'web01'],
    ['source', 'source="/var/log/app.log"', '/var/log/app.log'],
    ['sourcetype', 'sourcetype="app:json"', 'app:json'],
  ] as const)('%s= sets metadata.%s, not a field', (key, expr, expected) => {
    const out = applyIngestEval([event('x')], ingestDir(expr))[0]!;
    expect(out.metadata[key]).toBe(expected);
    expect(out.fields[key]).toBeUndefined();
  });

  it('evaluates the expression against the event', () => {
    const out = applyIngestEval(
      [event('ERROR auth failed')],
      ingestDir('index=if(match(_raw, "auth"), "security", index)'),
    )[0]!;
    expect(out.metadata.index).toBe('security');
  });

  it('lets a later assignment in the same list read the rewritten metadata', () => {
    const out = applyIngestEval([event('x')], ingestDir('sourcetype="new", tag=sourcetype'))[0]!;
    expect(out.metadata.sourcetype).toBe('new');
    expect(out.fields.tag).toBe('new');
  });

  it('keeps the existing metadata when the expression is null', () => {
    const out = applyIngestEval([event('x')], ingestDir('host=null()'))[0]!;
    expect(out.metadata.host).toBe('h');
  });

  it('does not mutate the input event', () => {
    const input = event('x');
    applyIngestEval([input], ingestDir('index="security"'));
    expect(input.metadata.index).toBe('main');
  });
});

describe('applyIngestEval — the := operator (#327)', () => {
  it('assigns to the named field, not one ending in a colon', () => {
    const out = applyIngestEval([event('x')], ingestDir('x := "1"'))[0]!;
    expect(out.fields.x).toBe('1');
    expect(out.fields['x:']).toBeUndefined();
  });

  it('replaces an existing field value', () => {
    const input = { ...event('x'), fields: { x: 'old' } };
    const out = applyIngestEval([input], ingestDir('x:="new"'))[0]!;
    expect(out.fields.x).toBe('new');
  });

  it('mixes with = in a comma-separated list', () => {
    const out = applyIngestEval([event('x')], ingestDir('a="1", b:=a . "2", index:="security"'))[0]!;
    expect(out.fields.a).toBe('1');
    expect(out.fields.b).toBe('12');
    expect(out.metadata.index).toBe('security');
  });

  it('routes the special keys the same way = does', () => {
    const out = applyIngestEval([event('DEBUG x')], ingestDir('queue:="nullQueue", _raw:="y"'))[0]!;
    expect(out._meta._queue).toBe('nullQueue');
    expect(out._raw).toBe('y');
  });

  it('ignores an assignment with no field name', () => {
    const out = applyIngestEval([event('x')], ingestDir(':="1"'))[0]!;
    expect(out.fields).toEqual({});
  });
});

describe('runPipeline — INGEST_EVAL metadata rewrites re-match stanzas (#327)', () => {
  // Doc-derived, as above: a sourcetype rewritten at index time is a new
  // sourcetype for search-time props, whichever mechanism rewrote it.
  const meta: EventMetadata = { index: 'main', host: 'h', source: '/a.log', sourcetype: 'st' };
  const props =
    '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-r = to_new\n' +
    '[new_st]\nEVAL-seen = "new_st"\n';
  const transforms = '[to_new]\nINGEST_EVAL = sourcetype="new_st", index="security"\n';

  it('per-event mode applies the new sourcetype\'s search-time config', () => {
    const { result } = runPipeline('a', meta, props, transforms, { perEventPipeline: true });
    const ev = result.events[0]!;
    expect(ev.metadata.sourcetype).toBe('new_st');
    expect(ev.metadata.index).toBe('security');
    expect(ev.fields.seen).toBe('new_st');
    expect(ev.processingTrace.some((s) => s.processor === 'StanzaRematch')).toBe(true);
  });

  it('batch mode warns that search-time config still follows the original sourcetype', () => {
    const { result, diagnostics } = runPipeline('a', meta, props, transforms, { perEventPipeline: false });
    expect(result.events[0]!.metadata.sourcetype).toBe('new_st');
    expect(result.events[0]!.fields.seen).toBeUndefined();
    expect(diagnostics.some((d) => d.message.includes('sourcetype/host/source rewritten'))).toBe(true);
  });
});
