import { describe, it, expect } from 'vitest';
import { applyIngestEval, ingestEvalExpressions } from '../transforms/ingestEval';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, EventMetadata, ValidationDiagnostic } from '../types';
import { runCtx } from './runCtx';

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
    const e = applyIngestEval([event('x')], ingestDir('tag="prod"'), runCtx())[0]!;
    expect(e.fields.tag).toBe('prod');
  });

  it('splits multiple top-level assignments on commas', () => {
    const e = applyIngestEval([event('x')], ingestDir('a="1", b="2"'), runCtx())[0]!;
    expect(e.fields.a).toBe('1');
    expect(e.fields.b).toBe('2');
  });

  // Two INGEST_EVAL lines in a stanza — Splunk applies only the last.
  it('applies only the last INGEST_EVAL when the key is repeated (last-wins)', () => {
    const dirs: ConfDirective[] = [
      { key: 'INGEST_EVAL', value: 'tag="first"', line: 1, directiveType: 'INGEST_EVAL' },
      { key: 'INGEST_EVAL', value: 'tag="second"', line: 2, directiveType: 'INGEST_EVAL' },
    ];
    const e = applyIngestEval([event('x')], dirs, runCtx())[0]!;
    expect(e.fields.tag).toBe('second');
  });

  // BUG-3: a comma inside a string literal must not split the assignment.
  it('does not split on a comma inside a quoted string', () => {
    const e = applyIngestEval([event('x')], ingestDir('msg="a,b"'), runCtx())[0]!;
    expect(e.fields.msg).toBe('a,b');
  });

  it('does not split on a comma inside parentheses', () => {
    const e = applyIngestEval([event('x')], ingestDir('n=if(1==1,"yes","no")'), runCtx())[0]!;
    expect(e.fields.n).toBe('yes');
  });

  // A value ending in an escaped backslash (\\) closes the quote — the
  // following top-level comma must still split, not be swallowed.
  it('closes a literal ending in an escaped backslash and splits the next assignment', () => {
    // a = the Windows path `c:\` (written `c:\\` in the config), then b=2.
    const e = applyIngestEval([event('x')], ingestDir('a="c:\\\\", b=2'), runCtx())[0]!;
    expect(e.fields.a).toBe('c:\\');
    expect(e.fields.b).toBe('2');
  });
});

describe('applyIngestEval — queue assignment routes the event (#58)', () => {
  it('routes to nullQueue rather than writing a plain field', () => {
    const out = applyIngestEval(
      [event('DEBUG connection retry')],
      ingestDir('queue=if(match(_raw,"DEBUG"), "nullQueue", "indexQueue")'),
      runCtx(),
    )[0]!;
    expect(out._meta._queue).toBe('nullQueue');
    expect(out.fields.queue).toBeUndefined();
  });

  it('routes a non-matching event to indexQueue', () => {
    const out = applyIngestEval(
      [event('INFO all good')],
      ingestDir('queue=if(match(_raw,"DEBUG"), "nullQueue", "indexQueue")'),
      runCtx(),
    )[0]!;
    expect(out._meta._queue).toBe('indexQueue');
    expect(out.fields.queue).toBeUndefined();
  });

  it('does not mutate the input event', () => {
    const input = event('DEBUG x');
    applyIngestEval([input], ingestDir('queue="nullQueue"'), runCtx());
    expect(input._meta._queue).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// INGEST_EVAL assignments to metadata, and the `:=` operator.
//
// Doc-derived (transforms.conf.spec, INGEST_EVAL): assignments may use `=` or
// `:=`, several may be comma-separated, and assigning to index, host, source or
// sourcetype sets that metadata on the event rather than adding a field — the
// same effect DEST_KEY = MetaData:<Key> has, with the bare value (no `host::`
// prefix). `:=` replaces any existing value of the field.
//
// Uncertain, and deliberately not asserted: the spec describes `=` on an
// indexed field that already exists as ADDING a value (making it multivalue)
// rather than replacing it. The simulator replaces on `=`; no fidelity fixture
// covers INGEST_EVAL to settle it.
// ---------------------------------------------------------------------------

describe('applyIngestEval — metadata keys rewrite the event metadata (#327)', () => {
  it.each([
    ['index', 'index="security"', 'security'],
    ['host', 'host="web01"', 'web01'],
    ['source', 'source="/var/log/app.log"', '/var/log/app.log'],
    ['sourcetype', 'sourcetype="app:json"', 'app:json'],
  ] as const)('%s= sets metadata.%s, not a field', (key, expr, expected) => {
    const out = applyIngestEval([event('x')], ingestDir(expr), runCtx())[0]!;
    expect(out.metadata[key]).toBe(expected);
    expect(out.fields[key]).toBeUndefined();
  });

  it('evaluates the expression against the event', () => {
    const out = applyIngestEval(
      [event('ERROR auth failed')],
      ingestDir('index=if(match(_raw, "auth"), "security", index)'),
      runCtx(),
    )[0]!;
    expect(out.metadata.index).toBe('security');
  });

  it('lets a later assignment in the same list read the rewritten metadata', () => {
    const out = applyIngestEval([event('x')], ingestDir('sourcetype="new", tag=sourcetype'), runCtx())[0]!;
    expect(out.metadata.sourcetype).toBe('new');
    expect(out.fields.tag).toBe('new');
  });

  it('keeps the existing metadata when the expression is null', () => {
    const out = applyIngestEval([event('x')], ingestDir('host=null()'), runCtx())[0]!;
    expect(out.metadata.host).toBe('h');
  });

  it('does not mutate the input event', () => {
    const input = event('x');
    applyIngestEval([input], ingestDir('index="security"'), runCtx());
    expect(input.metadata.index).toBe('main');
  });
});

describe('applyIngestEval — the := operator (#327)', () => {
  it('assigns to the named field, not one ending in a colon', () => {
    const out = applyIngestEval([event('x')], ingestDir('x := "1"'), runCtx())[0]!;
    expect(out.fields.x).toBe('1');
    expect(out.fields['x:']).toBeUndefined();
  });

  it('replaces an existing field value', () => {
    const input = { ...event('x'), fields: { x: 'old' } };
    const out = applyIngestEval([input], ingestDir('x:="new"'), runCtx())[0]!;
    expect(out.fields.x).toBe('new');
  });

  it('mixes with = in a comma-separated list', () => {
    const out = applyIngestEval([event('x')], ingestDir('a="1", b:=a . "2", index:="security"'), runCtx())[0]!;
    expect(out.fields.a).toBe('1');
    expect(out.fields.b).toBe('12');
    expect(out.metadata.index).toBe('security');
  });

  it('routes the special keys the same way = does', () => {
    const out = applyIngestEval([event('DEBUG x')], ingestDir('queue:="nullQueue", _raw:="y"'), runCtx())[0]!;
    expect(out._meta._queue).toBe('nullQueue');
    expect(out._raw).toBe('y');
  });

  it('ignores an assignment with no field name', () => {
    const out = applyIngestEval([event('x')], ingestDir(':="1"'), runCtx())[0]!;
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

describe('applyIngestEval — the trace says what was rewritten (#346)', () => {
  // Trace content, not Splunk behaviour: nothing here is a fidelity claim.
  const step = (e: SplunkEvent) => e.processingTrace[e.processingTrace.length - 1]!;

  it('records each metadata rewrite old → new, structured and in the description', () => {
    const out = applyIngestEval([event('x')], ingestDir('index="security", host="web01", tag="t"'), runCtx())[0]!;
    expect(step(out).metadataChanges).toEqual([
      { key: 'index', from: 'main', to: 'security' },
      { key: 'host', from: 'h', to: 'web01' },
    ]);
    // Named by DEST_KEY, as a DEST_KEY = MetaData:* step is, so the Raw tab's
    // metadata-change row finds the step that made the change.
    expect(step(out).description).toContain('MetaData:Index "main" → "security"');
    expect(step(out).description).toContain('MetaData:Host "h" → "web01"');
  });

  it('records the net change when one list rewrites a key twice', () => {
    const out = applyIngestEval([event('x')], ingestDir('index="a", index="b"'), runCtx())[0]!;
    expect(step(out).metadataChanges).toEqual([{ key: 'index', from: 'main', to: 'b' }]);
  });

  it('records nothing for an assignment that leaves the metadata as it was', () => {
    const out = applyIngestEval([event('x')], ingestDir('index="main", host=null(), tag="t"'), runCtx())[0]!;
    expect(step(out).metadataChanges).toBeUndefined();
    expect(step(out).description).toBe('Evaluated 3 ingest-time expression(s)');
  });

  it('records a _raw rewrite as a mutation of its own step, with before/after text', () => {
    const input = { ...event('user=alice secret=hunter2'), processingTrace: [{ processor: 'p', phase: 'index-time' as const, description: 'd' }] };
    const out = applyIngestEval([input], ingestDir('_raw=replace(_raw, "secret=\\\\S+", "")'), runCtx())[0]!;
    expect(out._raw).toBe('user=alice ');
    expect(out.rawMutations).toEqual([{ traceIndex: 1, rawBefore: 'user=alice secret=hunter2', rawAfter: 'user=alice ' }]);
    expect(step(out).inputSnapshot).toContain('secret=hunter2');
    expect(step(out).outputSnapshot).toBe('user=alice ');
  });

  it('records no mutation when _raw is assigned its own value', () => {
    const out = applyIngestEval([event('x')], ingestDir('_raw=_raw'), runCtx())[0]!;
    expect(out.rawMutations).toBeUndefined();
    expect(step(out).inputSnapshot).toBeUndefined();
  });
});

describe('INGEST_EVAL _time out of the Date range (#417)', () => {
  const meta: EventMetadata = { index: 'main', host: 'h', source: '/a.log', sourcetype: 'st' };
  const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-t = t\n';
  const raw = '2026-01-02 03:04:05 a\n2026-01-02 03:04:06 b';

  // A microsecond epoch where seconds belong, and numbers past any date.
  it.each(['100000000000000', 'pow(10,20)', '-100000000000000'])(
    'keeps the previous _time for _time=%s, and warns once',
    (expr) => {
      const transforms = `[t]\nINGEST_EVAL = _time=${expr}\n`;
      const { result, diagnostics } = runPipeline(raw, meta, props, transforms);
      expect(result.events).toHaveLength(2);
      for (const ev of result.events) {
        expect(ev._time?.toISOString()).toMatch(/^2026-01-02T/);
      }
      const warnings = diagnostics.filter((d) => d.message.includes('out of range'));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        level: 'warning',
        file: 'transforms.conf',
        directiveKey: 'INGEST_EVAL',
      });
      expect(warnings[0]!.message).toMatch(
        /^INGEST_EVAL _time: timestamp \S+ is out of range; the event keeps its previous _time$/,
      );
    },
  );

  it('accepts the edges of the range and refuses just past them', () => {
    const [lo] = applyIngestEval([event('x')], ingestDir('_time=-8640000000000'), runCtx());
    const [hi] = applyIngestEval([event('x')], ingestDir('_time=8640000000000'), runCtx());
    expect(lo!._time!.getTime()).toBe(-8.64e15);
    expect(hi!._time!.getTime()).toBe(8.64e15);
    const diagnostics: ValidationDiagnostic[] = [];
    const [past] = applyIngestEval([event('x')], ingestDir('_time=8640000000001'), runCtx(diagnostics));
    expect(past!._time).toBeNull();
    expect(diagnostics).toHaveLength(1);
  });
});

describe('runPipeline — INGEST_EVAL reports each problem once per run (#418)', () => {
  // The transforms pass runs INGEST_EVAL one event at a time, so what it has
  // reported must outlive a single call.
  const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-e = ev\n';
  const transforms =
    '[ev]\nINGEST_EVAL = h=md5(_raw), b=(1==1), r=if(match(_raw, "("), 1, 0), _time=8640000000001\n';
  const raw = ['one', 'two', 'three', 'four', 'five'].join('\n');

  it.each([false, true])('perEventPipeline=%s: five events, one of each diagnostic', (perEventPipeline) => {
    const { result, diagnostics } = runPipeline(raw, meta, props, transforms, { perEventPipeline });
    expect(result.events).toHaveLength(5);
    const count = (pred: (d: ValidationDiagnostic) => boolean) => diagnostics.filter(pred).length;
    expect(count((d) => d.message.startsWith('md5() is not fully simulated'))).toBe(1);
    expect(count((d) => d.level === 'error' && d.message.startsWith('INGEST_EVAL b:'))).toBe(1);
    expect(count((d) => d.message.startsWith('INGEST_EVAL r:'))).toBe(1);
    expect(count((d) => d.message.includes('INGEST_EVAL _time'))).toBe(1);
  });
});

describe('runPipeline — CLONE_SOURCETYPE does not repeat INGEST_EVAL problems per clone (#452)', () => {
  // Each clone is its own applyTransforms call, so the warning ledgers have to
  // belong to the pipeline run, not the call.
  const meta: EventMetadata = { index: 'main', host: 'h', source: 's', sourcetype: 'st' };
  const props = '[st]\nSHOULD_LINEMERGE = false\nTRANSFORMS-c = copy, ev\n\n[cloned]\nTRANSFORMS-e = ev\n';
  const transforms = '[copy]\nREGEX = .\nCLONE_SOURCETYPE = cloned\n\n[ev]\nINGEST_EVAL = b=(1==1)\n';

  it.each([false, true])('perEventPipeline=%s: three events and three clones, one error', (perEventPipeline) => {
    const { result, diagnostics } = runPipeline('one\ntwo\nthree', meta, props, transforms, { perEventPipeline });
    expect(result.events.filter((e) => e.clonedFrom !== undefined)).toHaveLength(3);
    expect(diagnostics.filter((d) => d.message.startsWith('INGEST_EVAL b:'))).toHaveLength(1);
  });
});

// Not Splunk behaviour: the engine's own accessor, pinned to split as
// applyIngestEval does (top-level commas only; `=` and `:=`).
describe('ingestEvalExpressions', () => {
  it('returns each assignment’s expression, split at top-level commas only', () => {
    expect(ingestEvalExpressions('a=upper(x), b:=if(y>1, "p,q", z) ,c = "s,t"')).toEqual([
      'upper(x)',
      'if(y>1, "p,q", z)',
      '"s,t"',
    ]);
  });

  it('skips a part that is not an assignment', () => {
    expect(ingestEvalExpressions('justanexpression, =x, a=1')).toEqual(['1']);
  });
});
