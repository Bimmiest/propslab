// Tests written against mutants that survived `npm run test:mutation` (#370).
// Most pin the "once per stanza" contract of the transform diagnostics — the
// suite ran every warning against one event, so a warning repeated per event
// (or suppressed after the first stanza) passed unnoticed — and the exact
// boundary of the DEST_KEY = _raw data-loss warning.
import { describe, it, expect } from 'vitest';
import { applyTransforms } from '../processors/transformsProcessor';
import type { SplunkEvent, ConfDirective, ConfStanza, ParsedConf, ValidationDiagnostic } from '../types';
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

function stanza(name: string, directives: Record<string, string>): ConfStanza {
  return {
    name,
    type: 'sourcetype',
    lineRange: { start: 1, end: 1 },
    directives: Object.entries(directives).map(([key, value], i) => ({ key, value, line: 10 + i, directiveType: key })),
  };
}

const conf = (...stanzas: ConfStanza[]): ParsedConf => ({ stanzas, errors: [] });
const transforms = (value: string, className = 'x'): ConfDirective =>
  ({ key: `TRANSFORMS-${className}`, value, line: 1, directiveType: 'TRANSFORMS', className });
const report = (value: string, className = 'x'): ConfDirective =>
  ({ key: `REPORT-${className}`, value, line: 1, directiveType: 'REPORT', className });

const twoEvents = () => [event('a=1 b=2'), event('a=3 b=4')];

describe('transform diagnostics fire once per stanza, and per stanza', () => {
  it('an uncompilable REGEX', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [transforms('bad1, bad2')], conf(stanza('bad1', { REGEX: '(x' }), stanza('bad2', { REGEX: '(y' })), 'index-time', runCtx(d));
    expect(d.map((x) => x.message.match(/^Transform "(\w+)" was skipped/)?.[1])).toEqual(['bad1', 'bad2']);
  });

  it('an index-time extraction that stores nothing', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [transforms('t1,t2')], conf(stanza('t1', { REGEX: 'a=(?<a>\\d)' }), stanza('t2', { REGEX: 'b=(?<b>\\d)' })), 'index-time', runCtx(d));
    const hits = d.filter((x) => x.message.includes('has no WRITE_META = true and no DEST_KEY'));
    expect(hits.map((x) => x.message.match(/"(\w+)"/)?.[1])).toEqual(['t1', 't2']);
  });

  it('search-time-only attributes on an index-time stanza', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [transforms('t')], conf(stanza('t', { REGEX: 'a=(?<a>\\d)', WRITE_META: 'true', MV_ADD: 'true' })), 'index-time', runCtx(d));
    const hits = d.filter((x) => x.message.includes('valid only for search-time'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('sets MV_ADD,');
    expect(hits[0]!.message).toContain('That attribute is valid only');
    expect(hits[0]!.message).toContain('ignores it here');
    expect(hits[0]!.message).not.toContain('DELIMS is the alternative');
    // Located at the attribute, not the stanza header.
    expect(hits[0]!.line).toBe(12);
  });

  it('search-time-only attributes, in the plural', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms([event('a=1')], [transforms('t')], conf(stanza('t', { DELIMS: '=', FIELDS: 'a' })), 'index-time', runCtx(d));
    const hit = d.find((x) => x.message.includes('valid only for search-time'))!;
    expect(hit.message).toContain('sets DELIMS, FIELDS,');
    expect(hit.message).toContain('Those attributes are valid only');
    expect(hit.message).toContain('ignores them here');
    expect(hit.message).toContain('DELIMS is the alternative to REGEX');
  });

  it('a DEST_KEY reached through REPORT-', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [report('t')], conf(stanza('t', { REGEX: 'a=(?<a>\\d)', DEST_KEY: '  _meta  ' })), 'search-time', runCtx(d));
    const hits = d.filter((x) => x.message.includes('referenced by a search-time REPORT-'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toMatch(/sets DEST_KEY = _meta, but/);
  });

  it('a REPORT- that matched but has no FORMAT and no named groups', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [report('t1,t2')], conf(stanza('t1', { REGEX: 'a=(\\d)' }), stanza('t2', { REGEX: 'b=(\\d)' })), 'search-time', runCtx(d));
    const hits = d.filter((x) => x.message.includes('extracts nothing. At search time FORMAT has no default'));
    expect(hits.map((x) => x.message.match(/"(\w+)"/)?.[1])).toEqual(['t1', 't2']);
  });

  it('an unknown DEST_KEY, located at its line', () => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(twoEvents(), [transforms('t')], conf(stanza('t', { REGEX: 'a=(\\d)', FORMAT: '$1', DEST_KEY: 'Bogus' })), 'index-time', runCtx(d));
    const hits = d.filter((x) => x.message.includes('is not a recognized Splunk DEST_KEY'));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(12);
  });
});

describe('the no-FORMAT warning at search time stays quiet when', () => {
  const quiet = (directives: Record<string, string>) => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms([event('a=1')], [report('t')], conf(stanza('t', directives)), 'search-time', runCtx(d));
    return d.filter((x) => x.message.includes('At search time FORMAT has no default'));
  };

  it('a FORMAT is present', () => expect(quiet({ REGEX: 'a=(\\d)', FORMAT: 'a::$1' })).toEqual([]));
  it('the stanza is a DELIMS one', () => expect(quiet({ DELIMS: '=', FIELDS: 'k,v' })).toEqual([]));
  it('the REGEX names its groups', () => expect(quiet({ REGEX: 'a=(?<a>\\d)(?<b>x)?' })).toEqual([]));
  it('fields were extracted', () => expect(quiet({ REGEX: 'a=(?<a>\\d)' })).toEqual([]));
});

describe('the DEST_KEY = _raw data-loss warning', () => {
  const lossWarnings = (raw: string, regex: string, format: string, events = 1) => {
    const d: ValidationDiagnostic[] = [];
    applyTransforms(
      Array.from({ length: events }, () => event(raw)),
      [transforms('m')],
      conf(stanza('m', { REGEX: regex, FORMAT: format, DEST_KEY: '_raw' })),
      'index-time',
      runCtx(d),
    );
    return d.filter((x) => x.message.includes('replaced the event and dropped'));
  };

  it('fires above 30% loss, once, with the counts', () => {
    const hits = lossWarnings('abcdefghij', '(abcdef)', '$1', 2);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.message).toContain('dropped 4 of 10 characters');
    expect(hits[0]!.line).toBe(12);
  });

  it('does not fire at exactly 30%', () => {
    expect(lossWarnings('abcdefghij', '(abcdefg)', '$1')).toEqual([]);
  });

  it('does not fire when the event grew', () => {
    expect(lossWarnings('abc', '(abc)', '$1$1$1')).toEqual([]);
  });

  it('does not fire when nothing was dropped', () => {
    expect(lossWarnings('abc', '(abc)', '$1')).toEqual([]);
  });
});

describe('what applyTransforms leaves on the event', () => {
  it('returns the input untouched when no directive applies to the phase', () => {
    const events = [event('a=1')];
    expect(applyTransforms(events, [report('t')], conf(stanza('t', { REGEX: 'a' })), 'index-time', runCtx())).toBe(events);
  });

  it('skips blank entries in a comma-separated list rather than reporting a missing stanza', () => {
    const [e] = applyTransforms([event('zzz')], [transforms(' , t ,,')], conf(stanza('t', { REGEX: 'a=(\\d)', FORMAT: 'a::$1', WRITE_META: 'true' })), 'index-time', runCtx());
    expect(e!.noOps).toHaveLength(1);
    expect(e!.noOps![0]!.directive).toBe('TRANSFORMS-x → [t]');
  });

  it('carries no noOps key when every transform had an effect', () => {
    const [e] = applyTransforms([event('a=1')], [transforms('t')], conf(stanza('t', { REGEX: 'a=(\\d)', FORMAT: 'a::$1', WRITE_META: 'true' })), 'index-time', runCtx());
    expect(e).not.toHaveProperty('noOps');
  });

  it('describes a matched transform that extracted nothing', () => {
    const [e] = applyTransforms([event('a=1')], [transforms('t')], conf(stanza('t', { REGEX: 'a=\\d', WRITE_META: 'true' })), 'index-time', runCtx());
    expect(e!.processingTrace.at(-1)!.description).toBe('Transform matched; it extracted no fields');
  });

  it('describes a CLONE_SOURCETYPE stanza by what it does, with the name trimmed', () => {
    const out = applyTransforms([event('a=1')], [transforms('t')], conf(stanza('t', { REGEX: 'a=\\d', CLONE_SOURCETYPE: '  copy  ' })), 'index-time', runCtx());
    expect(out).toHaveLength(2);
    expect(out[0]!.processingTrace.at(-1)!.description).toBe('Transform matched; it extracts no fields, and CLONE_SOURCETYPE = copy copies the event');
    expect(out[1]!.metadata.sourcetype).toBe('copy');
  });

  it('emits exactly one event when nothing was cloned', () => {
    const out = applyTransforms([event('a=1'), event('a=2')], [transforms('t')], conf(stanza('t', { REGEX: 'a=(\\d)', FORMAT: 'a::$1', WRITE_META: 'true' })), 'index-time', runCtx());
    expect(out).toHaveLength(2);
  });
});

describe('STOP_PROCESSING_IF trace wording', () => {
  it('says so when no rule follows the stop in its list', () => {
    const [e] = applyTransforms(
      [event('a')],
      [transforms('a, stop')],
      conf(stanza('a', { REGEX: 'a', WRITE_META: 'true' }), stanza('stop', { STOP_PROCESSING_IF: 'true()' })),
      'index-time',
      runCtx(),
    );
    expect(e!.processingTrace.at(-1)!.description).toBe('STOP_PROCESSING_IF (true()) was true — no rules follow it in TRANSFORMS-x');
  });

  it('names the rules it skipped', () => {
    const [e] = applyTransforms(
      [event('a')],
      [transforms('stop, a')],
      conf(stanza('a', { REGEX: 'a', WRITE_META: 'true' }), stanza('stop', { STOP_PROCESSING_IF: 'true()' })),
      'index-time',
      runCtx(),
    );
    expect(e!.processingTrace.at(-1)!.description).toBe('STOP_PROCESSING_IF (true()) was true — skipped the rest of TRANSFORMS-x: a');
  });

  it('does not treat a plain regex stanza as an INGEST_EVAL one', () => {
    const [e] = applyTransforms([event('a=1')], [transforms('t')], conf(stanza('t', { REGEX: 'a=(\\d)', FORMAT: 'a::$1', WRITE_META: 'true' })), 'index-time', runCtx());
    expect(e!.fields).toEqual({ a: '1' });
  });
});
