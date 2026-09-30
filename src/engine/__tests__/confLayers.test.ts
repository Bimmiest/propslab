import { describe, it, expect } from 'vitest';
import { parseConf } from '../parser/confParser';
import { getDirectiveValue, matchStanzas, mergeDirectives } from '../parser/stanzaMatcher';
import { runPipeline } from '../pipeline';
import type { ConfStanza, EventMetadata } from '../types';

const META: EventMetadata = { index: 'main', host: '', source: '', sourcetype: 'st' };

const stanza = (parsed: { stanzas: ConfStanza[] }, name: string) =>
  parsed.stanzas.find((s) => s.name === name)!;

const directive = (parsed: { stanzas: ConfStanza[] }, name: string, key: string) =>
  stanza(parsed, name).directives.filter((d) => d.key === key);

/** The value the engine would actually apply for `key` on an event matching META. */
const resolved = (parsed: { stanzas: ConfStanza[] }, key: string) =>
  mergeDirectives(matchStanzas(parsed.stanzas, META)).find((d) => d.key === key);

describe('parseConf — layered input is opt-in and additive (#115)', () => {
  it('adds no provenance fields when given a plain string', () => {
    const parsed = parseConf('[st]\nKV_MODE = json\nKV_MODE = none', 'props.conf');
    const s = stanza(parsed, 'st');
    expect('layer' in s).toBe(false);
    expect('layers' in s).toBe(false);
    for (const d of s.directives) {
      expect('layer' in d).toBe(false);
      expect('overrides' in d).toBe(false);
      expect('overriddenBy' in d).toBe(false);
    }
  });

  it('resolves a single layer exactly as the same text passed flat', () => {
    const text = '[st]\nKV_MODE = json\nSHOULD_LINEMERGE = false\n[source::/var/log/x]\nTZ = UTC';
    const flat = parseConf(text, 'props.conf');
    const layered = parseConf([{ layer: 'default', text }], 'props.conf');

    const shape = (p: { stanzas: ConfStanza[] }) =>
      p.stanzas.map((s) => ({
        name: s.name,
        type: s.type,
        lineRange: s.lineRange,
        directives: s.directives.map((d) => ({ key: d.key, value: d.value, line: d.line })),
      }));
    expect(shape(layered)).toEqual(shape(flat));
    expect(layered.errors.map((e) => e.message)).toEqual(flat.errors.map((e) => e.message));
  });

  it('stamps the layer name on every stanza and directive', () => {
    const parsed = parseConf([{ layer: 'default', text: '[st]\nKV_MODE = json' }], 'props.conf');
    expect(stanza(parsed, 'st').layer).toBe('default');
    expect(directive(parsed, 'st', 'KV_MODE')[0]!.layer).toBe('default');
  });

  it('accepts an empty layer list', () => {
    expect(parseConf([], 'props.conf')).toEqual({ stanzas: [], errors: [] });
  });
});

describe('parseConf — default/ and local/ merge per attribute (#115)', () => {
  const layers = [
    { layer: 'default', text: '[st]\nKV_MODE = json\nTZ = UTC\nSHOULD_LINEMERGE = false' },
    { layer: 'local', text: '[st]\nKV_MODE = none' },
  ];

  it('lets the higher layer win the attribute it redefines', () => {
    const parsed = parseConf(layers, 'props.conf');
    const winner = resolved(parsed, 'KV_MODE')!;
    expect(winner.value).toBe('none');
    expect(winner.layer).toBe('local');
  });

  it('leaves the attributes the higher layer does not name alone', () => {
    const parsed = parseConf(layers, 'props.conf');
    expect(resolved(parsed, 'TZ')!.value).toBe('UTC');
    expect(resolved(parsed, 'TZ')!.layer).toBe('default');
    expect(resolved(parsed, 'SHOULD_LINEMERGE')!.layer).toBe('default');
  });

  it('keeps the overridden definition in the stanza rather than discarding it', () => {
    const parsed = parseConf(layers, 'props.conf');
    const kvModes = directive(parsed, 'st', 'KV_MODE');
    expect(kvModes.map((d) => [d.layer, d.value])).toEqual([
      ['default', 'json'],
      ['local', 'none'],
    ]);
  });

  it('records what the winner overrode, and what the loser lost to', () => {
    const parsed = parseConf(layers, 'props.conf');
    const kvModes = directive(parsed, 'st', 'KV_MODE');
    const loser = kvModes[0]!;
    const winner = kvModes[1]!;

    expect(winner.overrides).toEqual([{ layer: 'default', line: 2, value: 'json' }]);
    expect(winner.overriddenBy).toBeUndefined();
    expect(loser.overriddenBy).toEqual({ layer: 'local', line: 2, value: 'none' });
    expect(loser.overrides).toBeUndefined();
  });

  it('leaves an uncontested directive unannotated', () => {
    const parsed = parseConf(layers, 'props.conf');
    const tz = directive(parsed, 'st', 'TZ')[0]!;
    expect(tz.overrides).toBeUndefined();
    expect(tz.overriddenBy).toBeUndefined();
  });

  it('orders overrides nearest-first across three layers', () => {
    const parsed = parseConf(
      [
        { layer: 'system/default', text: '[st]\nTRUNCATE = 10000' },
        { layer: 'app/default', text: '[st]\nTRUNCATE = 20000' },
        { layer: 'app/local', text: '[st]\nTRUNCATE = 30000' },
      ],
      'props.conf',
    );
    const winner = resolved(parsed, 'TRUNCATE')!;
    expect([winner.layer, winner.value]).toEqual(['app/local', '30000']);
    // overrides[0] is what applies if the winning line is deleted.
    expect(winner.overrides!.map((o) => [o.layer, o.value])).toEqual([
      ['app/default', '20000'],
      ['system/default', '10000'],
    ]);
  });

  it('treats a repeat within one layer by the same rule as a cross-layer override', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nTZ = UTC\nTZ = GMT' }, { layer: 'local', text: '[st]\nTZ = EST' }],
      'props.conf',
    );
    const winner = resolved(parsed, 'TZ')!;
    expect(winner.value).toBe('EST');
    expect(winner.overrides!.map((o) => [o.layer, o.line, o.value])).toEqual([
      ['default', 3, 'GMT'],
      ['default', 2, 'UTC'],
    ]);
  });

  it('overrides class directives (EXTRACT-<class>) by their full key', () => {
    const parsed = parseConf(
      [
        { layer: 'default', text: '[st]\nEXTRACT-user = user=(?<user>\\w+)\nEXTRACT-id = id=(?<id>\\d+)' },
        { layer: 'local', text: '[st]\nEXTRACT-user = usr=(?<user>\\w+)' },
      ],
      'props.conf',
    );
    const merged = mergeDirectives(matchStanzas(parsed.stanzas, META));
    expect(merged.find((d) => d.key === 'EXTRACT-user')!.value).toBe('usr=(?<user>\\w+)');
    // A different class is a different attribute — it is not replaced.
    expect(merged.find((d) => d.key === 'EXTRACT-id')!.layer).toBe('default');
  });

  it('does not let a mis-cased attribute override the correctly-cased one', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nKV_MODE = json' }, { layer: 'local', text: '[st]\nkv_mode = none' }],
      'props.conf',
    );
    // Splunk ignores `kv_mode` outright, so it cannot shadow KV_MODE.
    expect(resolved(parsed, 'KV_MODE')!.value).toBe('json');
    expect(directive(parsed, 'st', 'KV_MODE')[0]!.overriddenBy).toBeUndefined();
  });

  it('does not merge across stanza names or stanza types', () => {
    const parsed = parseConf(
      [
        { layer: 'default', text: '[st]\nTZ = UTC' },
        { layer: 'local', text: '[other]\nTZ = EST\n[source::st]\nTZ = PST' },
      ],
      'props.conf',
    );
    expect(directive(parsed, 'st', 'TZ')).toHaveLength(1);
    expect(directive(parsed, 'st', 'TZ')[0]!.value).toBe('UTC');
  });
});

describe('parseConf — stanza-level layer origins (#115)', () => {
  it('records every layer that defines a stanza, lowest precedence first', () => {
    const parsed = parseConf(
      [
        { layer: 'default', text: '# header\n[st]\nTZ = UTC' },
        { layer: 'local', text: '[st]\nKV_MODE = none\nTZ = EST' },
      ],
      'props.conf',
    );
    expect(stanza(parsed, 'st').layers).toEqual([
      { layer: 'default', lineRange: { start: 2, end: 3 } },
      { layer: 'local', lineRange: { start: 1, end: 3 } },
    ]);
  });

  it('points lineRange at the highest-precedence layer rather than spanning both', () => {
    const parsed = parseConf(
      [
        { layer: 'default', text: '[st]\nTZ = UTC\nKV_MODE = json\nTRUNCATE = 500' },
        { layer: 'local', text: '[st]\nTZ = EST' },
      ],
      'props.conf',
    );
    const s = stanza(parsed, 'st');
    expect(s.layer).toBe('local');
    expect(s.lineRange).toEqual({ start: 1, end: 2 });
  });

  it('merges a stanza repeated within one layer into that layer’s single range', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nTZ = UTC\n\n[st]\nKV_MODE = json' }],
      'props.conf',
    );
    const s = stanza(parsed, 'st');
    expect(s.layers).toEqual([{ layer: 'default', lineRange: { start: 1, end: 5 } }]);
    expect(s.directives.map((d) => d.key)).toEqual(['TZ', 'KV_MODE']);
  });

  it('carries a stanza that exists in only one layer through unchanged', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[only_default]\nTZ = UTC' }, { layer: 'local', text: '[only_local]\nTZ = EST' }],
      'props.conf',
    );
    expect(stanza(parsed, 'only_default').layer).toBe('default');
    expect(stanza(parsed, 'only_local').layer).toBe('local');
    expect(parsed.stanzas).toHaveLength(2);
  });
});

describe('parseConf — diagnostics name their layer (#115)', () => {
  it('attaches the layer to a parse warning so line numbers stay unambiguous', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nKV_MODE = json' }, { layer: 'local', text: '[st]\nkv_mode = none' }],
      'props.conf',
    );
    const warning = parsed.errors.find((e) => e.directiveKey === 'kv_mode')!;
    expect(warning.layer).toBe('local');
    expect(warning.line).toBe(2);
  });

  it('attaches the layer to a malformed-line error', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nTZ = UTC' }, { layer: 'local', text: '[st]\n; not a comment' }],
      'props.conf',
    );
    const error = parsed.errors.find((e) => e.message.includes('Malformed'))!;
    expect(error.layer).toBe('local');
    expect(error.line).toBe(2);
  });

  it('omits the layer key entirely for a flat parse', () => {
    const parsed = parseConf('[st]\nkv_mode = none', 'props.conf');
    expect('layer' in parsed.errors[0]!).toBe(false);
  });
});

describe('runPipeline — accepts layered confs (#115)', () => {
  const RAW = 'user=alice action=login';

  it('applies the local override end-to-end', () => {
    const { result } = runPipeline(
      RAW,
      META,
      [
        { layer: 'default', text: '[st]\nKV_MODE = none' },
        { layer: 'local', text: '[st]\nKV_MODE = auto' },
      ],
      '',
    );
    expect(result.events[0]!.fields['user']).toBe('alice');
  });

  it('applies the default when local does not redefine the attribute', () => {
    const { result } = runPipeline(
      RAW,
      META,
      [
        { layer: 'default', text: '[st]\nKV_MODE = none' },
        { layer: 'local', text: '[st]\nTZ = UTC' },
      ],
      '',
    );
    expect(result.events[0]!.fields['user']).toBeUndefined();
  });

  it('reports which layer a config diagnostic came from', () => {
    const { diagnostics } = runPipeline(
      RAW,
      META,
      [
        { layer: 'default', text: '[st]\nTZ = UTC' },
        { layer: 'local', text: '[st]\nTRANSFORMS-x = nope' },
      ],
      '',
    );
    const missing = diagnostics.find((d) => d.message.includes('not found in transforms.conf'))!;
    expect(missing.layer).toBe('local');
    expect(missing.line).toBe(2);
  });

  it('resolves layered transforms.conf too', () => {
    const { result } = runPipeline(
      RAW,
      META,
      // KV_MODE = none so the only extraction in play is the REPORT.
      '[st]\nKV_MODE = none\nREPORT-x = extract_user',
      [
        { layer: 'default', text: '[extract_user]\nREGEX = user=(?<user>\\w+)' },
        { layer: 'local', text: '[extract_user]\nREGEX = action=(?<action>\\w+)' },
      ],
    );
    // local replaces the REGEX attribute outright, so only `action` extracts.
    expect(result.events[0]!.fields['action']).toBe('login');
    expect(result.events[0]!.fields['user']).toBeUndefined();
  });

  it('still accepts plain strings', () => {
    const { result } = runPipeline(RAW, META, '[st]\nKV_MODE = auto', '');
    expect(result.events[0]!.fields['user']).toBe('alice');
  });
});

describe('getDirectiveValue — last definition in a stanza wins (#115)', () => {
  it('returns the higher layer’s value, not the one it overrode', () => {
    const parsed = parseConf(
      [{ layer: 'default', text: '[st]\nTZ = UTC' }, { layer: 'local', text: '[st]\nTZ = EST' }],
      'props.conf',
    );
    expect(getDirectiveValue(matchStanzas(parsed.stanzas, META), 'TZ')).toBe('EST');
  });

  it('returns the last of a key repeated within one flat file', () => {
    const parsed = parseConf('[st]\nTZ = UTC\nTZ = GMT', 'props.conf');
    expect(getDirectiveValue(matchStanzas(parsed.stanzas, META), 'TZ')).toBe('GMT');
  });

  it('still prefers a higher-precedence stanza over a lower one', () => {
    const parsed = parseConf('[default]\nTZ = GMT\n[st]\nTZ = UTC', 'props.conf');
    expect(getDirectiveValue(matchStanzas(parsed.stanzas, META), 'TZ')).toBe('UTC');
  });
});
