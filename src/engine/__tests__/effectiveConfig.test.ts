// ---------------------------------------------------------------------------
// effectiveConfig.test.ts
// The stanza axis of provenance.
//
// The assertions that matter are the ones about what LOST: a panel that only
// showed winners would be a prettier view of what the preview already renders.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { parseConf } from '../parser/confParser';
import { matchStanzas } from '../parser/stanzaMatcher';
import { resolveEffectiveConfig, contestedDirectives } from '../parser/effectiveConfig';
import type { EventMetadata } from '../types';

const metadata: EventMetadata = {
  index: 'main',
  host: 'web01',
  source: '/var/log/app.log',
  sourcetype: 'my_app',
};

function effectiveFor(props: string, meta: EventMetadata = metadata) {
  const { stanzas } = parseConf(props, 'props.conf');
  return resolveEffectiveConfig(matchStanzas(stanzas, meta));
}

function byKey(props: string, key: string, meta: EventMetadata = metadata) {
  return effectiveFor(props, meta).find((d) => d.key === key);
}

describe('resolveEffectiveConfig — which stanza won', () => {
  it('names the stanza a directive came from', () => {
    const d = byKey('[my_app]\nTRUNCATE = 500\n', 'TRUNCATE');
    expect(d?.value).toBe('500');
    expect(d?.stanza.name).toBe('my_app');
    expect(d?.stanza.type).toBe('sourcetype');
  });

  it('points at the stanza header, so the editor can jump to it', () => {
    const d = byKey('[other]\nTRUNCATE = 1\n\n[my_app]\nTRUNCATE = 500\n', 'TRUNCATE');
    expect(d?.stanza.line).toBe(4);
    expect(d?.line).toBe(5);
  });

  it('gives source:: precedence over the sourcetype stanza, and says what it beat', () => {
    const d = byKey(
      '[my_app]\nTRUNCATE = 500\n\n[source::/var/log/app.log]\nTRUNCATE = 999\n',
      'TRUNCATE',
    );
    expect(d?.value).toBe('999');
    expect(d?.stanza.type).toBe('source');
    expect(d?.overriddenByStanza).toHaveLength(1);
    expect(d?.overriddenByStanza[0]?.name).toBe('my_app');
    expect(d?.overriddenByStanza[0]?.value).toBe('500');
  });

  it('records the losing directive line, not the losing stanza header line', () => {
    const d = byKey(
      '[my_app]\nSHOULD_LINEMERGE = true\nTRUNCATE = 500\n\n[source::/var/log/app.log]\nTRUNCATE = 999\n',
      'TRUNCATE',
    );
    expect(d?.overriddenByStanza[0]?.line).toBe(1); // stanza header
    expect(d?.overriddenByStanza[0]?.directiveLine).toBe(3); // the dead line itself
  });

  it('leaves an uncontested directive with an empty override list', () => {
    const d = byKey('[my_app]\nTRUNCATE = 500\n', 'TRUNCATE');
    expect(d?.overriddenByStanza).toEqual([]);
  });

  it('merges rather than replaces: a losing stanza still supplies its own keys', () => {
    const effective = effectiveFor(
      '[my_app]\nTRUNCATE = 500\nSHOULD_LINEMERGE = false\n\n[source::/var/log/app.log]\nTRUNCATE = 999\n',
    );
    expect(effective.find((d) => d.key === 'TRUNCATE')?.value).toBe('999');
    // SHOULD_LINEMERGE was not redefined, so the sourcetype stanza still supplies it.
    const merge = effective.find((d) => d.key === 'SHOULD_LINEMERGE');
    expect(merge?.value).toBe('false');
    expect(merge?.stanza.name).toBe('my_app');
  });

  it('applies last-definition-wins within a stanza before the contest', () => {
    const d = byKey('[my_app]\nTRUNCATE = 100\nTRUNCATE = 500\n', 'TRUNCATE');
    // The stanza competes with the value it would actually use.
    expect(d?.value).toBe('500');
    expect(d?.line).toBe(3);
  });

  it('collects every losing stanza, nearest rival first', () => {
    const d = byKey(
      [
        '[default]',
        'TRUNCATE = 1',
        '',
        '[my_app]',
        'TRUNCATE = 2',
        '',
        '[host::web01]',
        'TRUNCATE = 3',
        '',
        '[source::/var/log/app.log]',
        'TRUNCATE = 4',
      ].join('\n'),
      'TRUNCATE',
    );
    expect(d?.value).toBe('4');
    expect(d?.overriddenByStanza.map((o) => o.value)).toEqual(['3', '2', '1']);
  });

  it('orders results by stanza precedence, then by line', () => {
    const effective = effectiveFor(
      '[my_app]\nSHOULD_LINEMERGE = false\n\n[source::/var/log/app.log]\nTRUNCATE = 999\nMAX_EVENTS = 10\n',
    );
    // The winning source:: stanza's directives come first, in written order.
    expect(effective.map((d) => d.key)).toEqual(['TRUNCATE', 'MAX_EVENTS', 'SHOULD_LINEMERGE']);
  });

  it('returns nothing when no stanza matches the event', () => {
    expect(effectiveFor('[someone_else]\nTRUNCATE = 500\n')).toEqual([]);
  });
});

describe('resolveEffectiveConfig — both axes of provenance at once', () => {
  const layered = () => {
    const { stanzas } = parseConf(
      [
        { layer: 'default', text: '[my_app]\nTRUNCATE = 100\n' },
        { layer: 'local', text: '[my_app]\nTRUNCATE = 500\n' },
      ],
      'props.conf',
    );
    return resolveEffectiveConfig(matchStanzas(stanzas, metadata));
  };

  it('carries the layer the winning directive came from', () => {
    const d = layered().find((x) => x.key === 'TRUNCATE');
    expect(d?.value).toBe('500');
    expect(d?.layer).toBe('local');
  });

  it('keeps the within-stanza override it already beat', () => {
    const d = layered().find((x) => x.key === 'TRUNCATE');
    expect(d?.overrides?.[0]?.value).toBe('100');
    expect(d?.overrides?.[0]?.layer).toBe('default');
  });

  it('separates the layer contest from the stanza contest', () => {
    // Winning in `local/` inside a stanza that loses to `source::` is the case
    // the two axes exist to tell apart.
    const { stanzas } = parseConf(
      [
        { layer: 'default', text: '[my_app]\nTRUNCATE = 100\n' },
        { layer: 'local', text: '[my_app]\nTRUNCATE = 500\n\n[source::/var/log/app.log]\nTRUNCATE = 999\n' },
      ],
      'props.conf',
    );
    const d = resolveEffectiveConfig(matchStanzas(stanzas, metadata)).find((x) => x.key === 'TRUNCATE');

    expect(d?.value).toBe('999');
    expect(d?.stanza.type).toBe('source');
    // The `local` value that won its own stanza and still does not apply.
    expect(d?.overriddenByStanza[0]?.value).toBe('500');
    expect(d?.overriddenByStanza[0]?.layer).toBe('local');
  });
});

describe('contestedDirectives', () => {
  it('keeps only the keys more than one matching stanza defines', () => {
    const effective = effectiveFor(
      '[my_app]\nTRUNCATE = 500\nSHOULD_LINEMERGE = false\n\n[source::/var/log/app.log]\nTRUNCATE = 999\n',
    );
    expect(contestedDirectives(effective).map((d) => d.key)).toEqual(['TRUNCATE']);
  });

  it('is empty when nothing is contested', () => {
    expect(contestedDirectives(effectiveFor('[my_app]\nTRUNCATE = 500\n'))).toEqual([]);
  });
});
