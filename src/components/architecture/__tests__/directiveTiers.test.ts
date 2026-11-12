import { describe, expect, it } from 'vitest';
import { countDirectives, directiveTier, directiveTiers, type TierAnswer } from '../directiveTiers';

/** Why the tier is not known, or undefined when it is. */
const reasonOf = (answer: TierAnswer) => (answer.known ? undefined : answer.reason);

describe('directiveTier', () => {
  it("places a directive by the registry's phase", () => {
    // Index-time: the first full instance, the heavy forwarder or else the indexer.
    expect(directiveTier('TIME_FORMAT', '%s')).toEqual({ known: true, tiers: ['heavy-forwarder'] });
    expect(directiveTier('TRANSFORMS-route', 'r')).toEqual({ known: true, tiers: ['heavy-forwarder'] });
    expect(directiveTier('SEDCMD-mask', 's/a/b/')).toEqual({ known: true, tiers: ['heavy-forwarder'] });
    // Search-time: the search head, class-based keys by their base.
    expect(directiveTier('EXTRACT-a', '(?<a>x)')).toEqual({ known: true, tiers: ['search-head'] });
    expect(directiveTier('KV_MODE', 'json')).toEqual({ known: true, tiers: ['search-head'] });
    // Both phases: each tier that runs a phase.
    expect(directiveTier('MATCH_LIMIT', '10')).toEqual({ known: true, tiers: ['heavy-forwarder', 'search-head'] });
  });

  it('puts the forwarder directives that the registry names on the universal forwarder', () => {
    for (const key of ['EVENT_BREAKER', 'EVENT_BREAKER_ENABLE', 'force_local_processing']) {
      expect(directiveTier(key, 'x')).toEqual({ known: true, tiers: ['universal-forwarder'] });
    }
  });

  it('puts the input-layer directives on the universal forwarder, which reads the data in', () => {
    for (const key of ['CHARSET', 'NO_BINARY_CHECK', 'LEARN_SOURCETYPE', 'CHECK_METHOD', 'sourcetype', 'maxDist']) {
      expect(directiveTier(key, 'x')).toEqual({ known: true, tiers: ['universal-forwarder'] });
    }
  });

  it('puts SEGMENTATION on the indexer, and a ruleset on both the heavy forwarder and the indexer', () => {
    expect(directiveTier('SEGMENTATION', 'inner')).toEqual({ known: true, tiers: ['indexer'] });
    expect(directiveTier('RULESET-drop', 'drop')).toEqual({ known: true, tiers: ['heavy-forwarder', 'indexer'] });
    expect(directiveTier('RULESET_DESC-drop', 'why')).toEqual({ known: true, tiers: ['heavy-forwarder', 'indexer'] });
  });

  it('places XML extraction by XML_INDEXED_EXTRACTIONS_PIPELINE', () => {
    expect(directiveTier('XML_INDEXED_EXTRACTIONS_PIPELINE', 'typing')).toEqual({
      known: true,
      tiers: ['heavy-forwarder'],
    });
    for (const pipeline of ['structuredparsing', 'exec', ' WinEventLog ']) {
      expect(directiveTier('XML_INDEXED_EXTRACTIONS_PIPELINE', pipeline)).toEqual({
        known: true,
        tiers: ['universal-forwarder'],
      });
    }
    expect(directiveTier('XML_INDEXED_EXTRACTIONS_PIPELINE', 'bogus').known).toBe(false);

    // The extraction and its options follow the stanza's pipeline.
    const uf = { xmlPipeline: 'structuredparsing' };
    expect(directiveTier('INDEXED_EXTRACTIONS', 'xmlkv', uf)).toEqual({ known: true, tiers: ['universal-forwarder'] });
    expect(directiveTier('XML_IE_INCLUDE', 'a', uf)).toEqual({ known: true, tiers: ['universal-forwarder'] });
    expect(directiveTier('extraction_cutoff', '100', { xmlPipeline: 'typing' })).toEqual({
      known: true,
      tiers: ['heavy-forwarder'],
    });
    expect(reasonOf(directiveTier('INDEXED_EXTRACTIONS', 'xml'))).toContain('does not set it');
  });

  it('does not guess where the other structured data formats are parsed', () => {
    const json = directiveTier('INDEXED_EXTRACTIONS', 'json', { xmlPipeline: 'typing' });
    expect(reasonOf(json)).toContain('only for the XML formats');
    expect(directiveTier('FIELD_DELIMITER', ',').known).toBe(false);
    expect(directiveTier('TIMESTAMP_FIELDS', 'ts').known).toBe(false);
  });

  it('does not guess which forwarder reads a forwarder setting, or the tier of an unknown key', () => {
    expect(reasonOf(directiveTier('LB_CHUNK_BREAKER', 'x'))).toContain('which forwarder');
    expect(reasonOf(directiveTier('NOT_A_DIRECTIVE', '1'))).toContain('Not in the directive registry');
    // Keys are case-sensitive in Splunk, so a mis-cased key is not the directive.
    expect(directiveTier('time_format', '%s').known).toBe(false);
  });
});

describe('directiveTiers', () => {
  it('groups the directives of each tier by stanza, in file order, with their lines', () => {
    const conf = [
      '[web]', // 1
      'TIME_FORMAT = %s', // 2
      'EXTRACT-a = (?<a>x)', // 3
      'CHARSET = UTF-8', // 4
      '[db]', // 5
      'SHOULD_LINEMERGE = false', // 6
      'NOT_A_DIRECTIVE = 1', // 7
    ].join('\n');
    const tiers = directiveTiers(conf);
    expect(tiers.byTier['heavy-forwarder']).toEqual([
      { stanza: 'web', directives: [{ key: 'TIME_FORMAT', value: '%s', line: 2 }] },
      { stanza: 'db', directives: [{ key: 'SHOULD_LINEMERGE', value: 'false', line: 6 }] },
    ]);
    expect(tiers.byTier['search-head']).toEqual([
      { stanza: 'web', directives: [{ key: 'EXTRACT-a', value: '(?<a>x)', line: 3 }] },
    ]);
    expect(tiers.byTier['universal-forwarder']).toEqual([
      { stanza: 'web', directives: [{ key: 'CHARSET', value: 'UTF-8', line: 4 }] },
    ]);
    expect(tiers.byTier.indexer).toEqual([]);
    expect(tiers.unknown).toEqual([
      {
        stanza: 'db',
        directives: [
          { key: 'NOT_A_DIRECTIVE', value: '1', line: 7, reason: reasonOf(directiveTier('NOT_A_DIRECTIVE', '1')) },
        ],
      },
    ]);
    expect(countDirectives(tiers.byTier['heavy-forwarder'])).toBe(2);
  });

  it('lists a directive under each tier that runs it', () => {
    const tiers = directiveTiers('[st]\nRULESET-r = drop\n');
    expect(tiers.byTier['heavy-forwarder'][0]?.directives[0]?.key).toBe('RULESET-r');
    expect(tiers.byTier.indexer[0]?.directives[0]?.key).toBe('RULESET-r');
  });

  it('reads the XML pipeline from the same stanza, wherever it is in the stanza', () => {
    const tiers = directiveTiers(
      '[xml]\nINDEXED_EXTRACTIONS = xml\nXML_INDEXED_EXTRACTIONS_PIPELINE = structuredparsing\n[other]\nINDEXED_EXTRACTIONS = xml\n',
    );
    expect(tiers.byTier['universal-forwarder']).toEqual([
      {
        stanza: 'xml',
        directives: [
          { key: 'INDEXED_EXTRACTIONS', value: 'xml', line: 2 },
          { key: 'XML_INDEXED_EXTRACTIONS_PIPELINE', value: 'structuredparsing', line: 3 },
        ],
      },
    ]);
    expect(tiers.unknown.map((g) => g.stanza)).toEqual(['other']);
  });

  it('is empty for an empty props.conf', () => {
    const tiers = directiveTiers('');
    expect(Object.values(tiers.byTier).every((groups) => groups.length === 0)).toBe(true);
    expect(tiers.unknown).toEqual([]);
  });
});
