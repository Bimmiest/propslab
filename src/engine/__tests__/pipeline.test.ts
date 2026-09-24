import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import type { EventMetadata, ValidationDiagnostic } from '../types';

const META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'aws:cloudtrail' };
const JSON_RAW = '{"eventTime":"2024-01-15T10:00:00Z","action":"login","user":"alice"}';

const hasDupWarning = (diags: { message: string }[]) =>
  diags.some((d) => d.message.includes('duplicate (multivalue) field values'));

describe('runPipeline — INDEXED_EXTRACTIONS + KV_MODE duplicate-extraction warning', () => {
  it('warns when INDEXED_EXTRACTIONS=json and KV_MODE=json are both set', () => {
    const props = '[aws:cloudtrail]\nINDEXED_EXTRACTIONS = json\nKV_MODE = json';
    const { diagnostics } = runPipeline(JSON_RAW, META, props, '');
    expect(hasDupWarning(diagnostics)).toBe(true);
  });

  it('warns when INDEXED_EXTRACTIONS=json and KV_MODE is unset (default auto re-extracts JSON)', () => {
    const props = '[aws:cloudtrail]\nINDEXED_EXTRACTIONS = json';
    const { diagnostics } = runPipeline(JSON_RAW, META, props, '');
    expect(hasDupWarning(diagnostics)).toBe(true);
  });

  it('does NOT warn when KV_MODE = none is set alongside INDEXED_EXTRACTIONS=json', () => {
    const props = '[aws:cloudtrail]\nINDEXED_EXTRACTIONS = json\nKV_MODE = none';
    const { diagnostics } = runPipeline(JSON_RAW, META, props, '');
    expect(hasDupWarning(diagnostics)).toBe(false);
  });

  it('does NOT warn when AUTO_KV_JSON = false disables the search-time JSON re-extraction', () => {
    const props = '[aws:cloudtrail]\nINDEXED_EXTRACTIONS = json\nAUTO_KV_JSON = false';
    const { diagnostics } = runPipeline(JSON_RAW, META, props, '');
    expect(hasDupWarning(diagnostics)).toBe(false);
  });

  it('does NOT warn for delimited INDEXED_EXTRACTIONS (no search-time duplication)', () => {
    const csv = 'ts,action,user\n2024-01-15,login,alice';
    const props = '[csv:st]\nINDEXED_EXTRACTIONS = csv\nKV_MODE = json';
    const { diagnostics } = runPipeline(csv, { ...META, sourcetype: 'csv:st' }, props, '');
    expect(hasDupWarning(diagnostics)).toBe(false);
  });
});

describe('runPipeline — DEST_KEY validation (SEM-11)', () => {
  const PLAIN_META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'st' };
  const props = '[st]\nTRANSFORMS-t = route';

  it('warns when DEST_KEY is not a recognised routing key', () => {
    const transforms = '[route]\nREGEX = (.*)\nDEST_KEY = made_up_key\nFORMAT = $1';
    const { diagnostics } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(diagnostics.some((d) => d.message.includes('not a recognised Splunk DEST_KEY'))).toBe(true);
  });

  it('warns that _TCP_ROUTING is valid but not simulated', () => {
    const transforms = '[route]\nREGEX = (.*)\nDEST_KEY = _TCP_ROUTING\nFORMAT = group1';
    const { diagnostics } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(diagnostics.some((d) => d.message.includes('not simulated'))).toBe(true);
  });

  it('does NOT warn for a documented key like queue', () => {
    const transforms = '[route]\nREGEX = (.*)\nDEST_KEY = queue\nFORMAT = indexQueue';
    const { diagnostics } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(diagnostics.some((d) => d.message.includes('DEST_KEY'))).toBe(false);
  });
});

// Doc-derived (transforms.conf.spec, DEST_KEY / FORMAT): `_MetaData:Index`
// takes the bare index name, and only Host/Source/Sourcetype need a
// `<name>::` prefix. This lint previously demanded `index::` and told users
// to add it — the opposite of the spec (#281).
describe('runPipeline — DEST_KEY = MetaData:Index FORMAT lint (#281)', () => {
  const PLAIN_META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'st' };
  const props = '[st]\nTRANSFORMS-t = route';
  const prefixWarning = (diags: ValidationDiagnostic[]) =>
    diags.filter((d) => d.message.includes('prefix'));

  it('accepts the bare index name and routes to it', () => {
    const transforms = '[route]\nREGEX = .\nDEST_KEY = _MetaData:Index\nFORMAT = security';
    const { result, diagnostics } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(prefixWarning(diagnostics)).toHaveLength(0);
    expect(result.events[0]?.metadata.index).toBe('security');
  });

  it('warns that an index:: prefix is kept, naming the index it really routes to', () => {
    const transforms = '[route]\nREGEX = .\nDEST_KEY = _MetaData:Index\nFORMAT = index::security';
    const { result, diagnostics } = runPipeline('a log line', PLAIN_META, props, transforms);
    const warning = prefixWarning(diagnostics);
    expect(warning).toHaveLength(1);
    expect(warning[0]?.message).toContain('"index::security"');
    expect(warning[0]?.suggestion).toBe('Change FORMAT = index::security to FORMAT = security');
    expect(result.events[0]?.metadata.index).toBe('index::security');
  });

  it('lints the effective (last) FORMAT when default/ and local/ both set it', () => {
    const route = (format: string) => `[route]\nREGEX = .\nDEST_KEY = MetaData:Sourcetype\nFORMAT = ${format}`;
    // local fixes what default got wrong: no warning, because runtime uses local's.
    const fixed = runPipeline('a log line', PLAIN_META, props, [
      { layer: 'default', text: route('other') },
      { layer: 'local', text: route('sourcetype::other') },
    ]);
    expect(prefixWarning(fixed.diagnostics)).toHaveLength(0);
    // And the reverse: local breaks it, so the warning must point at local's line.
    const broken = runPipeline('a log line', PLAIN_META, props, [
      { layer: 'default', text: route('sourcetype::other') },
      { layer: 'local', text: route('other') },
    ]);
    const warning = prefixWarning(broken.diagnostics);
    expect(warning).toHaveLength(1);
    expect(warning[0]?.layer).toBe('local');
  });
});

describe('runPipeline — INGEST_EVAL is scoped to referencing stanzas (SEM-2)', () => {
  const PLAIN_META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'st' };

  it('does NOT apply an INGEST_EVAL stanza that no props.conf stanza references', () => {
    const props = '[st]\n'; // no TRANSFORMS reference to the eval stanza
    const transforms = '[addtag]\nINGEST_EVAL = tag="prod"';
    const { result } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(result.events[0]!.fields.tag).toBeUndefined();
  });

  it('applies an INGEST_EVAL stanza when a TRANSFORMS-<class> references it', () => {
    const props = '[st]\nTRANSFORMS-t = addtag';
    const transforms = '[addtag]\nINGEST_EVAL = tag="prod"';
    const { result } = runPipeline('a log line', PLAIN_META, props, transforms);
    expect(result.events[0]!.fields.tag).toBe('prod');
  });
});

describe('runPipeline — 1 MB input cap aligns to a line boundary (#14)', () => {
  const LINE = 'x'.repeat(99) + '\n'; // 100 chars per line
  // One event per line, so a mid-line cut would be visible as a short event.
  const NO_MERGE = '[aws:cloudtrail]\nSHOULD_LINEMERGE = false';

  it('does not hand the pipeline a half-formed final event', () => {
    // 10,001 lines = 1,000,100 chars, so the cap lands 100 chars into the last line.
    const raw = LINE.repeat(10_001);
    const { result, diagnostics } = runPipeline(raw, META, NO_MERGE, '');
    expect(diagnostics.some((d) => d.message.includes('truncated'))).toBe(true);
    // Every surviving event is a whole line, not a fragment.
    expect(result.events.every((e) => e._raw === 'x'.repeat(99))).toBe(true);
  });

  it('keeps input under the cap intact', () => {
    const raw = LINE.repeat(10);
    const { result, diagnostics } = runPipeline(raw, META, NO_MERGE, '');
    expect(diagnostics.some((d) => d.message.includes('truncated'))).toBe(false);
    expect(result.events).toHaveLength(10);
  });
});

describe('runPipeline — per-event mode does not duplicate config diagnostics (#13)', () => {
  // An unreferenced transform stanza is a config-level warning: it describes the
  // configuration, not any one event, so it must be reported once however many
  // events are processed.
  const RAW = Array.from({ length: 25 }, (_, i) => `2024-01-15T10:00:0${i % 10}Z line ${i}`).join('\n');
  const PROPS = '[aws:cloudtrail]\nSHOULD_LINEMERGE = false\nKV_MODE = auto\nEVAL-broken = this is (not valid';

  const brokenEvalCount = (diags: { message: string }[]) =>
    diags.filter((d) => d.message.includes('EVAL-broken')).length;

  it('reports a config-level eval error once in per-event mode', () => {
    const { result, diagnostics } = runPipeline(RAW, META, PROPS, '', { perEventPipeline: true });
    expect(result.events.length).toBeGreaterThan(1);
    expect(brokenEvalCount(diagnostics)).toBe(1);
  });

  it('matches the batch path, which already reported it once', () => {
    const { diagnostics } = runPipeline(RAW, META, PROPS, '');
    expect(brokenEvalCount(diagnostics)).toBe(1);
  });
});

describe('runPipeline — search-time REPORT compile failures are reported (#75.1)', () => {
  const PROPS = '[aws:cloudtrail]\nREPORT-r = broken';
  const TRANSFORMS = '[broken]\nREGEX = (a+)+\nFORMAT = f::$1';

  it('warns when a REPORT stanza regex cannot be compiled', () => {
    const { diagnostics } = runPipeline('some line', META, PROPS, TRANSFORMS);
    expect(diagnostics.some((d) => d.message.includes('could not be compiled safely'))).toBe(true);
  });

  it('warns once, not once per event, in per-event mode', () => {
    const raw = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n');
    const props = '[aws:cloudtrail]\nSHOULD_LINEMERGE = false\nREPORT-r = broken';
    const { diagnostics } = runPipeline(raw, META, props, TRANSFORMS, { perEventPipeline: true });
    expect(diagnostics.filter((d) => d.message.includes('could not be compiled safely'))).toHaveLength(1);
  });
});

describe('runPipeline — an input-time sourcetype assignment is not an index-time rewrite (#310)', () => {
  // Doc-derived: props.conf.spec describes `sourcetype = <string>` in a
  // [source::] stanza as assigning the sourcetype at input time, before any
  // TRANSFORMS run — so it must not be reported as a DEST_KEY = MetaData:*
  // rewrite, and per-event mode has nothing to re-match.
  const meta: EventMetadata = { index: 'main', host: 'h', source: '/a.log', sourcetype: 'st' };
  const props = '[source::/a.log]\nsourcetype = foo\n\n[foo]\nSHOULD_LINEMERGE = false\nEXTRACT-k = k=(?<k>\\w+)\n';
  const raw = 'k=one\nk=two\n';
  const rewriteWarning = (diags: ValidationDiagnostic[]) =>
    diags.some((d) => d.message.includes('rewritten by a DEST_KEY = MetaData:* transform'));

  it('batch mode does not warn about a metadata rewrite', () => {
    const { result, diagnostics } = runPipeline(raw, meta, props, '', { perEventPipeline: false });
    expect(rewriteWarning(diagnostics)).toBe(false);
    expect(result.events.map((e) => e.fields.k)).toEqual(['one', 'two']);
  });

  it('per-event mode adds no StanzaRematch step and keeps the assigned sourcetype\'s search-time config', () => {
    const { result } = runPipeline(raw, meta, props, '', { perEventPipeline: true });
    expect(result.processingSteps.some((s) => s.processor === 'StanzaRematch')).toBe(false);
    expect(result.events.map((e) => e.fields.k)).toEqual(['one', 'two']);
  });

  it('still reports a genuine DEST_KEY = MetaData:Sourcetype rewrite on top of the assignment', () => {
    const rewriting = props + 'TRANSFORMS-st = to_bar\n';
    const transforms = '[to_bar]\nREGEX = two\nDEST_KEY = MetaData:Sourcetype\nFORMAT = sourcetype::bar\n';
    const batch = runPipeline(raw, meta, rewriting, transforms, { perEventPipeline: false });
    expect(rewriteWarning(batch.diagnostics)).toBe(true);
    const perEvent = runPipeline(raw, meta, rewriting, transforms, { perEventPipeline: true });
    expect(perEvent.result.events.map((e) => e.processingTrace.some((s) => s.processor === 'StanzaRematch'))).toEqual([
      false,
      true,
    ]);
  });
});
