// ---------------------------------------------------------------------------
// fieldDirective.ts
// The props.conf directive that made a field, for a field menu's "Jump to
// config" (#745), and the FIELDALIAS line its "Create FIELDALIAS…" writes;
// and the directive and transforms.conf stanza a Pipeline step ran (#760).
// ---------------------------------------------------------------------------

import { parseConf } from '../../../../engine/parser/confParser';
import { resolveStanzasForEvent } from '../../../../engine/parser/stanzaMatcher';
import { resolveEffectiveConfig } from '../../../../engine/parser/effectiveConfig';
import { fieldNameNeedsQuoting, unquoteFieldName } from '../../../../engine/utils/fieldRef';
import { getDirectiveInfo } from '../../../../engine/directiveRegistry';
import type { EventMetadata } from '../../../../engine/types';
import type { ViewEvent } from '../../../../utils/viewResult';
import { useAppStore } from '../../../../store/useAppStore';

/** The processors of the steps that added `field`, read from the first event that has it. */
export function processorsOf(field: string, events: readonly ViewEvent[]): string[] {
  const event = events.find((e) => Object.hasOwn(e.fields, field));
  if (!event) return [];
  return event.processingTrace.filter((s) => s.fieldsAdded?.includes(field)).map((s) => s.processor);
}

const ALIAS_TARGET = /\bAS(?:NEW)?\s+('[^']*'|"[^"]*"|\S+)/gi;

/**
 * The key a step is named for, without its detail: `KV_MODE(json)`,
 * `INDEXED_EXTRACTIONS(csv)` and `REPORT-x:stanza` name KV_MODE,
 * INDEXED_EXTRACTIONS and REPORT-x.
 */
const stepBase = (processor: string) => processor.replace(/\(.*\)$/, '').split(':')[0] ?? '';

/** Whether `key = value` is a directive that can have made `field` in a step named `processor`. */
function made(processor: string, field: string, key: string, value: string): boolean {
  // EVAL and FIELDALIAS steps cover every directive of their kind, so the
  // field picks the directive.
  const base = stepBase(processor).toUpperCase();
  const k = key.toUpperCase();
  if (base === 'EVAL') return k === `EVAL-${field.toUpperCase()}`;
  if (base === 'FIELDALIAS') {
    return (
      k.startsWith('FIELDALIAS-') &&
      [...value.matchAll(ALIAS_TARGET)].some((m) => unquoteFieldName(m[1] ?? '') === field)
    );
  }
  return k === base;
}

/**
 * The line of the directive in effect that made `field`, or null when none
 * did: a default (KV_MODE = auto with no line of its own), the metadata, or a
 * processor props.conf does not name. `metadata` is tried in order.
 */
export function fieldDirectiveLine(
  field: string,
  processors: readonly string[],
  propsConf: string,
  metadata: readonly EventMetadata[],
): number | null {
  if (processors.length === 0) return null;
  const { stanzas } = parseConf(propsConf, 'props.conf');
  for (const meta of metadata) {
    const effective = resolveEffectiveConfig(resolveStanzasForEvent(stanzas, meta).stanzas);
    for (const processor of processors) {
      const hit = effective.find((d) => made(processor, field, d.key, d.value));
      if (hit) return hit.line;
    }
  }
  return null;
}

/**
 * `fieldDirectiveLine` against the editor's props.conf, whose lines the jump
 * lands on, and the run's metadata. Read when a menu opens rather than
 * subscribed: each row has a menu, and subscribed to props.conf every row
 * would render again on each keystroke.
 */
export function currentFieldDirectiveLine(field: string, sources?: Iterable<string>): number | null {
  const { propsConf, metadata, processingResult } = useAppStore.getState();
  const processors = sources ? [...sources] : processorsOf(field, processingResult?.events ?? []);
  const input = processingResult?.inputMetadata ?? metadata;
  const renamed = processingResult?.renamedSourcetype;
  // Search-time directives come from the rename target's stanza (ADR 0002).
  const metas = renamed ? [{ ...input, sourcetype: renamed }, input] : [input];
  return fieldDirectiveLine(field, processors, propsConf, metas);
}

/** A field name as a directive references it: quoted when it has a character outside [A-Za-z0-9_]. */
export const fieldRef = (name: string) => (fieldNameNeedsQuoting(name) ? `'${name}'` : name);

/** The FIELDALIAS directive that gives `source` the name `alias`. */
export function fieldAliasDirective(source: string, alias: string): { key: string; value: string } {
  return {
    key: `FIELDALIAS-${alias.replace(/[^A-Za-z0-9_-]/g, '_')}`,
    value: `${fieldRef(source)} AS ${fieldRef(alias)}`,
  };
}

/** Steps the engine names after their stage rather than a key, with the keys that drive the stage. */
const STAGE_KEYS: Record<string, string[]> = {
  lineBreaker: ['LINE_BREAKER', 'SHOULD_LINEMERGE'],
  timestampExtractor: ['TIME_PREFIX', 'TIME_FORMAT', 'MAX_TIMESTAMP_LOOKAHEAD', 'DATETIME_CONFIG'],
  truncator: ['TRUNCATE'],
};

/** Whether `key` is a directive a step named `processor` runs: EVAL and FIELDALIAS steps run every one of their kind. */
function ranBy(processor: string, key: string): boolean {
  const base = stepBase(processor);
  const k = key.toUpperCase();
  const keys = STAGE_KEYS[base] ?? [base];
  if (base === 'EVAL' || base === 'FIELDALIAS') return k.startsWith(`${base}-`);
  return keys.some((x) => x.toUpperCase() === k);
}

/** The line of the first directive in effect that a step ran, or null when props.conf has none. */
export function stepDirectiveLine(
  processor: string,
  propsConf: string,
  metadata: readonly EventMetadata[],
): number | null {
  const { stanzas } = parseConf(propsConf, 'props.conf');
  for (const meta of metadata) {
    const hit = resolveEffectiveConfig(resolveStanzasForEvent(stanzas, meta).stanzas).find((d) =>
      ranBy(processor, d.key),
    );
    if (hit) return hit.line;
  }
  return null;
}

/** The header line of the transforms.conf stanza a `TRANSFORMS-x:stanza` or `REPORT-x:stanza` step ran, or null. */
export function stepTransformsLine(processor: string, transformsConf: string): number | null {
  const stanza = processor.split(':')[1];
  if (!stanza) return null;
  return parseConf(transformsConf, 'transforms.conf').stanzas.find((s) => s.name === stanza)?.lineRange.start ?? null;
}

/** The directive a step ran, as the dictionary names it, or undefined for a step it has no entry for. */
export function stepDictionaryKey(processor: string): string | undefined {
  const base = stepBase(processor);
  return getDirectiveInfo(STAGE_KEYS[base]?.[0] ?? base, 'props.conf')?.key;
}

/** `stepDirectiveLine` against the editor's props.conf and the run's metadata, as `currentFieldDirectiveLine`. */
export function currentStepDirectiveLine(processor: string): number | null {
  const { propsConf, metadata, processingResult } = useAppStore.getState();
  const input = processingResult?.inputMetadata ?? metadata;
  const renamed = processingResult?.renamedSourcetype;
  const metas = renamed ? [{ ...input, sourcetype: renamed }, input] : [input];
  return stepDirectiveLine(processor, propsConf, metas);
}
