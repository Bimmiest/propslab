import type { ParsedConf, SplunkEvent, ValidationDiagnostic } from '../types';
import { matchStanzas, mergeDirectives } from '../parser/stanzaMatcher';
import { applySedCommands } from './sedCmd';
import { applyTransforms } from './transformsProcessor';

/**
 * How many clone generations are followed before giving up. A cycle is caught
 * by the lineage check below; this only bounds a long acyclic chain, which no
 * real config has, so the exact number does not matter.
 */
const MAX_CLONE_DEPTH = 8;

/**
 * Give CLONE_SOURCETYPE copies the index-time processing of their new
 * sourcetype (#282).
 *
 * transforms.conf.spec: "The duplicated events receive index-time
 * transformations and sed commands for all transforms that match its new
 * host, source, or source type." Without this the clone showed up under the
 * new sourcetype but carried the original's `_raw` untouched — so the
 * canonical use, cloning to a masked sourcetype whose SEDCMD redacts the copy,
 * previewed as an unmasked duplicate.
 *
 * Only SEDCMD and TRANSFORMS are replayed, because that is all the spec
 * promises: the clone is taken after line breaking and timestamping, which do
 * not run again. Stanzas are matched with `matchStanzas` rather than the
 * input-time resolution, since an input-time `sourcetype =` assignment would
 * overwrite the very sourcetype the clone was given. Host and source stanzas
 * still match — the spec warns that they "will incorrectly be applied", which
 * is Splunk's behaviour to reproduce, not to fix.
 *
 * Runs after the TRANSFORMS stage over its output: every event carrying
 * `clonedFrom` at that point is a fresh clone that has not been processed yet.
 */
export function applyCloneIndexTime(
  events: SplunkEvent[],
  propsConf: ParsedConf,
  transformsConf: ParsedConf,
  diagnostics: ValidationDiagnostic[],
): SplunkEvent[] {
  if (!events.some((e) => e.clonedFrom !== undefined)) return events;

  // Warn once per sourcetype pair, not once per event.
  const warnedCycle = new Set<string>();

  const processClone = (clone: SplunkEvent, lineage: Set<string>): SplunkEvent[] => {
    const sourcetype = clone.metadata.sourcetype;
    // A clone whose sourcetype is already in its own ancestry would clone
    // itself again for ever (A clones to B, B clones back to A). Stop and say
    // so rather than hang; the copy is kept, since Splunk did emit it.
    if (lineage.has(sourcetype) || lineage.size >= MAX_CLONE_DEPTH) {
      const key = `${clone.clonedFrom ?? ''}→${sourcetype}`;
      if (!warnedCycle.has(key)) {
        warnedCycle.add(key);
        diagnostics.push({
          level: 'warning',
          message:
            `CLONE_SOURCETYPE loops back to sourcetype "${sourcetype}" (clone chain: ` +
            `${[...lineage, sourcetype].join(' → ')}). In Splunk this clones without end; ` +
            'the preview stops here and does not re-process this copy.',
          file: 'transforms.conf',
        });
      }
      return [clone];
    }

    const directives = mergeDirectives(matchStanzas(propsConf.stanzas, clone.metadata));
    let out = applySedCommands([clone], directives, diagnostics);
    out = applyTransforms(out, directives, transformsConf, 'index-time', diagnostics);

    // applyTransforms returns the clone first and any clones IT emitted after.
    const [processed, ...grandchildren] = out;
    const nextLineage = new Set(lineage).add(sourcetype);
    return [
      ...(processed ? [processed] : []),
      ...grandchildren.flatMap((g) => processClone(g, nextLineage)),
    ];
  };

  return events.flatMap((event) =>
    event.clonedFrom === undefined ? [event] : processClone(event, new Set([event.clonedFrom])),
  );
}
