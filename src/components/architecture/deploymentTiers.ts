// ---------------------------------------------------------------------------
// deploymentTiers.ts
// Which Splunk tiers a configuration involves, for the Architecture tab.
// ---------------------------------------------------------------------------

import { parseConf } from '../../engine/parser/confParser';
import { getDirectiveInfo } from '../../engine/directiveRegistry';
import { getStagesForDirective } from '../../engine/pipelineStages';

/**
 * The stage that applies transforms.conf rules at index time, which is where
 * events are routed. Its directives, like each directive's phase, come from
 * the engine's own tables rather than a copy kept here.
 */
const ROUTING_DIRECTIVES = new Set(getStagesForDirective('TRANSFORMS').flatMap((stage) => stage.directives));

export interface DeploymentTiers {
  /** props.conf sets an index-time directive: parsing on a heavy forwarder or indexer. */
  hasIndexTime: boolean;
  /** props.conf sets a search-time directive: extraction on the search head. */
  hasSearchTime: boolean;
  /** Events can be routed: an index-time transform, or a transforms.conf rule writing a queue or metadata. */
  hasRouting: boolean;
}

/** Which Splunk tiers a configuration involves, with each directive's phase read from the registry. */
export function deploymentTiers(propsConf: string, transformsConf: string): DeploymentTiers {
  let hasIndexTime = false;
  let hasSearchTime = false;
  let hasRouting = false;

  for (const stanza of parseConf(propsConf, 'props.conf').stanzas) {
    for (const dir of stanza.directives) {
      const phase = getDirectiveInfo(dir.key, 'props.conf')?.phase;
      if (phase === 'index-time') hasIndexTime = true;
      if (phase === 'search-time') hasSearchTime = true;
      if (ROUTING_DIRECTIVES.has(dir.directiveType)) hasRouting = true;
    }
  }

  // Routing by transforms.conf itself: a rule that writes the queue (DEST_KEY = queue) or metadata.
  for (const stanza of parseConf(transformsConf, 'transforms.conf').stanzas) {
    const destKey = stanza.directives.find((d) => d.key === 'DEST_KEY');
    if (destKey?.value.trim() === 'queue' || destKey?.value.includes('MetaData:')) hasRouting = true;
  }

  return { hasIndexTime, hasSearchTime, hasRouting };
}
