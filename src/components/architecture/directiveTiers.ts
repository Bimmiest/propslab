// ---------------------------------------------------------------------------
// directiveTiers.ts
// Where each props.conf directive runs in a Splunk deployment, for the
// Architecture tab (#901).
//
// Each rule cites what the repository already says. The registry gives each
// directive a phase, and its text and support notes name the forwarder and
// input-layer directives (docs/fidelity.md lists the same layers). Where the
// repository says nothing, the answer is "not known", not a guess.
// ---------------------------------------------------------------------------

import { parseConf, getDirectiveInfo } from '../../engine';

/**
 * A box of the Architecture tab. `heavy-forwarder` is the parsing tier: the
 * first full Splunk instance on the path of the data, which is the indexer
 * when no heavy forwarder is on that path.
 */
export type TierId = 'universal-forwarder' | 'heavy-forwarder' | 'indexer' | 'search-head';

export const TIER_ORDER: readonly TierId[] = ['universal-forwarder', 'heavy-forwarder', 'indexer', 'search-head'];

export type TierAnswer = { known: true; tiers: readonly TierId[] } | { known: false; reason: string };

const known = (...tiers: TierId[]): TierAnswer => ({ known: true, tiers });
const unknown = (reason: string): TierAnswer => ({ known: false, reason });

/**
 * Directives whose registry description says that they apply on a universal
 * forwarder: EVENT_BREAKER and EVENT_BREAKER_ENABLE ("on a universal
 * forwarder", "on the forwarder"), and force_local_processing ("applies only
 * there").
 */
const FORWARDER_DIRECTIVES = new Set(['EVENT_BREAKER', 'EVENT_BREAKER_ENABLE', 'force_local_processing']);

/**
 * Directives whose support note in directiveSupport.ts puts them in the input
 * layer: they apply where the data is read in, which is the universal
 * forwarder's job in this diagram. CHARSET, NO_BINARY_CHECK and
 * LEARN_SOURCETYPE are also in the "forwarder and input layers" of
 * docs/fidelity.md. The sourcetype-model settings go with LEARN_SOURCETYPE,
 * whose note says that sourcetype learning happens at input, and `sourcetype`
 * is assigned at input (stanzaMatcher.ts, resolveStanzasForEvent).
 */
const INPUT_LAYER_DIRECTIVES = new Set([
  'CHARSET',
  'NO_BINARY_CHECK',
  'LEARN_SOURCETYPE',
  'LEARN_MODEL',
  'maxDist',
  'termFrequencyWeightedDist',
  'CHECK_METHOD',
  'initCrcLength',
  'detect_trailing_nulls',
  'HEADER_MODE',
  'PREFIX_SOURCETYPE',
  'invalid_cause',
  'is_valid',
  'unarchive_cmd',
  'unarchive_cmd_start_mode',
  'unarchive_sourcetype',
  'SOURCETYPE_NAME_RESTRICTED_CHARACTERS',
  'sourcetype',
]);

/** Their support notes say "forwarder", but not which of the two forwarders. */
const SOME_FORWARDER_DIRECTIVES = new Set(['LB_CHUNK_BREAKER', 'LB_CHUNK_BREAKER_TRUNCATE']);

/** The INDEXED_EXTRACTIONS values that XML_INDEXED_EXTRACTIONS_PIPELINE governs. */
const XML_FORMATS = new Set(['xml', 'xmlkv', 'xmlkv-winevt']);

/**
 * The registry text of XML_INDEXED_EXTRACTIONS_PIPELINE: "typing runs on
 * indexers and heavy forwarders; structuredparsing, exec and wineventlog exist
 * so universal forwarders can extract instead".
 */
function xmlPipelineTier(pipeline: string | undefined): TierAnswer | undefined {
  const value = pipeline?.trim().toLowerCase();
  if (value === 'typing') return known('heavy-forwarder');
  if (value === 'structuredparsing' || value === 'exec' || value === 'wineventlog') return known('universal-forwarder');
  return undefined;
}

/** Context from the directive's stanza that some answers depend on. */
export interface StanzaContext {
  /** The value of XML_INDEXED_EXTRACTIONS_PIPELINE in the same stanza, if it is set. */
  xmlPipeline?: string;
}

/**
 * The tiers on which a props.conf directive runs, or why the repository cannot
 * say. Pure: it reads only the registry.
 */
export function directiveTier(key: string, value: string, stanza: StanzaContext = {}): TierAnswer {
  const info = getDirectiveInfo(key, 'props.conf');
  if (!info) return unknown('Not in the directive registry, so its phase is not known.');
  const base = info.key;

  if (FORWARDER_DIRECTIVES.has(base) || INPUT_LAYER_DIRECTIVES.has(base)) return known('universal-forwarder');
  if (SOME_FORWARDER_DIRECTIVES.has(base)) {
    return unknown('A forwarder setting. The registry does not say which forwarder reads it.');
  }

  if (base === 'XML_INDEXED_EXTRACTIONS_PIPELINE') {
    return xmlPipelineTier(value) ?? unknown('The value is not a pipeline that the registry places on a tier.');
  }
  const isXml =
    (base === 'INDEXED_EXTRACTIONS' && XML_FORMATS.has(value.trim().toLowerCase())) ||
    base.startsWith('XML_IE_') ||
    base === 'extraction_cutoff';
  if (isXml) {
    return (
      xmlPipelineTier(stanza.xmlPipeline) ??
      unknown('XML extraction runs where XML_INDEXED_EXTRACTIONS_PIPELINE says, and this stanza does not set it.')
    );
  }
  if (base === 'INDEXED_EXTRACTIONS' || info.category === 'Structured Data') {
    return unknown('Structured data. The registry names the tier of this extraction only for the XML formats.');
  }

  // Its support note: "how the indexer segments terms for search".
  if (base === 'SEGMENTATION') return known('indexer');
  // The registry: "a ruleset runs on both heavy forwarder and indexer". Its
  // description goes where the ruleset goes.
  if (base === 'RULESET' || base === 'RULESET_DESC') return known('heavy-forwarder', 'indexer');

  switch (info.phase) {
    case 'index-time':
      return known('heavy-forwarder');
    case 'search-time':
      return known('search-head');
    case 'both':
      return known('heavy-forwarder', 'search-head');
  }
}

export interface PlacedDirective {
  key: string;
  value: string;
  /** Its line in props.conf, for the jump to the editor. */
  line: number;
}

export interface UnplacedDirective extends PlacedDirective {
  reason: string;
}

export interface StanzaGroup<T> {
  stanza: string;
  directives: T[];
}

export interface DirectiveTiers {
  /** For each tier, the directives that run there, by stanza, in file order. */
  byTier: Record<TierId, StanzaGroup<PlacedDirective>[]>;
  /** The directives whose tier the repository cannot name, by stanza. */
  unknown: StanzaGroup<UnplacedDirective>[];
}

/** Every directive of a props.conf, sorted into the tiers where it runs. */
export function directiveTiers(propsConf: string): DirectiveTiers {
  const byTier: DirectiveTiers['byTier'] = {
    'universal-forwarder': [],
    'heavy-forwarder': [],
    indexer: [],
    'search-head': [],
  };
  const unplaced: DirectiveTiers['unknown'] = [];

  for (const stanza of parseConf(propsConf, 'props.conf').stanzas) {
    const context: StanzaContext = {
      xmlPipeline: stanza.directives.find((d) => d.key === 'XML_INDEXED_EXTRACTIONS_PIPELINE')?.value,
    };
    const placed = new Map<TierId, PlacedDirective[]>();
    const notPlaced: UnplacedDirective[] = [];

    for (const { key, value, line } of stanza.directives) {
      const answer = directiveTier(key, value, context);
      if (!answer.known) {
        notPlaced.push({ key, value, line, reason: answer.reason });
        continue;
      }
      for (const tier of answer.tiers) {
        const list = placed.get(tier) ?? [];
        list.push({ key, value, line });
        placed.set(tier, list);
      }
    }

    for (const [tier, directives] of placed) byTier[tier].push({ stanza: stanza.name, directives });
    if (notPlaced.length > 0) unplaced.push({ stanza: stanza.name, directives: notPlaced });
  }

  return { byTier, unknown: unplaced };
}

/** How many directives a tier lists. */
export function countDirectives(groups: readonly StanzaGroup<unknown>[]): number {
  return groups.reduce((n, g) => n + g.directives.length, 0);
}
