// ---------------------------------------------------------------------------
// stanzaLevelDirectives.test.ts
// The four props.conf directives that act on the stanza rather than on the
// event: `disabled`, `priority`, `sourcetype` and `rename`.
//
// Three of the four can change WHICH stanza applies, so getting one wrong
// changes every downstream result rather than one field — which is why they are
// tested here against the whole pipeline rather than against matchStanzas
// alone.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { runPipeline } from '../pipeline';
import { matchStanzas } from '../parser/stanzaMatcher';
import { parseConf } from '../parser/confParser';
import type { EventMetadata } from '../types';

const metadata: EventMetadata = {
  index: 'main',
  host: 'web01',
  source: '/var/log/app.log',
  sourcetype: 'original',
};

function run(props: string, meta: Partial<EventMetadata> = {}) {
  return runPipeline('2026-01-15T10:00:00Z user=alice\n', { ...metadata, ...meta }, props, '', {
    perEventPipeline: false,
    captureOffsets: false,
  });
}

/** Stanza names that survive matching, in precedence order. */
function matchedNames(props: string, meta: Partial<EventMetadata> = {}): string[] {
  const conf = parseConf(props, 'props.conf');
  return matchStanzas(conf.stanzas, { ...metadata, ...meta }).map((s) => s.name);
}

describe('disabled — a stanza switched off takes no part in resolution', () => {
  it('does not apply a disabled stanza', () => {
    const { result } = run('[original]\ndisabled = 1\nEVAL-tag = "applied"\n');
    expect(result.events[0]!.fields['tag']).toBeUndefined();
  });

  it('applies the same stanza when it is not disabled', () => {
    const { result } = run('[original]\nEVAL-tag = "applied"\n');
    expect(result.events[0]!.fields['tag']).toBe('applied');
  });

  it('accepts every boolean spelling Splunk does', () => {
    for (const v of ['1', 'true', 'TRUE', 't', 'yes', 'on']) {
      expect(matchedNames(`[original]\ndisabled = ${v}\n`), `for ${v}`).toEqual([]);
    }
    for (const v of ['0', 'false', 'f', 'no', 'off', '']) {
      expect(matchedNames(`[original]\ndisabled = ${v}\n`), `for ${v}`).toEqual(['original']);
    }
  });

  it('lets a lower-precedence stanza win when the higher one is disabled', () => {
    const { result } = run(
      '[source::/var/log/app.log]\ndisabled = 1\nEVAL-who = "source"\n\n' +
        '[original]\nEVAL-who = "sourcetype"\n',
    );
    expect(result.events[0]!.fields['who']).toBe('sourcetype');
  });

  it('takes the last definition, so a re-enable after a disable wins', () => {
    // Which is what a `local/` layer re-enabling a `default/` stanza produces
    // once the layers are concatenated.
    expect(matchedNames('[original]\ndisabled = 1\ndisabled = 0\n')).toEqual(['original']);
  });
});

describe('priority — orders stanzas within a kind, and cannot reach across kinds (#198)', () => {
  it('leaves the usual ranking alone when nothing declares a priority', () => {
    const names = matchedNames(
      '[original]\nEVAL-a = 1\n\n[host::web01]\nEVAL-b = 1\n\n[source::/var/log/app.log]\nEVAL-c = 1\n',
    );
    expect(names).toEqual(['source::/var/log/app.log', 'host::web01', 'original']);
  });

  it('does not let any priority lift a sourcetype stanza above a source stanza', () => {
    // "the priority key does *not* affect precedence across <spec> types …
    // [source::<source>] patterns take priority over stanzas with [host::<host>]
    // and [<sourcetype>] patterns, regardless of their respective priority key
    // values." 200 is far above every default and still loses.
    const { result } = run(
      '[source::/var/log/app.log]\nEVAL-who = "source"\n\n' +
        '[original]\npriority = 200\nEVAL-who = "sourcetype"\n',
    );
    expect(result.events[0]!.fields['who']).toBe('source');
  });

  it('does not let a priority lift a host stanza above a source stanza either', () => {
    const names = matchedNames(
      '[host::web01]\npriority = 500\nEVAL-a = 1\n\n[source::/var/log/app.log]\nEVAL-b = 1\n',
    );
    expect(names[0]).toBe('source::/var/log/app.log');
  });

  it('orders two stanzas of the same kind by priority', () => {
    // Both are source:: stanzas, so priority is free to decide. Without it the
    // more specific pattern would win, which makes this a real inversion.
    const names = matchedNames(
      '[source::/var/log/app.log]\nEVAL-a = 1\n\n[source::...log...]\npriority = 500\nEVAL-b = 1\n',
    );
    expect(names[0]).toBe('source::...log...');
  });

  it('defaults a literal stanza to 100 and a wildcard stanza of the same kind to 0', () => {
    // Nothing declares a priority, and both patterns match. The literal one wins
    // on its default alone — the wildcard would need to declare above 100.
    const names = matchedNames(
      '[source::...app...]\nEVAL-a = 1\n\n[source::/var/log/app.log]\nEVAL-b = 1\n',
    );
    expect(names[0]).toBe('source::/var/log/app.log');
  });

  it('lets a wildcard stanza declare its way past a literal one of the same kind', () => {
    // The spec's own corollary: "Setting the priority key to a value greater
    // than 100 causes the pattern-matched stanzas to override the values of the
    // literal-matching stanzas." 101 is enough; 99 would not be.
    const names = matchedNames(
      '[source::...app...]\npriority = 101\nEVAL-a = 1\n\n[source::/var/log/app.log]\nEVAL-b = 1\n',
    );
    expect(names[0]).toBe('source::...app...');
  });

  it('ignores a malformed priority rather than reading it as zero', () => {
    // Zero would demote this literal stanza below any wildcard sibling that
    // declared one, when the intent was plainly to leave the default in place.
    const names = matchedNames(
      '[source::/var/log/app.log]\npriority = urgent\nEVAL-a = 1\n\n' +
        '[source::...log...]\npriority = 50\nEVAL-b = 1\n',
    );
    expect(names[0]).toBe('source::/var/log/app.log');
  });
});

describe('sourcetype — an input-time assignment decides what else matches', () => {
  it('resolves stanzas against the assigned sourcetype', () => {
    const { result } = run(
      '[source::/var/log/app.log]\nsourcetype = assigned\n\n[assigned]\nEVAL-tag = "from assigned"\n',
    );
    expect(result.events[0]!.fields['tag']).toBe('from assigned');
  });

  it('stops the original sourcetype stanza applying', () => {
    const { result } = run(
      '[source::/var/log/app.log]\nsourcetype = assigned\n\n' +
        '[original]\nEVAL-tag = "from original"\n\n[assigned]\nEVAL-other = 1\n',
    );
    expect(result.events[0]!.fields['tag']).toBeUndefined();
  });

  it('carries the assignment onto the event metadata', () => {
    const { result } = run('[source::/var/log/app.log]\nsourcetype = assigned\n');
    expect(result.events[0]!.metadata.sourcetype).toBe('assigned');
  });

  it('reports the assignment rather than performing it silently', () => {
    const { diagnostics } = run('[source::/var/log/app.log]\nsourcetype = assigned\n');
    const d = diagnostics.find((x) => x.directiveKey === 'sourcetype');
    expect(d?.message).toContain('original');
    expect(d?.message).toContain('assigned');
  });

  it('ignores the key on a sourcetype stanza, where Splunk uses rename instead', () => {
    const { result } = run('[original]\nsourcetype = elsewhere\n\n[elsewhere]\nEVAL-tag = "wrong"\n');
    expect(result.events[0]!.fields['tag']).toBeUndefined();
  });

  it('does nothing when the assignment names the sourcetype already in force', () => {
    const { diagnostics } = run('[source::/var/log/app.log]\nsourcetype = original\n');
    expect(diagnostics.filter((d) => d.directiveKey === 'sourcetype')).toEqual([]);
  });
});

describe('rename — a search-time-only sourcetype change', () => {
  it('takes search-time settings from the target stanza', () => {
    const { result } = run(
      '[original]\nrename = renamed\n\n[renamed]\nEVAL-tag = "from renamed"\n',
    );
    expect(result.events[0]!.fields['tag']).toBe('from renamed');
  });

  it('drops the ORIGINAL stanza search-time settings, which Splunk does not merge', () => {
    // The surprising half, and the reason this is worth simulating: an EXTRACT
    // on the original sourcetype stops applying entirely after a rename.
    const { result } = run(
      '[original]\nrename = renamed\nEXTRACT-u = user=(?<uname>\\w+)\n\n' +
        '[renamed]\nKV_MODE = none\nEVAL-tag = 1\n',
    );
    // `uname` can only come from that EXTRACT — auto-KV would produce `user`.
    expect(result.events[0]!.fields['uname']).toBeUndefined();
  });

  it('keeps index-time processing on the original stanza', () => {
    // TRUNCATE is index-time, so the rename must not move it to the target.
    const { result } = run(
      '[original]\nrename = renamed\nSHOULD_LINEMERGE = false\nTRUNCATE = 12\n\n[renamed]\nEVAL-tag = 1\n',
    );
    expect(result.events[0]!._raw).toBe('2026-01-15T1');
  });

  it('leaves the event indexed as its original sourcetype', () => {
    const { result } = run('[original]\nrename = renamed\n\n[renamed]\nEVAL-tag = 1\n');
    expect(result.events[0]!.metadata.sourcetype).toBe('original');
  });

  it('explains the change, including what stops applying', () => {
    const { diagnostics } = run('[original]\nrename = renamed\n\n[renamed]\nEVAL-tag = 1\n');
    const d = diagnostics.find((x) => x.directiveKey === 'rename');
    expect(d?.message).toContain('renamed');
    expect(d?.message).toContain('no longer apply');
  });

  it('composes with an input-time sourcetype assignment', () => {
    // source:: assigns `assigned`; that stanza then renames to `renamed` for
    // search time only.
    const { result } = run(
      '[source::/var/log/app.log]\nsourcetype = assigned\n\n' +
        '[assigned]\nrename = renamed\n\n[renamed]\nEVAL-tag = "final"\n',
    );
    expect(result.events[0]!.fields['tag']).toBe('final');
    expect(result.events[0]!.metadata.sourcetype).toBe('assigned');
  });
});
