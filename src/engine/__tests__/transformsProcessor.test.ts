import { describe, it, expect } from 'vitest';
import { applyTransforms } from '../processors/transformsProcessor';
import { runPipeline } from '../pipeline';
import type { SplunkEvent, ConfDirective, ConfStanza, ParsedConf, ValidationDiagnostic } from '../types';

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
    directives: Object.entries(directives).map(([key, value]) => ({ key, value, line: 1, directiveType: key })),
  };
}

function transformsConf(name: string, directives: Record<string, string>): ParsedConf {
  return { stanzas: [stanza(name, directives)], errors: [] };
}

function multiTransformsConf(...stanzas: ConfStanza[]): ParsedConf {
  return { stanzas, errors: [] };
}

function transformsDir(stanzaName: string): ConfDirective[] {
  return [{ key: 'TRANSFORMS-x', value: stanzaName, line: 1, directiveType: 'TRANSFORMS', className: 'x' }];
}

/** Build a TRANSFORMS-<class> directive for a given class name and value. */
function classDir(className: string, value: string): ConfDirective {
  return { key: `TRANSFORMS-${className}`, value, line: 1, directiveType: 'TRANSFORMS', className };
}

const lossMsg = (d: ValidationDiagnostic) => d.message.includes('replaced the event and dropped');

describe('applyTransforms — DEST_KEY=_raw data-loss warning', () => {
  it('warns when the FORMAT drops a large chunk of the event', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('mask', {
      REGEX: '(?<ip>\\d+\\.\\d+\\.\\d+\\.\\d+)',
      FORMAT: '$1',
      DEST_KEY: '_raw',
    });
    const e = applyTransforms([event('connect from 10.0.0.1 port 443 with details')], transformsDir('mask'), conf, 'index-time', diags)[0]!;
    expect(e._raw).toBe('10.0.0.1'); // whole event replaced by the capture
    expect(diags.some(lossMsg)).toBe(true);
  });

  it('does not warn when the regex captures the whole line', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('mask', {
      REGEX: '(.*?)(\\d+\\.\\d+\\.\\d+\\.\\d+)(.*)',
      FORMAT: '$1REDACTED$3',
      DEST_KEY: '_raw',
    });
    const e = applyTransforms([event('connect from 10.0.0.1 port 443')], transformsDir('mask'), conf, 'index-time', diags)[0]!;
    expect(e._raw).toBe('connect from REDACTED port 443');
    expect(diags.some(lossMsg)).toBe(false);
  });

  it('warns at most once per stanza across many events', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('mask', { REGEX: '(?<a>\\d+)', FORMAT: '$1', DEST_KEY: '_raw' });
    const events = [
      event('aaaa 1 bbbb cccc dddd'),
      event('eeee 2 ffff gggg hhhh'),
      event('iiii 3 jjjj kkkk llll'),
    ];
    applyTransforms(events, transformsDir('mask'), conf, 'index-time', diags);
    expect(diags.filter(lossMsg)).toHaveLength(1);
  });
});

describe('applyTransforms — unknown DEST_KEY warning (SEM-11)', () => {
  const unknownMsg = (d: ValidationDiagnostic) => d.message.includes('is not a recognized Splunk DEST_KEY');

  it('warns when DEST_KEY is not a documented key', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('route', { REGEX: '(.*)', FORMAT: '$1', DEST_KEY: 'MetaData:Bogus' });
    applyTransforms([event('hello')], transformsDir('route'), conf, 'index-time', diags);
    expect(diags.some(unknownMsg)).toBe(true);
  });

  it('does not warn for a documented key', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('route', { REGEX: '(.*)', FORMAT: 'host::web01', DEST_KEY: 'MetaData:Host' });
    applyTransforms([event('hello')], transformsDir('route'), conf, 'index-time', diags);
    expect(diags.some(unknownMsg)).toBe(false);
  });

  it('emits an informational note for a valid-but-unsimulated routing key', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('route', { REGEX: '(.*)', FORMAT: 'my_group', DEST_KEY: '_TCP_ROUTING' });
    applyTransforms([event('hello')], transformsDir('route'), conf, 'index-time', diags);
    expect(diags.some((d) => d.level === 'info' && d.message.includes('not simulated'))).toBe(true);
    expect(diags.some(unknownMsg)).toBe(false);
  });
});

describe('applyTransforms — queue routing is last-wins (SEM-1)', () => {
  const conf = multiTransformsConf(
    stanza('setnull', { REGEX: '.', DEST_KEY: 'queue', FORMAT: 'nullQueue' }),
    stanza('setparsing', { REGEX: 'KEEP-ME', DEST_KEY: 'queue', FORMAT: 'indexQueue' }),
  );
  // The canonical "drop everything except X" pattern.
  const dir = transformsDir('setnull, setparsing');

  it('a later indexQueue overrides an earlier nullQueue for matching events', () => {
    const e = applyTransforms([event('KEEP-ME please')], dir, conf, 'index-time')[0]!;
    expect(e._meta._queue).toBe('indexQueue'); // survives — setparsing ran after setnull
  });

  it('events that do not match the later rule stay nullQueue', () => {
    const e = applyTransforms([event('drop this line')], dir, conf, 'index-time')[0]!;
    expect(e._meta._queue).toBe('nullQueue');
  });

  it('keeps (does not remove) nullQueue events so they can be shown as dropped', () => {
    const out = applyTransforms([event('drop this line')], dir, conf, 'index-time');
    expect(out).toHaveLength(1);
  });
});

describe('applyTransforms — classes applied in ASCII order (SEM-4)', () => {
  it('sorts TRANSFORMS-<class> by class name regardless of file order', () => {
    const conf = multiTransformsConf(
      stanza('setindex', { REGEX: '.', DEST_KEY: 'queue', FORMAT: 'indexQueue' }),
      stanza('setnull', { REGEX: '.', DEST_KEY: 'queue', FORMAT: 'nullQueue' }),
    );
    // File order puts class "z" before class "a"; ASCII order runs a then z, so
    // z's nullQueue is the last write and wins.
    const dirs = [classDir('z', 'setnull'), classDir('a', 'setindex')];
    const e = applyTransforms([event('anything')], dirs, conf, 'index-time')[0]!;
    expect(e._meta._queue).toBe('nullQueue');
  });
});

describe('applyTransforms — index-time extraction without WRITE_META (SEM-7)', () => {
  it('warns when an index-time transform extracts fields with no WRITE_META/DEST_KEY', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('grab', { REGEX: '(?<user>\\w+)' });
    applyTransforms([event('alice')], transformsDir('grab'), conf, 'index-time', diags);
    expect(diags.some((d) => d.message.includes('no effect'))).toBe(true);
  });

  it('does NOT warn when WRITE_META = true is set', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('grab', { REGEX: '(?<user>\\w+)', WRITE_META: 'true' });
    applyTransforms([event('alice')], transformsDir('grab'), conf, 'index-time', diags);
    expect(diags.some((d) => d.message.includes('no effect'))).toBe(false);
  });

  it('does NOT warn for the same extraction at search time (REPORT)', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('grab', { REGEX: '(?<user>\\w+)' });
    const reportDir: ConfDirective[] = [{ key: 'REPORT-x', value: 'grab', line: 1, directiveType: 'REPORT', className: 'x' }];
    applyTransforms([event('alice')], reportDir, conf, 'search-time', diags);
    expect(diags.some((d) => d.message.includes('no effect'))).toBe(false);
  });
});

describe('applyTransforms — INGEST_EVAL interleaving (SEM-2)', () => {
  it('runs an INGEST_EVAL stanza at its list position so a later regex sees the result', () => {
    const conf = multiTransformsConf(
      stanza('rewrite', { INGEST_EVAL: '_raw="HELLO"' }),
      stanza('extract', { REGEX: '(?<word>HELLO)' }),
    );
    // List order: eval rewrites _raw, then the regex extracts from the new _raw.
    const e = applyTransforms([event('original text')], transformsDir('rewrite, extract'), conf, 'index-time')[0]!;
    expect(e._raw).toBe('HELLO');
    expect(e.fields.word).toBe('HELLO');
  });

  it('does not run INGEST_EVAL on the search-time (REPORT) pass', () => {
    const conf = multiTransformsConf(stanza('rewrite', { INGEST_EVAL: '_raw="HELLO"' }));
    const reportDir: ConfDirective[] = [{ key: 'REPORT-x', value: 'rewrite', line: 1, directiveType: 'REPORT', className: 'x' }];
    const e = applyTransforms([event('original text')], reportDir, conf, 'search-time')[0]!;
    expect(e._raw).toBe('original text');
  });
});

describe('applyTransforms — DEST_KEY is index-time only (#57)', () => {
  const reportDir = (stanzaName: string): ConfDirective[] => [
    { key: 'REPORT-x', value: stanzaName, line: 1, directiveType: 'REPORT', className: 'x' },
  ];

  it('does not route a search-time REPORT to nullQueue', () => {
    const conf = transformsConf('drop', { REGEX: 'DEBUG', DEST_KEY: 'queue', FORMAT: 'nullQueue' });
    const out = applyTransforms([event('DEBUG something')], reportDir('drop'), conf, 'search-time')[0]!;
    expect(out._meta._queue).toBeUndefined();
  });

  it('does not rewrite metadata from a search-time REPORT', () => {
    const conf = transformsConf('force', {
      REGEX: '(.*)',
      DEST_KEY: 'MetaData:Sourcetype',
      FORMAT: 'sourcetype::other',
    });
    const out = applyTransforms([event('anything')], reportDir('force'), conf, 'search-time')[0]!;
    expect(out.metadata.sourcetype).toBe('st');
  });

  it('does not replace _raw from a search-time REPORT', () => {
    const conf = transformsConf('mask', { REGEX: '(\\w+)', DEST_KEY: '_raw', FORMAT: '$1' });
    const out = applyTransforms([event('keep all of this')], reportDir('mask'), conf, 'search-time')[0]!;
    expect(out._raw).toBe('keep all of this');
  });

  it('still performs the field extraction, and warns that the routing is ignored', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('r', {
      REGEX: 'user=(\\w+)',
      FORMAT: 'user::$1',
      DEST_KEY: 'queue',
    });
    const out = applyTransforms([event('user=alice')], reportDir('r'), conf, 'search-time', diags)[0]!;
    expect(out.fields.user).toBe('alice');
    expect(out._meta._queue).toBeUndefined();
    expect(diags.some((d) => d.message.includes('DEST_KEY is index-time only'))).toBe(true);
  });

  it('still routes at index time', () => {
    const conf = transformsConf('drop', { REGEX: 'DEBUG', DEST_KEY: 'queue', FORMAT: 'nullQueue' });
    const out = applyTransforms([event('DEBUG something')], transformsDir('drop'), conf, 'index-time')[0]!;
    expect(out._meta._queue).toBe('nullQueue');
  });
});

describe('applyTransforms — SOURCE_KEY reads pipeline metadata (#53)', () => {
  it('matches the canonical sourcetype-override transform', () => {
    const conf = transformsConf('force_sourcetype', {
      SOURCE_KEY: 'MetaData:Source',
      REGEX: 'source::s',
      DEST_KEY: 'MetaData:Sourcetype',
      FORMAT: 'sourcetype::forced',
    });
    const out = applyTransforms([event('anything')], transformsDir('force_sourcetype'), conf, 'index-time')[0]!;
    expect(out.metadata.sourcetype).toBe('forced');
  });

  it('reads MetaData:Host with its host:: prefix', () => {
    const conf = transformsConf('t', {
      SOURCE_KEY: 'MetaData:Host',
      REGEX: 'host::(\\w+)',
      FORMAT: 'captured_host::$1',
      WRITE_META: 'true',
    });
    const out = applyTransforms([event('x')], transformsDir('t'), conf, 'index-time')[0]!;
    expect(out.fields.captured_host).toBe('h');
  });

  // Doc-derived: the index key is written bare (`FORMAT = my_index`, #281), so
  // it reads back bare too — `index::main` here would be a value nothing wrote.
  it('reads MetaData:Index as the bare index name', () => {
    const conf = transformsConf('t', {
      SOURCE_KEY: '_MetaData:Index',
      REGEX: '^(\\w+)$',
      FORMAT: 'captured_index::$1',
      WRITE_META: 'true',
    });
    const ev = { ...event('x'), metadata: { ...event('x').metadata, index: 'main' } };
    const out = applyTransforms([ev], transformsDir('t'), conf, 'index-time')[0]!;
    expect(out.fields.captured_index).toBe('main');
  });

  it('reads an unrerouted queue as indexQueue', () => {
    const conf = transformsConf('t', {
      SOURCE_KEY: 'queue',
      REGEX: '(indexQueue)',
      FORMAT: 'q::$1',
      WRITE_META: 'true',
    });
    const out = applyTransforms([event('x')], transformsDir('t'), conf, 'index-time')[0]!;
    expect(out.fields.q).toBe('indexQueue');
  });

  it('reads _meta as space-separated key::value pairs', () => {
    const ev = { ...event('x'), _meta: { tier: 'gold' } };
    const conf = transformsConf('t', {
      SOURCE_KEY: '_meta',
      REGEX: 'tier::(\\w+)',
      FORMAT: 'tier_copy::$1',
      WRITE_META: 'true',
    });
    const out = applyTransforms([ev], transformsDir('t'), conf, 'index-time')[0]!;
    expect(out.fields.tier_copy).toBe('gold');
  });
});

describe('applyTransforms — search-time-only attributes reached index-time', () => {
  /** REPORT-<class>, so the same stanza can be driven down the search-time path. */
  function reportDir(stanzaName: string): ConfDirective[] {
    return [{ key: 'REPORT-x', value: stanzaName, line: 1, directiveType: 'REPORT', className: 'x' }];
  }

  const warnMsg = (d: ValidationDiagnostic) =>
    d.message.includes('valid only for search-time field extractions');

  it('warns when a DELIMS stanza is referenced by TRANSFORMS-', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('pairs', { DELIMS: '"|", "="' });
    applyTransforms([event('a=1|b=2')], transformsDir('pairs'), conf, 'index-time', diags);

    const warning = diags.find(warnMsg);
    expect(warning).toBeDefined();
    expect(warning?.level).toBe('warning');
    expect(warning?.message).toContain('DELIMS');
    // The consequence, not just the rule: this stanza produces nothing at all.
    expect(warning?.message).toContain('extracts nothing at all');
    expect(warning?.message).toContain('REPORT-<class>');
  });

  it('warns once per stanza however many events flow through', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('pairs', { DELIMS: '"|", "="' });
    applyTransforms(
      [event('a=1|b=2'), event('c=3|d=4'), event('e=5|f=6')],
      transformsDir('pairs'), conf, 'index-time', diags,
    );
    expect(diags.filter(warnMsg)).toHaveLength(1);
  });

  it('names every offending attribute, not just the first', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('kv', {
      REGEX: '(\\w+)=(\\w+)', FORMAT: '$1::$2', MV_ADD: 'true', CLEAN_KEYS: 'false',
    });
    applyTransforms([event('a=1')], transformsDir('kv'), conf, 'index-time', diags);

    const warning = diags.find(warnMsg);
    expect(warning?.message).toContain('MV_ADD');
    expect(warning?.message).toContain('CLEAN_KEYS');
    // No DELIMS here, so the stanza still extracts via REGEX.
    expect(warning?.message).not.toContain('extracts nothing at all');
  });

  it('stays quiet on the search-time pass, where the attributes are valid', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('pairs', { DELIMS: '"|", "="' });
    applyTransforms([event('a=1|b=2')], reportDir('pairs'), conf, 'search-time', diags);
    expect(diags.filter(warnMsg)).toHaveLength(0);
  });

  it('stays quiet for a stanza that uses none of them', () => {
    const diags: ValidationDiagnostic[] = [];
    const conf = transformsConf('route', { REGEX: '(\\w+)', DEST_KEY: 'MetaData:Index', FORMAT: 'main' });
    applyTransforms([event('hello')], transformsDir('route'), conf, 'index-time', diags);
    expect(diags.filter(warnMsg)).toHaveLength(0);
  });
});

const metadata = { index: 'main', host: 'h', source: 's', sourcetype: 'my_app' };

describe('#87 — CLONE_SOURCETYPE', () => {
  const props = '[my_app]\nTRANSFORMS-clone = cloner\n';
  const transforms = '[cloner]\nREGEX = user=(\\w+)\nCLONE_SOURCETYPE = my_app_masked\n';

  function run(raw: string, propsConf = props, transformsConf = transforms) {
    return runPipeline(raw, metadata, propsConf, transformsConf, {
      perEventPipeline: true,
      captureOffsets: false,
    }).result.events;
  }

  it('emits a copy carrying the new sourcetype', () => {
    const events = run('2024-01-15 user=alice\n');
    expect(events).toHaveLength(2);
    expect(events[0]?.metadata.sourcetype).toBe('my_app');
    expect(events[1]?.metadata.sourcetype).toBe('my_app_masked');
  });

  it('leaves the original untouched', () => {
    const events = run('2024-01-15 user=alice\n');
    expect(events[0]?._raw).toBe(events[1]?._raw);
    expect(events[0]?.clonedFrom).toBeUndefined();
  });

  it('links the pair, so a duplicate does not read as a breaking bug', () => {
    const events = run('2024-01-15 user=alice\n');
    expect(events[1]?.clonedFrom).toBe('my_app');
  });

  it('emits nothing when the REGEX does not match', () => {
    const events = run('2024-01-15 nothing here\n');
    expect(events).toHaveLength(1);
  });

  it('processes the clone under its new sourcetype stanza', () => {
    // The whole point of the clone: it re-enters the pipeline and picks up the
    // props of the sourcetype it was rewritten to.
    const events = run(
      '2024-01-15 user=alice\n',
      `${props}\n[my_app_masked]\nEXTRACT-masked = user=(?<masked_user>\\w+)\n`,
    );
    expect(events[1]?.fields['masked_user']).toBe('alice');
    expect(events[0]?.fields['masked_user']).toBeUndefined();
  });

  // Doc-derived (transforms.conf.spec, CLONE_SOURCETYPE): "The duplicated
  // events receive index-time transformations and sed commands for all
  // transforms that match its new host, source, or source type." (#282)
  describe('index-time processing of the clone (#282)', () => {
    const cloneProps =
      '[orig]\nTRANSFORMS-clone = do_clone\n\n[masked]\nSEDCMD-mask = s/\\d{4}-\\d{4}/XXXX-XXXX/g\n';
    const cloneTransforms = '[do_clone]\nREGEX = .\nCLONE_SOURCETYPE = masked\n';
    const runOrig = (p: string, t: string) =>
      runPipeline('card 1234-5678\n', { ...metadata, sourcetype: 'orig' }, p, t, {
        perEventPipeline: true,
        captureOffsets: false,
      });

    it("applies the new sourcetype's SEDCMD to the clone and not the original", () => {
      const events = runOrig(cloneProps, cloneTransforms).result.events;
      expect(events).toHaveLength(2);
      expect(events[0]?.metadata.sourcetype).toBe('orig');
      expect(events[0]?._raw).toBe('card 1234-5678');
      expect(events[1]?.metadata.sourcetype).toBe('masked');
      expect(events[1]?._raw).toBe('card XXXX-XXXX');
    });

    it("applies the new sourcetype's TRANSFORMS to the clone", () => {
      const events = runOrig(
        `${cloneProps}TRANSFORMS-route = to_secure\n`,
        `${cloneTransforms}\n[to_secure]\nREGEX = .\nDEST_KEY = _MetaData:Index\nFORMAT = secure\n`,
      ).result.events;
      expect(events[0]?.metadata.index).toBe('main');
      expect(events[1]?.metadata.index).toBe('secure');
    });

    it('stops, with a warning, when clones loop back to a sourcetype in their chain', () => {
      const { result, diagnostics } = runOrig(
        '[orig]\nTRANSFORMS-c = to_masked\n\n[masked]\nTRANSFORMS-c = to_orig\n',
        '[to_masked]\nREGEX = .\nCLONE_SOURCETYPE = masked\n\n[to_orig]\nREGEX = .\nCLONE_SOURCETYPE = orig\n',
      );
      // orig → masked (processed) → orig (cut: already in the chain).
      expect(result.events.map((e) => e.metadata.sourcetype)).toEqual(['orig', 'masked', 'orig']);
      expect(diagnostics.some((d) => d.message.includes('CLONE_SOURCETYPE loops back'))).toBe(true);
    });
  });

  it('records the clone in the original event trace', () => {
    const events = run('2024-01-15 user=alice\n');
    const step = events[1]?.processingTrace.find((s) => s.description.includes('CLONE_SOURCETYPE'));
    expect(step?.description).toContain('my_app_masked');
  });

  it('ignores CLONE_SOURCETYPE reached through a search-time REPORT', () => {
    // It is an index-time attribute; a REPORT- reference must not clone.
    const events = run('2024-01-15 user=alice\n', '[my_app]\nREPORT-clone = cloner\n');
    expect(events).toHaveLength(1);
  });
});
